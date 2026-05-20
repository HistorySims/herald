"""Herald CLI.

Phase 1 surface:
- ``herald ingest --lccn <lccn> --from YYYY-MM-DD --to YYYY-MM-DD [--no-dry-run]``
- ``herald ask "<question>"``  (stub — wired in a later slice)
- ``herald normalize-text <path>`` (debug helper)
"""

from __future__ import annotations

import asyncio
from datetime import date

import typer
from rich.console import Console

from herald import db, normalize, settings
from herald.embed import VoyageEmbedder
from herald.ingest import ingest_paper
from herald.loc import LOCClient, PageRef

app = typer.Typer(
    add_completion=False,
    help="Semantic research over historical American newspapers.",
    no_args_is_help=True,
)
console = Console()


@app.command()
def ingest(
    lccn: str = typer.Option(..., "--lccn", help="Chronicling America LCCN"),
    date_from: str = typer.Option(..., "--from", help="Inclusive start date (YYYY-MM-DD)"),
    date_to: str = typer.Option(..., "--to", help="Inclusive end date (YYYY-MM-DD)"),
    dry_run: bool = typer.Option(
        True,
        "--dry-run/--no-dry-run",
        help="Dry-run enumerates issues only. --no-dry-run writes to Supabase.",
    ),
) -> None:
    """Ingest a paper from Chronicling America into Supabase."""
    cfg = settings.load()
    asyncio.run(_ingest(cfg, lccn, _parse_date(date_from), _parse_date(date_to), dry_run))


async def _ingest(
    cfg: settings.Settings, lccn: str, df: date, dt: date, dry_run: bool
) -> None:
    if dry_run:
        await _ingest_dry_run(cfg, lccn, df, dt)
        return
    await _ingest_full(cfg, lccn, df, dt)


async def _ingest_dry_run(
    cfg: settings.Settings, lccn: str, df: date, dt: date
) -> None:
    async with LOCClient(user_agent=cfg.loc_user_agent) as loc:
        meta = await loc.get_paper_metadata(lccn)
        console.print(f"[bold]{meta.title}[/bold]  ({meta.lccn})  {meta.place or '-'}")
        issue_count = 0
        page_count = 0
        async for issue, pages in loc.iter_issues_with_pages(
            lccn, date_from=df, date_to=dt,
        ):
            issue_count += 1
            page_count += len(pages)
            console.print(
                f"  {issue.date_issued} ed-{issue.edition}  pages={len(pages)}"
            )
    console.print(
        f"\n[bold]dry run done[/bold]  issues={issue_count}  pages={page_count}"
    )


async def _ingest_full(
    cfg: settings.Settings, lccn: str, df: date, dt: date
) -> None:
    if not cfg.supabase_db_url:
        raise typer.BadParameter(
            "SUPABASE_DB_URL is not set. See README for setup."
        )
    if not cfg.voyage_api_key:
        raise typer.BadParameter(
            "VOYAGE_API_KEY is not set. See README for setup."
        )

    conn = db.connect(cfg.supabase_db_url)
    try:
        async with (
            LOCClient(user_agent=cfg.loc_user_agent) as loc,
            VoyageEmbedder(api_key=cfg.voyage_api_key) as voyage,
        ):
            meta = await loc.get_paper_metadata(lccn)
            console.print(
                f"[bold]{meta.title}[/bold]  ({meta.lccn})  {meta.place or '-'}"
            )
            console.print(f"  window: {df}  →  {dt}\n")

            def _on_page(p: PageRef, status: str) -> None:
                color = {"skipped": "dim", "written": "green", "empty": "yellow"}.get(
                    status, "white"
                )
                console.print(
                    f"  [{color}]{status:>7}[/]  {p.date_issued} ed-{p.edition} seq-{p.sequence}"
                )

            stats = await ingest_paper(
                loc=loc,
                voyage=voyage,
                conn=conn,
                lccn=meta.lccn,
                title=meta.title,
                place=meta.place,
                start_year=meta.start_year,
                end_year=meta.end_year,
                date_from=df,
                date_to=dt,
                on_page=_on_page,
            )
    finally:
        conn.close()

    console.print(
        f"\n[bold green]done[/bold green]  "
        f"issues={stats.issues_seen}  pages_seen={stats.pages_seen}  "
        f"written={stats.pages_written}  skipped={stats.pages_skipped}  "
        f"chunks={stats.chunks_written}"
    )


@app.command()
def ask(
    question: str = typer.Argument(..., help="Natural-language question"),
) -> None:
    """Answer a question against the ingested corpus. (Stub — coming next slice.)"""
    _ = question
    console.print("[yellow]ask: not implemented yet (see PLAN.md sections 8-9)[/yellow]")
    raise typer.Exit(code=2)


@app.command()
def normalize_text(
    path: str = typer.Argument(..., help="Path to a raw OCR .txt file"),
) -> None:
    """Print the normalized form of a raw OCR text file (debugging helper)."""
    with open(path, encoding="utf-8", errors="replace") as f:
        raw = f.read()
    console.print(normalize.normalize_ocr(raw))


def _parse_date(s: str) -> date:
    try:
        return date.fromisoformat(s)
    except ValueError as e:
        raise typer.BadParameter(f"date must be YYYY-MM-DD: {s}") from e
