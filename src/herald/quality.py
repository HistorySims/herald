"""Backfill chunks.status + quality_score + quality_subscores.

Idempotent — re-running scores the same chunks the same way. Safe to
run after every new ingest. Phase-3 re-OCR creates new chunks that
default to status='active'; running this script after re-OCR scores
those too.

Schema this writes to:
  chunks.status              (active | quarantined)
  chunks.quality_score       (real, 0..1)
  chunks.quality_subscores   (jsonb)
  chunks.quarantined_at      (timestamptz, set when status=quarantined)
  chunks.quarantine_reason   (text)
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from datetime import datetime, timezone

import psycopg

from herald.classify import (
    QUARANTINE_DICT_RATIO,
    RECOVERY_CANDIDATE_DICT_RATIO,
    classify_quality,
    compute_quality_scores,
)


BATCH_SIZE = 1000


@dataclass
class ScoreSummary:
    total: int = 0
    quarantined: int = 0
    recovery_candidates: int = 0
    active_clean: int = 0
    quarantined_reasons: dict[str, int] | None = None

    def __post_init__(self) -> None:
        if self.quarantined_reasons is None:
            self.quarantined_reasons = {}


def score_all(
    db_url: str,
    on_progress: Callable[[str], None] | None = None,
) -> ScoreSummary:
    """Score every chunk and update its quarantine status."""

    def log(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    summary = ScoreSummary()

    conn = psycopg.connect(db_url, autocommit=False, prepare_threshold=None)
    try:
        with conn.cursor() as cur:
            cur.execute("select count(*) from chunks where is_current = true")
            row = cur.fetchone()
            summary.total = int(row[0]) if row else 0
        conn.commit()
        log(f"Scoring {summary.total:,} current chunks")

        offset = 0
        scored = 0
        while True:
            rows = _fetch_batch(conn, offset, BATCH_SIZE)
            if not rows:
                break

            updates = []
            now = datetime.now(timezone.utc)
            for chunk_id, content in rows:
                scores = compute_quality_scores(content)
                status, reason = classify_quality(scores)
                quarantined_at = now if status == "quarantined" else None

                if status == "quarantined":
                    summary.quarantined += 1
                    if reason:
                        summary.quarantined_reasons[reason] = (
                            summary.quarantined_reasons.get(reason, 0) + 1
                        )
                elif reason == "recovery_candidate":
                    summary.recovery_candidates += 1
                else:
                    summary.active_clean += 1

                updates.append((
                    status,
                    scores.composite(),
                    json.dumps(scores.to_dict()),
                    quarantined_at,
                    reason,
                    chunk_id,
                ))

            with conn.transaction():
                cur = conn.cursor()
                cur.executemany(
                    """
                    update chunks
                       set status = %s,
                           quality_score = %s,
                           quality_subscores = %s::jsonb,
                           quarantined_at = %s,
                           quarantine_reason = %s
                     where id = %s
                    """,
                    updates,
                )

            scored += len(rows)
            offset += len(rows)
            if scored % 5000 == 0 or scored == summary.total:
                log(f"  scored {scored:,} / {summary.total:,}")

        log(
            f"Done. quarantined={summary.quarantined:,} "
            f"recovery_candidates={summary.recovery_candidates:,} "
            f"clean={summary.active_clean:,}"
        )
        if summary.quarantined_reasons:
            log(f"  quarantine reasons: {summary.quarantined_reasons}")
        log(
            f"  thresholds: dict_word_ratio<{QUARANTINE_DICT_RATIO} = "
            f"quarantine candidate; <{RECOVERY_CANDIDATE_DICT_RATIO} = "
            f"recovery candidate"
        )
        return summary

    finally:
        conn.close()


def _fetch_batch(conn: psycopg.Connection, offset: int, limit: int) -> list[tuple[str, str]]:
    """Pull a stable ordered batch of (id, content)."""
    with conn.cursor() as cur:
        cur.execute(
            """
            select id, content
              from chunks
             where is_current = true
             order by id
             offset %s
             limit %s
            """,
            (offset, limit),
        )
        rows = cur.fetchall()
    conn.commit()
    return [(str(r[0]), r[1]) for r in rows]
