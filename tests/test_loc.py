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
    # Disable the throttle in tests so they stay fast.
    return LOCClient(user_agent="test/1.0", min_request_interval=0.0)


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
    httpx_mock.add_response(
        url=re.compile(r"^https://www\.loc\.gov/collections/chronicling-america/.*"),
        status_code=500,
    )
    async with _client() as loc:
        with pytest.raises(httpx.HTTPStatusError):
            async for _ in loc.iter_issues("sn83030213"):
                pass
