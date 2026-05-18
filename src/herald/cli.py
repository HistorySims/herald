"""Herald CLI.

Phase 1 surface:
- ``herald ingest --lccn <lccn> --from YYYY-MM-DD --to YYYY-MM-DD``
- ``herald ask "<question>"``  (stub — wired in a later slice)
"""

from __future__ import annotations

import asyncio
from datetime import date

import typer
from rich.console import Console

from herald import normalize, settings
from herald.loc import LOCClient

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
        help="Enumerate only, do not write to DB. Default True until the DB write slice lands.",
    ),
) -> None:
    """Ingest a paper from Chronicling America into Supabase."""
    cfg = settings.load()
    asyncio.run(_ingest(cfg, lccn, _parse_date(date_from), _parse_date(date_to), dry_run))


async def _ingest(cfg: settings.Settings, lccn: str, df: date, dt: date, dry_run: bool) -> None:
    async with LOCClient(user_agent=cfg.loc_user_agent) as loc:
        issue_count = 0
        page_count = 0
        async for issue in loc.iter_issues(lccn, date_from=df, date_to=dt):
            issue_count += 1
            pages = await loc.list_pages(issue)
            page_count += len(pages)
            console.print(
                f"{issue.lccn} {issue.date_issued} ed-{issue.edition}  "
                f"pages={len(pages)}"
            )
            if not dry_run:
                console.print(
                    "[red]DB write path not yet implemented — re-run with --dry-run.[/red]"
                )
                raise typer.Exit(code=2)
    console.print(
        f"\n[bold]done[/bold]  issues={issue_count}  pages={page_count}  "
        f"({'dry run' if dry_run else 'persisted'})"
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
