import json
from datetime import date
from pathlib import Path

import httpx
import pytest

from herald.loc import LOCClient

FIX = Path(__file__).parent / "fixtures"


def _load(name: str) -> dict:
    return json.loads((FIX / name).read_text())


@pytest.mark.asyncio
async def test_iter_issues_filters_by_date_window(httpx_mock):
    httpx_mock.add_response(
        url="https://chroniclingamerica.loc.gov/lccn/sn83030213.json",
        json=_load("lccn_sn83030213.json"),
    )
    async with LOCClient(user_agent="test/1.0") as loc:
        issues = [
            i
            async for i in loc.iter_issues(
                "sn83030213",
                date_from=date(1845, 1, 1),
                date_to=date(1846, 12, 31),
            )
        ]
    assert len(issues) == 1
    assert issues[0].date_issued == date(1845, 8, 9)
    assert issues[0].edition == 1
    assert issues[0].lccn == "sn83030213"


@pytest.mark.asyncio
async def test_iter_issues_yields_all_when_no_filter(httpx_mock):
    httpx_mock.add_response(
        url="https://chroniclingamerica.loc.gov/lccn/sn83030213.json",
        json=_load("lccn_sn83030213.json"),
    )
    async with LOCClient(user_agent="test/1.0") as loc:
        issues = [i async for i in loc.iter_issues("sn83030213")]
    assert len(issues) == 4


@pytest.mark.asyncio
async def test_list_pages_builds_image_and_ocr_urls(httpx_mock):
    issue_url = "https://chroniclingamerica.loc.gov/lccn/sn83030213/1845-08-09/ed-1.json"
    httpx_mock.add_response(url=issue_url, json=_load("issue_1845-08-09.json"))

    async with LOCClient(user_agent="test/1.0") as loc:
        from herald.loc import IssueRef

        pages = await loc.list_pages(
            IssueRef(
                lccn="sn83030213",
                date_issued=date(1845, 8, 9),
                edition=1,
                url="https://chroniclingamerica.loc.gov/lccn/sn83030213/1845-08-09/ed-1/",
            )
        )
    assert [p.sequence for p in pages] == [1, 2, 3, 4]
    p1 = pages[0]
    assert p1.image_url.endswith("/1845-08-09/ed-1/seq-1.jpg")
    assert p1.jp2_url.endswith("/1845-08-09/ed-1/seq-1.jp2")
    assert p1.pdf_url.endswith("/1845-08-09/ed-1/seq-1.pdf")
    assert p1.ocr_url.endswith("/1845-08-09/ed-1/seq-1/ocr.txt")


@pytest.mark.asyncio
async def test_fetch_ocr_returns_text(httpx_mock):
    ocr_url = "https://chroniclingamerica.loc.gov/lccn/sn83030213/1845-08-09/ed-1/seq-1/ocr.txt"
    httpx_mock.add_response(url=ocr_url, text="ANTI-RENT EXCITEMENT.\nFrom our correspondent…\n")
    async with LOCClient(user_agent="test/1.0") as loc:
        from herald.loc import PageRef

        page = PageRef(
            lccn="sn83030213",
            date_issued=date(1845, 8, 9),
            edition=1,
            sequence=1,
            image_url="",
            jp2_url="",
            pdf_url="",
            ocr_url=ocr_url,
        )
        text = await loc.fetch_ocr(page)
    assert "ANTI-RENT" in text


@pytest.mark.asyncio
async def test_fetch_ocr_returns_empty_on_404(httpx_mock):
    ocr_url = "https://chroniclingamerica.loc.gov/lccn/sn99999999/1900-01-01/ed-1/seq-1/ocr.txt"
    httpx_mock.add_response(url=ocr_url, status_code=404)
    async with LOCClient(user_agent="test/1.0") as loc:
        from herald.loc import PageRef

        page = PageRef(
            lccn="sn99999999",
            date_issued=date(1900, 1, 1),
            edition=1,
            sequence=1,
            image_url="",
            jp2_url="",
            pdf_url="",
            ocr_url=ocr_url,
        )
        text = await loc.fetch_ocr(page)
    assert text == ""


@pytest.mark.asyncio
async def test_get_json_raises_on_http_error(httpx_mock):
    httpx_mock.add_response(
        url="https://chroniclingamerica.loc.gov/lccn/sn-bad.json",
        status_code=500,
    )
    async with LOCClient(user_agent="test/1.0") as loc:
        with pytest.raises(httpx.HTTPStatusError):
            async for _ in loc.iter_issues("sn-bad"):
                pass
