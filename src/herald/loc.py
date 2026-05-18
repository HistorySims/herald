"""Chronicling America client.

Enumerates issues + pages for a given LCCN, fetches per-page OCR text and
canonical image URLs. Idempotent and resumable — the caller decides what
to keep based on ``(lccn, date_issued, edition, sequence)``.

See PLAN.md §4.1 for the ingest flow.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass
from datetime import date

import httpx

BASE = "https://chroniclingamerica.loc.gov"


@dataclass(frozen=True)
class IssueRef:
    lccn: str
    date_issued: date
    edition: int
    url: str  # canonical issue URL, ends with '/'


@dataclass(frozen=True)
class PageRef:
    lccn: str
    date_issued: date
    edition: int
    sequence: int
    image_url: str
    jp2_url: str
    pdf_url: str
    ocr_url: str


class LOCClient:
    """Thin async wrapper around the Chronicling America JSON endpoints."""

    def __init__(
        self,
        *,
        user_agent: str,
        client: httpx.AsyncClient | None = None,
        base_url: str = BASE,
    ) -> None:
        self._base = base_url.rstrip("/")
        self._owns_client = client is None
        self._client = client or httpx.AsyncClient(
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            timeout=httpx.Timeout(30.0, connect=10.0),
            follow_redirects=True,
        )

    async def __aenter__(self) -> LOCClient:
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        if self._owns_client:
            await self._client.aclose()

    async def iter_issues(
        self,
        lccn: str,
        *,
        date_from: date | None = None,
        date_to: date | None = None,
    ) -> AsyncIterator[IssueRef]:
        """Yield issues for ``lccn`` whose date_issued falls in the window."""
        data = await self._get_json(f"/lccn/{lccn}.json")
        for entry in data.get("issues", []):
            issue_date = _parse_date(entry["date_issued"])
            if date_from and issue_date < date_from:
                continue
            if date_to and issue_date > date_to:
                continue
            url = entry["url"]
            yield IssueRef(
                lccn=lccn,
                date_issued=issue_date,
                edition=_edition_from_url(url),
                url=url,
            )

    async def list_pages(self, issue: IssueRef) -> list[PageRef]:
        """Return the page list for a single issue."""
        data = await self._get_json(_to_json(issue.url))
        out: list[PageRef] = []
        for p in data.get("pages", []):
            seq = _sequence_from_url(p["url"])
            page_base = p["url"].rstrip("/").removesuffix(".json")
            out.append(
                PageRef(
                    lccn=issue.lccn,
                    date_issued=issue.date_issued,
                    edition=issue.edition,
                    sequence=seq,
                    image_url=f"{self._base}{page_base}.jpg",
                    jp2_url=f"{self._base}{page_base}.jp2",
                    pdf_url=f"{self._base}{page_base}.pdf",
                    ocr_url=f"{self._base}{page_base}/ocr.txt",
                )
            )
        out.sort(key=lambda p: p.sequence)
        return out

    async def fetch_ocr(self, page: PageRef) -> str:
        """Fetch the raw OCR text for a page. Empty string if missing."""
        resp = await self._client.get(page.ocr_url)
        if resp.status_code == 404:
            return ""
        resp.raise_for_status()
        return resp.text

    async def _get_json(self, path: str) -> dict:
        url = path if path.startswith("http") else f"{self._base}{path}"
        resp = await self._client.get(url)
        resp.raise_for_status()
        return resp.json()


def _parse_date(s: str) -> date:
    return date.fromisoformat(s)


def _edition_from_url(url: str) -> int:
    # .../lccn/sn83030213/1842-04-22/ed-1/  -> 1
    for part in url.rstrip("/").split("/"):
        if part.startswith("ed-"):
            try:
                return int(part[3:])
            except ValueError:
                pass
    return 1


def _sequence_from_url(url: str) -> int:
    # .../lccn/sn83030213/1842-04-22/ed-1/seq-3/  -> 3
    for part in url.rstrip("/").removesuffix(".json").split("/"):
        if part.startswith("seq-"):
            try:
                return int(part[4:])
            except ValueError:
                pass
    return 0


def _to_json(url: str) -> str:
    return url.rstrip("/") + ".json"
