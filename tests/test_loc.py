"""Tests for the loc.gov-flavored LOC client."""

from __future__ import annotations

import json
import re
from datetime import date
from pathlib import Path

import httpx
import pytest

from herald.loc import LOCClient

FIX = Path(__file__).parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIX / name).read_text())


def _client() -> LOCClient:
    # Disable the throttle and shorten retry delays in tests so they stay fast.
    return LOCClient(
        user_agent="test/1.0",
        min_request_interval=0.0,
        retry_base_delay=0.0,
        rate_limit_pad_secs=0.0,
    )


def _client_low_cap() -> LOCClient:
    return LOCClient(
        user_agent="test/1.0",
        min_request_interval=0.0,
        retry_base_delay=0.0,
        rate_limit_pad_secs=0.0,
        max_pagination_depth=3,
    )


@pytest.mark.asyncio
async def test_iter_issues_with_pages_groups_by_date_and_edition(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*"),
        json=_load("search_two_issues.json"),
    )
    async with _client() as loc:
        out = [
            pair async for pair in loc.iter_issues_with_pages(
                "sn83030213",
                date_from=date(1845, 8, 9),
                date_to=date(1845, 8, 10),
            )
        ]
    assert len(out) == 2
    (i1, p1), (i2, p2) = out
    assert (i1.date_issued, i1.edition) == (date(1845, 8, 9), 1)
    assert [p.sequence for p in p1] == [1, 2, 3, 4]
    assert (i2.date_issued, i2.edition) == (date(1845, 8, 10), 1)
    assert [p.sequence for p in p2] == [1, 2]


@pytest.mark.asyncio
async def test_iter_issues_yields_issue_refs_only(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*"),
        json=_load("search_two_issues.json"),
    )
    async with _client() as loc:
        issues = [
            i async for i in loc.iter_issues(
                "sn83030213",
                date_from=date(1845, 8, 9),
                date_to=date(1845, 8, 10),
            )
        ]
    assert [(i.date_issued, i.edition) for i in issues] == [
        (date(1845, 8, 9), 1),
        (date(1845, 8, 10), 1),
    ]


@pytest.mark.asyncio
async def test_page_ref_extracts_image_urls_correctly(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*"),
        json=_load("search_two_issues.json"),
    )
    async with _client() as loc:
        pairs = [
            pair async for pair in loc.iter_issues_with_pages(
                "sn83030213",
                date_from=date(1845, 8, 9), date_to=date(1845, 8, 9),
            )
        ]
    _issue, pages = pairs[0]
    p1 = pages[0]
    assert p1.image_url.endswith("seq-1.jpg")
    assert p1.jp2_url is not None and p1.jp2_url.endswith("seq-1.jp2")
    assert p1.pdf_url is not None and p1.pdf_url.endswith("seq-1.pdf")
    assert p1.resource_url.endswith("/1845-08-09/ed-1/seq-1")
    assert p1.ocr_url == (
        "https://chroniclingamerica.loc.gov/lccn/sn83030213/"
        "1845-08-09/ed-1/seq-1/ocr.txt"
    )


@pytest.mark.asyncio
async def test_search_query_params_include_lccn_and_dates(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*"),
        json={"results": [], "pagination": {"next": None}},
    )
    async with _client() as loc:
        async for _ in loc.iter_issues_with_pages(
            "sn83030213",
            date_from=date(1842, 4, 22), date_to=date(1842, 4, 30),
        ):
            pass
    req = httpx_mock.get_requests()[0]
    qs = str(req.url)
    assert "fa=number_lccn%3Asn83030213" in qs or "fa=number_lccn:sn83030213" in qs
    assert "dl=page" in qs
    assert "fo=json" in qs
    assert "start_date=1842-04-22" in qs
    assert "end_date=1842-04-30" in qs


@pytest.mark.asyncio
async def test_get_paper_metadata_extracts_title_and_place(httpx_mock):
    httpx_mock.add_response(
        url=re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*"),
        json={
            "results": [
                {
                    "id": "https://www.loc.gov/resource/sn83030213/1845-08-09/ed-1/seq-1/",
                    "date": "1845-08-09",
                    "number_lccn": ["sn83030213"],
                    "number_edition": ["1"],
                    "partof_title": ["New-York Daily Tribune [volume]"],
                    "location_city": ["New-York"],
                    "location_state": ["New York"],
                    "image_url": [],
                }
            ],
            "pagination": {"next": None},
        },
    )
    async with _client() as loc:
        meta = await loc.get_paper_metadata("sn83030213")
    assert meta.lccn == "sn83030213"
    assert meta.title == "New-York Daily Tribune"  # "[volume]" stripped
    assert meta.place == "New-York, New York"


@pytest.mark.asyncio
async def test_fetch_ocr_returns_legacy_text_on_200(httpx_mock):
    ocr_url = (
        "https://chroniclingamerica.loc.gov/lccn/sn83030213/"
        "1845-08-09/ed-1/seq-1/ocr.txt"
    )
    httpx_mock.add_response(url=ocr_url, text="ANTI-RENT EXCITEMENT.\n")
    async with _client() as loc:
        from herald.loc import PageRef
        page = PageRef(
            lccn="sn83030213", date_issued=date(1845, 8, 9), edition=1,
            sequence=1, image_url="i.jpg", jp2_url="i.jp2", pdf_url="i.pdf",
            resource_url="https://www.loc.gov/resource/sn83030213/1845-08-09/ed-1/seq-1",
            ocr_url=ocr_url,
        )
        text = await loc.fetch_ocr(page)
    assert "ANTI-RENT" in text


@pytest.mark.asyncio
async def test_fetch_ocr_falls_back_to_resource_full_text_on_legacy_404(httpx_mock):
    ocr_url = (
        "https://chroniclingamerica.loc.gov/lccn/sn83030213/"
        "1845-08-09/ed-1/seq-1/ocr.txt"
    )
    httpx_mock.add_response(url=ocr_url, status_code=404)
    httpx_mock.add_response(
        url=re.compile(r"^https://www\.loc\.gov/resource/sn83030213/.*"),
        json={"full_text": "fallback ocr text", "item": {}},
    )
    async with _client() as loc:
        from herald.loc import PageRef
        page = PageRef(
            lccn="sn83030213", date_issued=date(1845, 8, 9), edition=1,
            sequence=1, image_url="i.jpg", jp2_url="i.jp2", pdf_url="i.pdf",
            resource_url="https://www.loc.gov/resource/sn83030213/1845-08-09/ed-1/seq-1",
            ocr_url=ocr_url,
        )
        text = await loc.fetch_ocr(page)
    assert text == "fallback ocr text"


@pytest.mark.asyncio
async def test_fetch_ocr_returns_empty_when_both_404(httpx_mock):
    ocr_url = (
        "https://chroniclingamerica.loc.gov/lccn/sn99999999/"
        "1900-01-01/ed-1/seq-1/ocr.txt"
    )
    httpx_mock.add_response(url=ocr_url, status_code=404)
    httpx_mock.add_response(
        url=re.compile(r"^https://www\.loc\.gov/resource/sn99999999/.*"),
        status_code=404,
    )
    async with _client() as loc:
        from herald.loc import PageRef
        page = PageRef(
            lccn="sn99999999", date_issued=date(1900, 1, 1), edition=1,
            sequence=1, image_url="i.jpg", jp2_url=None, pdf_url=None,
            resource_url="https://www.loc.gov/resource/sn99999999/1900-01-01/ed-1/seq-1",
            ocr_url=ocr_url,
        )
        text = await loc.fetch_ocr(page)
    assert text == ""


@pytest.mark.asyncio
async def test_pagination_follows_next_marker(httpx_mock):
    page1 = {
        "results": [
            {
                "id": "https://www.loc.gov/resource/sn83030213/1845-08-09/ed-1/seq-1/",
                "date": "1845-08-09", "number_edition": ["1"],
                "number_lccn": ["sn83030213"],
                "partof_title": ["X"],
                "image_url": ["https://x/seq-1.jpg"],
            }
        ],
        "pagination": {"next": "/some/next/path?sp=2", "current": 1, "total": 2},
    }
    page2 = {
        "results": [
            {
                "id": "https://www.loc.gov/resource/sn83030213/1845-08-10/ed-1/seq-1/",
                "date": "1845-08-10", "number_edition": ["1"],
                "number_lccn": ["sn83030213"],
                "partof_title": ["X"],
                "image_url": ["https://x/seq-1.jpg"],
            }
        ],
        "pagination": {"next": None, "current": 2, "total": 2},
    }
    httpx_mock.add_response(json=page1)
    httpx_mock.add_response(json=page2)
    async with _client() as loc:
        out = [
            pair async for pair in loc.iter_issues_with_pages(
                "sn83030213", date_from=date(1845, 8, 9), date_to=date(1845, 8, 10),
            )
        ]
    assert len(out) == 2
    assert len(httpx_mock.get_requests()) == 2


@pytest.mark.asyncio
async def test_get_json_raises_on_http_error(httpx_mock):
    # 5xx is retried up to max_retries+1 times before bubbling up; configure
    # enough mock responses to satisfy each attempt (default max_retries=8).
    for _ in range(9):
        httpx_mock.add_response(
            url=re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*"),
            status_code=500,
        )
    async with _client() as loc:
        with pytest.raises(httpx.HTTPStatusError):
            async for _ in loc.iter_issues("sn83030213"):
                pass


@pytest.mark.asyncio
async def test_retries_remote_protocol_error_then_succeeds(httpx_mock):
    # Simulate LOC truncating a large response, then succeeding on retry.
    url_re = re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*")
    httpx_mock.add_exception(
        httpx.RemoteProtocolError("peer closed early", request=None),
        url=url_re,
    )
    httpx_mock.add_response(
        url=url_re, json=_load("search_two_issues.json"),
    )
    async with _client() as loc:
        out = [
            pair async for pair in loc.iter_issues_with_pages(
                "sn83030213",
                date_from=date(1845, 8, 9), date_to=date(1845, 8, 10),
            )
        ]
    assert len(out) == 2
    assert len(httpx_mock.get_requests()) == 2  # one failure + one success


@pytest.mark.asyncio
async def test_retries_on_429_then_succeeds(httpx_mock):
    url_re = re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*")
    httpx_mock.add_response(url=url_re, status_code=429, text="slow down")
    httpx_mock.add_response(url=url_re, json=_load("search_two_issues.json"))
    async with _client() as loc:
        out = [
            pair async for pair in loc.iter_issues_with_pages(
                "sn83030213",
                date_from=date(1845, 8, 9), date_to=date(1845, 8, 10),
            )
        ]
    assert len(out) == 2
    assert len(httpx_mock.get_requests()) == 2


@pytest.mark.asyncio
async def test_client_side_filter_drops_out_of_window_results(httpx_mock):
    """LOC has been observed ignoring its own date filter — we filter on top.

    Simulate that case: server returns the fixture with dates 1845-08-09 and
    1845-08-10, but caller asks for 1845-08-10 only. The 1845-08-09 results
    must be dropped client-side.
    """
    url_re = re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*")
    httpx_mock.add_response(url=url_re, json=_load("search_two_issues.json"))
    async with _client() as loc:
        out = [
            pair async for pair in loc.iter_issues_with_pages(
                "sn83030213",
                date_from=date(1845, 8, 10), date_to=date(1845, 8, 10),
            )
        ]
    assert len(out) == 1
    issue, pages = out[0]
    assert issue.date_issued == date(1845, 8, 10)
    assert all(p.date_issued == date(1845, 8, 10) for p in pages)


@pytest.mark.asyncio
async def test_pagination_cap_raises_when_filter_ignored(httpx_mock):
    """When LOC ignores the date filter and never returns in-window results,
    we must abort after max_pagination_depth pages instead of looping forever.
    """
    out_of_window_results = {
        "results": [
            {
                "id": "https://www.loc.gov/resource/sn83030213/1850-01-01/ed-1/seq-1/",
                "date": "1850-01-01",
                "number_edition": ["1"],
                "number_lccn": ["sn83030213"],
                "partof_title": ["x"],
                "image_url": ["https://x/seq-1.jpg"],
            }
        ],
        # Indicate there's always a "next" page so the loop would normally
        # run until the cap trips it.
        "pagination": {"next": "/sp=N", "current": 1, "total": 999},
    }
    url_re = re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*")
    # Cap is 3, so the loop hits pages 1, 2, 3 then raises on the next pass.
    for _ in range(3):
        httpx_mock.add_response(url=url_re, json=out_of_window_results)
    async with _client_low_cap() as loc:
        with pytest.raises(RuntimeError, match="pagination exceeded"):
            async for _ in loc.iter_issues_with_pages(
                "sn83030213",
                date_from=date(1842, 4, 22), date_to=date(1842, 4, 30),
            ):
                pass


@pytest.mark.asyncio
async def test_pagination_stops_early_after_window_exit(httpx_mock):
    """If page N delivered in-window results and page N+1 has none, stop."""
    in_window = {
        "results": [
            {
                "id": "https://www.loc.gov/resource/sn83030213/1842-04-22/ed-1/seq-1/",
                "date": "1842-04-22",
                "number_edition": ["1"],
                "number_lccn": ["sn83030213"],
                "partof_title": ["x"],
                "image_url": ["https://x/seq-1.jpg"],
            }
        ],
        "pagination": {"next": "/sp=2", "current": 1, "total": 100},
    }
    out_window = {
        "results": [
            {
                "id": "https://www.loc.gov/resource/sn83030213/1843-01-01/ed-1/seq-1/",
                "date": "1843-01-01",
                "number_edition": ["1"],
                "number_lccn": ["sn83030213"],
                "partof_title": ["x"],
                "image_url": ["https://x/seq-1.jpg"],
            }
        ],
        "pagination": {"next": "/sp=3", "current": 2, "total": 100},
    }
    url_re = re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*")
    httpx_mock.add_response(url=url_re, json=in_window)
    httpx_mock.add_response(url=url_re, json=out_window)
    async with _client() as loc:
        out = [
            pair async for pair in loc.iter_issues_with_pages(
                "sn83030213",
                date_from=date(1842, 4, 22), date_to=date(1842, 4, 30),
            )
        ]
    assert len(out) == 1
    assert len(httpx_mock.get_requests()) == 2  # stopped after seeing the gap


@pytest.mark.asyncio
async def test_search_params_include_dates_year_range(httpx_mock):
    url_re = re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*")
    httpx_mock.add_response(url=url_re, json={"results": [], "pagination": {"next": None}})
    async with _client() as loc:
        async for _ in loc.iter_issues_with_pages(
            "sn83030213",
            date_from=date(1842, 4, 22), date_to=date(1846, 12, 31),
        ):
            pass
    qs = str(httpx_mock.get_requests()[0].url)
    assert "dates=1842%2F1846" in qs or "dates=1842/1846" in qs
