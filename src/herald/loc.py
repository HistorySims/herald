"""Chronicling America client (loc.gov API).

Starting in 2025 the Chronicling America collection is served via the
loc.gov JSON API. The old ``chroniclingamerica.loc.gov/lccn/{lccn}.json``
endpoint now redirects to a malformed ``www.loc.gov`` URL and 403s, so
this client targets the new endpoints directly:

* Enumerate pages in a date window
      ``https://www.loc.gov/collections/chronicling-america/
        ?fa=number_lccn:{lccn}&dl=page
        &start_date=YYYY-MM-DD&end_date=YYYY-MM-DD
        &fo=json&c=200&sp={page}``

* Per-page detail incl. OCR ``full_text``
      ``{result.id}?fo=json``

The search results carry enough metadata for ``papers`` / ``issues`` /
``pages`` rows; only the OCR text requires the per-page resource fetch.

Rate-limit note: the Newspapers endpoint allows ~20 requests per 10s.
We add a small ``min_request_interval`` to stay safely under that.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import date

import httpx

BASE = "https://www.loc.gov"
LEGACY_BASE = "https://chroniclingamerica.loc.gov"
COLLECTION_PATH = "/collections/chronicling-america/"
# LOC's dl=page responses inline full_text per result; at c=200 the bodies
# routinely exceed 4 MB and the server closes the connection mid-stream
# (RemoteProtocolError: received 57075/4223823). 25 keeps each response
# under a few hundred KB and stays well within the 20-per-10s rate limit.
DEFAULT_PER_PAGE = 25
DEFAULT_MIN_INTERVAL_SECS = 0.6  # ≈ 1.6 req/sec, well under 2 req/sec sustained
DEFAULT_MAX_RETRIES = 5
DEFAULT_RETRY_BASE_DELAY = 1.0


@dataclass(frozen=True)
class PaperMetadata:
    lccn: str
    title: str
    place: str | None
    start_year: int | None
    end_year: int | None


@dataclass(frozen=True)
class IssueRef:
    lccn: str
    date_issued: date
    edition: int
    url: str  # canonical page-resource URL prefix on www.loc.gov


@dataclass(frozen=True)
class PageRef:
    lccn: str
    date_issued: date
    edition: int
    sequence: int
    image_url: str         # JPEG-derivative for the UI
    jp2_url: str | None    # high-res master, when LOC publishes one
    pdf_url: str | None
    resource_url: str      # loc.gov page resource URL (no .json suffix)
    ocr_url: str           # legacy chroniclingamerica.loc.gov ocr.txt URL


class LOCClient:
    """Async client for the loc.gov Chronicling America endpoints."""

    def __init__(
        self,
        *,
        user_agent: str,
        client: httpx.AsyncClient | None = None,
        base_url: str = BASE,
        legacy_base_url: str = LEGACY_BASE,
        per_page: int = DEFAULT_PER_PAGE,
        min_request_interval: float = DEFAULT_MIN_INTERVAL_SECS,
        max_retries: int = DEFAULT_MAX_RETRIES,
        retry_base_delay: float = DEFAULT_RETRY_BASE_DELAY,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._legacy = legacy_base_url.rstrip("/")
        self._per_page = per_page
        self._min_interval = min_request_interval
        self._max_retries = max_retries
        self._retry_base_delay = retry_base_delay
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            timeout=httpx.Timeout(60.0, connect=15.0),
            follow_redirects=True,
        )
        self._last_request_ts = 0.0

    async def __aenter__(self) -> LOCClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    # ---- public API used by the orchestrator -------------------------

    async def get_paper_metadata(self, lccn: str) -> PaperMetadata:
        """Derive paper metadata from the first search hit for the LCCN.

        Avoids relying on a dedicated paper-level item endpoint, which
        the loc.gov migration is still shaking out. The fields we need
        (``partof_title``, ``location_*``) are present on every page hit.
        """
        params = self._search_params(
            lccn=lccn, date_from=None, date_to=None, page=1, per_page=1,
        )
        data = await self._get_json(COLLECTION_PATH, params=params)
        results = data.get("results", []) or []
        if not results:
            return PaperMetadata(lccn=lccn, title=lccn, place=None,
                                 start_year=None, end_year=None)
        r = results[0]
        title = _first(_as_list(r.get("partof_title"))) or lccn
        title = re.sub(r"\s*\[.*?\]\s*$", "", title).strip().rstrip(".") or lccn
        place = _format_place(r)
        return PaperMetadata(
            lccn=lccn, title=title, place=place,
            start_year=_to_int(r.get("dates")[0] if r.get("dates") else None),
            end_year=None,
        )

    async def iter_issues(
        self,
        lccn: str,
        *,
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> AsyncIterator[IssueRef]:
        """Yield issues for the LCCN, grouping search pages by (date, edition).

        Kept for backwards compatibility; ``iter_issues_with_pages`` is
        preferred — it avoids re-searching when the caller wants pages too.
        """
        async for issue, _pages in self._iter_issues_with_pages(
            lccn, date_from=date_from, date_to=date_to,
        ):
            yield issue

    async def iter_issues_with_pages(
        self,
        lccn: str,
        *,
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> AsyncIterator[tuple[IssueRef, list[PageRef]]]:
        """Yield ``(issue, pages)`` pairs grouped from the page-level search.

        This is the efficient path: one paginated search call enumerates
        every page in the window, and we group consecutive results by
        ``(date, edition)`` so the orchestrator can act on each issue
        atomically.
        """
        async for pair in self._iter_issues_with_pages(
            lccn, date_from=date_from, date_to=date_to,
        ):
            yield pair

    async def list_pages(self, issue: IssueRef) -> list[PageRef]:
        """Return pages for ``issue`` as previously enumerated.

        With the new API the pages were already fetched alongside the
        issue, so the orchestrator can call this without a roundtrip.
        For testability we honour the original signature: when called
        bare we re-fetch by date window (single-issue scope).
        """
        pages_by_issue = await self._pages_for_single_issue(issue)
        return pages_by_issue

    async def fetch_ocr(self, page: PageRef) -> str:
        """Fetch raw OCR text for a page.

        Tries the legacy ``chroniclingamerica.loc.gov`` OCR endpoint
        first (still served and avoids the per-page JSON fetch); on 404
        falls back to the loc.gov resource endpoint and reads
        ``full_text``. Returns an empty string when no OCR exists.
        """
        # Legacy fast path: plain text, no JSON parsing.
        resp = await self._get(page.ocr_url)
        if resp.status_code == 200:
            return resp.text
        if resp.status_code != 404:
            resp.raise_for_status()

        # Modern fallback: resource endpoint with full_text in JSON.
        url = page.resource_url.rstrip("/") + "/?fo=json"
        resp = await self._get(url)
        if resp.status_code == 404:
            return ""
        resp.raise_for_status()
        data = resp.json()
        ft = _extract_full_text(data)
        return ft or ""

    # ---- internals ---------------------------------------------------

    async def _iter_issues_with_pages(
        self,
        lccn: str,
        *,
        date_from: date | None,
        date_to: date | None,
    ) -> AsyncIterator[tuple[IssueRef, list[PageRef]]]:
        """Iterate (issue, pages) pairs by paginating the search endpoint."""
        page = 1
        current_key: tuple[date, int] | None = None
        current_pages: list[PageRef] = []

        def _finalize() -> tuple[IssueRef, list[PageRef]] | None:
            if current_key is None or not current_pages:
                return None
            d, ed = current_key
            issue = IssueRef(
                lccn=lccn, date_issued=d, edition=ed,
                url=_issue_resource_url(self._base, lccn, d, ed),
            )
            return issue, list(current_pages)

        while True:
            params = self._search_params(
                lccn=lccn, date_from=date_from, date_to=date_to,
                page=page, per_page=self._per_page,
            )
            data = await self._get_json(COLLECTION_PATH, params=params)
            results = data.get("results", []) or []
            for r in results:
                pref = self._page_ref_from_result(r, lccn=lccn)
                if pref is None:
                    continue
                key = (pref.date_issued, pref.edition)
                if current_key is None:
                    current_key = key
                if key != current_key:
                    pending = _finalize()
                    current_key = key
                    current_pages = [pref]
                    if pending is not None:
                        yield pending
                else:
                    current_pages.append(pref)

            nxt = (data.get("pagination") or {}).get("next")
            if not nxt or not results:
                break
            page += 1

        pending = _finalize()
        if pending is not None:
            yield pending

    async def _pages_for_single_issue(self, issue: IssueRef) -> list[PageRef]:
        """Re-enumerate pages for one issue via a date-limited search."""
        out: list[PageRef] = []
        async for iss, pages in self._iter_issues_with_pages(
            issue.lccn, date_from=issue.date_issued, date_to=issue.date_issued,
        ):
            if iss.edition == issue.edition:
                out.extend(pages)
        out.sort(key=lambda p: p.sequence)
        return out

    def _search_params(
        self,
        *,
        lccn: str,
        date_from: date | None,
        date_to: date | None,
        page: int,
        per_page: int,
    ) -> list[tuple[str, str]]:
        params: list[tuple[str, str]] = [
            ("fa", f"number_lccn:{lccn}"),
            ("dl", "page"),
            ("fo", "json"),
            ("c", str(per_page)),
            ("sp", str(page)),
        ]
        if date_from:
            params.append(("start_date", date_from.isoformat()))
        if date_to:
            params.append(("end_date", date_to.isoformat()))
        return params

    def _page_ref_from_result(self, r: dict, *, lccn: str) -> PageRef | None:
        try:
            d = _parse_date(r.get("date"))
            ed = _to_int(_first(_as_list(r.get("number_edition")))) or 1
        except (TypeError, ValueError):
            return None
        seq = _sequence_from_result(r)
        if seq is None:
            return None
        page_resource_url = (r.get("id") or "").rstrip("/")
        image_urls = _as_list(r.get("image_url"))
        # image_url is sorted from low-res to high-res in our use; pick the
        # largest JPG for the UI viewer and any .jp2 if present.
        jpeg = _last(
            [u for u in image_urls if isinstance(u, str) and u.endswith(".jpg")]
        )
        jp2 = _first(
            [u for u in image_urls if isinstance(u, str) and u.endswith(".jp2")]
        )
        pdf = _first(
            [u for u in image_urls if isinstance(u, str) and u.endswith(".pdf")]
        )
        return PageRef(
            lccn=lccn, date_issued=d, edition=ed, sequence=seq,
            image_url=jpeg or (image_urls[0] if image_urls else ""),
            jp2_url=jp2, pdf_url=pdf,
            resource_url=page_resource_url,
            ocr_url=_legacy_ocr_url(self._legacy, lccn, d, ed, seq),
        )

    async def _get_json(self, path: str, *, params=None) -> dict:
        resp = await self._get_with_retry(path, params=params)
        resp.raise_for_status()
        return resp.json()

    async def _get_with_retry(self, path: str, *, params=None) -> httpx.Response:
        """GET with exponential backoff on transient transport errors.

        LOC's search endpoint occasionally closes the connection mid-body
        (RemoteProtocolError); we also retry read timeouts and 5xx.
        4xx is non-retryable.
        """
        url = path if path.startswith("http") else f"{self._base}{path}"
        delay = self._retry_base_delay
        last: Exception | None = None
        for attempt in range(self._max_retries + 1):
            await self._throttle()
            try:
                resp = await self._client.get(url, params=params)
            except (
                httpx.RemoteProtocolError,
                httpx.ReadError,
                httpx.ReadTimeout,
                httpx.ConnectError,
                httpx.ConnectTimeout,
            ) as e:
                last = e
                if attempt >= self._max_retries:
                    raise
                await asyncio.sleep(delay)
                delay *= 2
                continue
            if resp.status_code >= 500:
                last = httpx.HTTPStatusError(
                    f"loc {resp.status_code}", request=resp.request, response=resp,
                )
                if attempt >= self._max_retries:
                    raise last
                ra = resp.headers.get("retry-after")
                if ra and ra.isdigit():
                    await asyncio.sleep(int(ra))
                else:
                    await asyncio.sleep(delay)
                    delay *= 2
                continue
            return resp
        # Loop always returns or raises; unreachable.
        raise last or RuntimeError("loc retry loop terminated unexpectedly")

    async def _get(self, url: str) -> httpx.Response:
        await self._throttle()
        return await self._client.get(url)

    async def _throttle(self) -> None:
        if self._min_interval <= 0:
            return
        loop = asyncio.get_event_loop()
        now = loop.time()
        wait = self._last_request_ts + self._min_interval - now
        if wait > 0:
            await asyncio.sleep(wait)
        self._last_request_ts = loop.time()


# ---- helpers --------------------------------------------------------

_DATE_RE = re.compile(r"^(\d{4})-(\d{2})-(\d{2})$")


def _parse_date(v: object) -> date:
    if isinstance(v, list):
        v = v[0] if v else None
    s = str(v) if v is not None else ""
    m = _DATE_RE.match(s)
    if not m:
        # 8-digit format also appears (YYYYMMDD)
        if len(s) == 8 and s.isdigit():
            return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
        raise ValueError(f"unparseable date: {v!r}")
    return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))


def _to_int(v: object) -> int | None:
    if v is None:
        return None
    try:
        return int(str(v).strip())
    except (TypeError, ValueError):
        return None


def _as_list(v: object) -> list:
    if v is None:
        return []
    if isinstance(v, list):
        return v
    return [v]


def _first(xs):
    return xs[0] if xs else None


def _last(xs):
    return xs[-1] if xs else None


def _sequence_from_result(r: dict) -> int | None:
    """Pull the page sequence number from a loc.gov search result."""
    # Direct fields
    for key in ("number_page_seq", "number_sequence_seq", "page", "sequence"):
        v = _to_int(_first(_as_list(r.get(key))))
        if v is not None:
            return v
    # Otherwise infer from the resource id URL: .../seq-N/ or .../seq-N
    rid = r.get("id") or ""
    m = re.search(r"/seq-(\d+)/?$", rid)
    if m:
        return int(m.group(1))
    # Some results carry it under a "url" field similarly.
    url = _first(_as_list(r.get("url"))) or ""
    m = re.search(r"/seq-(\d+)/?$", url)
    if m:
        return int(m.group(1))
    return None


def _format_place(r: dict) -> str | None:
    city = _first(_as_list(r.get("location_city")))
    state = _first(_as_list(r.get("location_state")))
    parts = [p for p in (city, state) if p]
    return ", ".join(parts) if parts else None


def _legacy_ocr_url(base: str, lccn: str, d: date, ed: int, seq: int) -> str:
    return f"{base}/lccn/{lccn}/{d.isoformat()}/ed-{ed}/seq-{seq}/ocr.txt"


def _issue_resource_url(base: str, lccn: str, d: date, ed: int) -> str:
    return f"{base}/resource/{lccn}/{d.isoformat()}/ed-{ed}/"


def _extract_full_text(data: dict) -> str | None:
    """Pull the OCR text out of a resource-endpoint JSON response.

    The field has shown up in several shapes across loc.gov endpoints:
    a top-level ``full_text`` string, an ``item.full_text`` string, or a
    ``resources[].fulltext_file`` URL we'd need to fetch separately.
    Returns inline text when present; URL-only cases yield ``None`` so
    the caller can decide whether to chase the link.
    """
    if not isinstance(data, dict):
        return None
    ft = data.get("full_text")
    if isinstance(ft, str) and ft.strip():
        return ft
    item = data.get("item")
    if isinstance(item, dict):
        ft = item.get("full_text")
        if isinstance(ft, str) and ft.strip():
            return ft
    return None
