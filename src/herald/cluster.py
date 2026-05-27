"""Hierarchical clustering + UMAP projection batch pipeline.

Reads all chunk embeddings from the database, computes:
1. HDBSCAN base clusters (tier 0)
2. Agglomerative merge hierarchy (tiers 1-3) with size-weighted centroids
3. UMAP 2D projection for visualization
4. Content-type classification (ads, legal, bad OCR)

Results are written to cluster_runs, clusters, and chunk_projections tables.
"""

from __future__ import annotations

import json
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import date
from typing import Callable
from uuid import UUID

import numpy as np
import psycopg
from pgvector.psycopg import register_vector

from herald.classify import classify_chunk


@dataclass
class ClusterParams:
    min_cluster_size: int = 25
    min_samples: int = 10
    umap_neighbors: int = 15
    umap_min_dist: float = 0.1
    tier1_target: int = 100
    tier2_target: int = 20
    tier3_target: int = 5


@dataclass
class ClusterResult:
    run_id: UUID
    chunk_count: int
    tier_counts: dict[int, int] = field(default_factory=dict)
    content_type_counts: dict[int, int] = field(default_factory=dict)
    noise_reassigned: int = 0


def run_pipeline(
    db_url: str,
    params: ClusterParams | None = None,
    on_progress: Callable[[str], None] | None = None,
) -> ClusterResult:
    if params is None:
        params = ClusterParams()

    def log(msg: str) -> None:
        if on_progress:
            on_progress(msg)

    conn = psycopg.connect(db_url, autocommit=False, prepare_threshold=None)
    register_vector(conn)

    try:
        log("Loading chunk data from database...")
        chunk_ids, embeddings, dates, contents = _load_chunks(conn, log)
        n = len(chunk_ids)
        log(f"Loaded {n} chunks with embeddings")

        if n == 0:
            raise ValueError("No chunks with embeddings found in database")

        log("Classifying content types...")
        content_types = np.array(
            [classify_chunk(c) for c in contents], dtype=np.int8
        )
        type_counts = {}
        for t in range(4):
            count = int(np.sum(content_types == t))
            type_counts[t] = count
        log(f"  content={type_counts.get(0,0)} ad={type_counts.get(1,0)} "
            f"legal={type_counts.get(2,0)} bad_ocr={type_counts.get(3,0)}")

        log(f"Running HDBSCAN (min_cluster_size={params.min_cluster_size})...")
        t0_labels, noise_count = _hdbscan_cluster(embeddings, params)
        n_clusters_t0 = int(t0_labels.max()) + 1
        log(f"  {n_clusters_t0} clusters, {noise_count} noise points reassigned")

        log("Computing tier-0 weighted centroids...")
        t0_centroids, t0_sizes, t0_date_ranges = _compute_cluster_stats(
            embeddings, t0_labels, dates, n_clusters_t0
        )

        log("Building agglomerative hierarchy (tiers 1-3)...")
        hierarchy = _build_hierarchy(
            t0_centroids, t0_sizes, t0_labels, n_clusters_t0, params
        )

        log(f"Running UMAP (n_neighbors={params.umap_neighbors})...")
        xy = _umap_project(embeddings, params)
        log(f"  UMAP complete, shape={xy.shape}")

        log("Writing results to database...")
        run_id = _write_results(
            conn, params, chunk_ids, xy, t0_labels,
            hierarchy, t0_centroids, t0_sizes, t0_date_ranges,
            content_types, dates, embeddings, log,
        )

        result = ClusterResult(
            run_id=run_id,
            chunk_count=n,
            tier_counts={0: n_clusters_t0},
            content_type_counts=type_counts,
            noise_reassigned=noise_count,
        )
        for tier, mapping in hierarchy.items():
            result.tier_counts[tier] = len(set(mapping.values()))

        log(f"Done. run_id={run_id}")
        return result

    finally:
        conn.close()


def _load_chunks(
    conn: psycopg.Connection,
    log: Callable[[str], None],
) -> tuple[list[UUID], np.ndarray, list[date], list[str]]:
    chunk_ids: list[UUID] = []
    embeddings_list: list[list[float]] = []
    dates_list: list[date] = []
    contents_list: list[str] = []

    with conn.cursor(name="load_chunks") as cur:
        cur.itersize = 5000
        cur.execute("""
            SELECT c.id, c.embedding, i.date_issued, c.content
            FROM chunks c
            JOIN pages p ON p.id = c.page_id
            JOIN issues i ON i.id = p.issue_id
            WHERE c.is_current = true
              AND c.embedding IS NOT NULL
            ORDER BY c.id
        """)
        batch = 0
        for row in cur:
            chunk_ids.append(row[0] if isinstance(row[0], UUID) else UUID(str(row[0])))
            embeddings_list.append(row[1])
            dates_list.append(row[2])
            contents_list.append(row[3])
            batch += 1
            if batch % 10000 == 0:
                log(f"  loaded {batch} chunks...")

    conn.commit()  # close the server-side cursor's transaction
    embeddings = np.array(embeddings_list, dtype=np.float32)
    return chunk_ids, embeddings, dates_list, contents_list


def _hdbscan_cluster(
    embeddings: np.ndarray,
    params: ClusterParams,
) -> tuple[np.ndarray, int]:
    import hdbscan

    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=params.min_cluster_size,
        min_samples=params.min_samples,
        metric="euclidean",
        core_dist_n_jobs=-1,
        cluster_selection_method="eom",
    )
    labels = clusterer.fit_predict(embeddings)

    noise_mask = labels == -1
    noise_count = int(noise_mask.sum())

    if noise_count > 0 and not noise_mask.all():
        valid_labels = set(labels[~noise_mask])
        centroids = {}
        for lab in valid_labels:
            mask = labels == lab
            centroids[lab] = embeddings[mask].mean(axis=0)

        centroid_labels = sorted(centroids.keys())
        centroid_matrix = np.array([centroids[l] for l in centroid_labels])

        noise_indices = np.where(noise_mask)[0]
        noise_embeddings = embeddings[noise_indices]

        norms_noise = np.linalg.norm(noise_embeddings, axis=1, keepdims=True)
        norms_centroids = np.linalg.norm(centroid_matrix, axis=1, keepdims=True)
        norms_noise = np.maximum(norms_noise, 1e-10)
        norms_centroids = np.maximum(norms_centroids, 1e-10)

        similarities = (noise_embeddings / norms_noise) @ (centroid_matrix / norms_centroids).T
        best_idx = similarities.argmax(axis=1)

        for i, ni in enumerate(noise_indices):
            labels[ni] = centroid_labels[best_idx[i]]

    return labels, noise_count


def _compute_cluster_stats(
    embeddings: np.ndarray,
    labels: np.ndarray,
    dates: list[date],
    n_clusters: int,
) -> tuple[np.ndarray, np.ndarray, list[tuple[date, date]]]:
    dim = embeddings.shape[1]
    centroids = np.zeros((n_clusters, dim), dtype=np.float64)
    sizes = np.zeros(n_clusters, dtype=np.int64)
    date_ranges: list[tuple[date, date]] = []

    date_mins: dict[int, date] = {}
    date_maxs: dict[int, date] = {}

    for i in range(len(labels)):
        lab = labels[i]
        centroids[lab] += embeddings[i]
        sizes[lab] += 1
        d = dates[i]
        if lab not in date_mins or d < date_mins[lab]:
            date_mins[lab] = d
        if lab not in date_maxs or d > date_maxs[lab]:
            date_maxs[lab] = d

    for lab in range(n_clusters):
        if sizes[lab] > 0:
            centroids[lab] /= sizes[lab]

    for lab in range(n_clusters):
        if lab in date_mins:
            date_ranges.append((date_mins[lab], date_maxs[lab]))
        else:
            date_ranges.append((date(1845, 6, 1), date(1845, 6, 1)))

    return centroids.astype(np.float32), sizes, date_ranges


def _build_hierarchy(
    t0_centroids: np.ndarray,
    t0_sizes: np.ndarray,
    t0_labels: np.ndarray,
    n_t0: int,
    params: ClusterParams,
) -> dict[int, dict[int, int]]:
    from scipy.cluster.hierarchy import fcluster, linkage
    from scipy.spatial.distance import pdist

    if n_t0 <= 1:
        return {1: {0: 0}, 2: {0: 0}, 3: {0: 0}}

    dists = pdist(t0_centroids, metric="cosine")
    dists = np.nan_to_num(dists, nan=1.0)
    Z = linkage(dists, method="average")

    hierarchy: dict[int, dict[int, int]] = {}

    for tier, target in [(1, params.tier1_target), (2, params.tier2_target), (3, params.tier3_target)]:
        target = min(target, n_t0)
        target = max(target, 1)
        tier_labels = fcluster(Z, t=target, criterion="maxclust")
        tier_labels -= 1  # 0-indexed
        mapping = {t0_lab: int(tier_labels[t0_lab]) for t0_lab in range(n_t0)}
        hierarchy[tier] = mapping

    return hierarchy


def _umap_project(embeddings: np.ndarray, params: ClusterParams) -> np.ndarray:
    import umap

    reducer = umap.UMAP(
        n_components=2,
        n_neighbors=params.umap_neighbors,
        min_dist=params.umap_min_dist,
        metric="cosine",
        random_state=42,
        low_memory=True,
    )
    xy = reducer.fit_transform(embeddings)

    for dim in range(2):
        col = xy[:, dim]
        mn, mx = col.min(), col.max()
        if mx - mn > 1e-10:
            xy[:, dim] = (col - mn) / (mx - mn)
        else:
            xy[:, dim] = 0.5

    return xy.astype(np.float32)


def _write_results(
    conn: psycopg.Connection,
    params: ClusterParams,
    chunk_ids: list[UUID],
    xy: np.ndarray,
    t0_labels: np.ndarray,
    hierarchy: dict[int, dict[int, int]],
    t0_centroids: np.ndarray,
    t0_sizes: np.ndarray,
    t0_date_ranges: list[tuple[date, date]],
    content_types: np.ndarray,
    dates: list[date],
    embeddings: np.ndarray,
    log: Callable[[str], None],
) -> UUID:
    n = len(chunk_ids)

    with conn.transaction():
        cur = conn.cursor()

        cur.execute(
            """INSERT INTO cluster_runs (chunk_count, params, status)
               VALUES (%s, %s, 'running') RETURNING id""",
            (n, json.dumps({
                "min_cluster_size": params.min_cluster_size,
                "min_samples": params.min_samples,
                "umap_neighbors": params.umap_neighbors,
                "umap_min_dist": params.umap_min_dist,
            })),
        )
        run_id = cur.fetchone()[0]
        if not isinstance(run_id, UUID):
            run_id = UUID(str(run_id))

        log(f"  Writing tier-0 clusters ({int(t0_labels.max()) + 1})...")
        n_t0 = int(t0_labels.max()) + 1
        t0_db_ids: dict[int, UUID] = {}
        for lab in range(n_t0):
            cur.execute(
                """INSERT INTO clusters (run_id, tier, label, size, centroid, date_min, date_max)
                   VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                (
                    run_id, 0, lab, int(t0_sizes[lab]),
                    t0_centroids[lab].tolist(),
                    t0_date_ranges[lab][0], t0_date_ranges[lab][1],
                ),
            )
            t0_db_ids[lab] = cur.fetchone()[0]
            if not isinstance(t0_db_ids[lab], UUID):
                t0_db_ids[lab] = UUID(str(t0_db_ids[lab]))

        prev_tier_ids: dict[int, UUID] = t0_db_ids

        for tier in [1, 2, 3]:
            mapping = hierarchy[tier]
            tier_labels_set = sorted(set(mapping.values()))
            log(f"  Writing tier-{tier} clusters ({len(tier_labels_set)})...")

            tier_centroids: dict[int, np.ndarray] = {}
            tier_sizes: dict[int, int] = defaultdict(int)
            tier_date_mins: dict[int, date] = {}
            tier_date_maxs: dict[int, date] = {}

            for t0_lab, upper_lab in mapping.items():
                w = int(t0_sizes[t0_lab])
                tier_sizes[upper_lab] += w
                if upper_lab not in tier_centroids:
                    tier_centroids[upper_lab] = t0_centroids[t0_lab].astype(np.float64) * w
                else:
                    tier_centroids[upper_lab] += t0_centroids[t0_lab].astype(np.float64) * w

                dmin, dmax = t0_date_ranges[t0_lab]
                if upper_lab not in tier_date_mins or dmin < tier_date_mins[upper_lab]:
                    tier_date_mins[upper_lab] = dmin
                if upper_lab not in tier_date_maxs or dmax > tier_date_maxs[upper_lab]:
                    tier_date_maxs[upper_lab] = dmax

            for lab in tier_labels_set:
                if tier_sizes[lab] > 0:
                    tier_centroids[lab] /= tier_sizes[lab]

            tier_db_ids: dict[int, UUID] = {}
            for lab in tier_labels_set:
                cur.execute(
                    """INSERT INTO clusters (run_id, tier, label, size, centroid, date_min, date_max)
                       VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id""",
                    (
                        run_id, tier, lab, tier_sizes[lab],
                        tier_centroids[lab].astype(np.float32).tolist(),
                        tier_date_mins.get(lab), tier_date_maxs.get(lab),
                    ),
                )
                tier_db_ids[lab] = cur.fetchone()[0]
                if not isinstance(tier_db_ids[lab], UUID):
                    tier_db_ids[lab] = UUID(str(tier_db_ids[lab]))

            if tier == 1:
                for t0_lab, upper_lab in mapping.items():
                    cur.execute(
                        "UPDATE clusters SET parent_id = %s WHERE id = %s",
                        (tier_db_ids[upper_lab], t0_db_ids[t0_lab]),
                    )
            else:
                prev_mapping = hierarchy[tier - 1]
                prev_to_current: dict[int, int] = {}
                for t0_lab in range(n_t0):
                    prev_lab = prev_mapping[t0_lab]
                    curr_lab = mapping[t0_lab]
                    prev_to_current[prev_lab] = curr_lab

                for prev_lab, curr_lab in prev_to_current.items():
                    cur.execute(
                        "UPDATE clusters SET parent_id = %s WHERE run_id = %s AND tier = %s AND label = %s",
                        (tier_db_ids[curr_lab], run_id, tier - 1, prev_lab),
                    )

            prev_tier_ids = tier_db_ids

        log(f"  Writing {n} chunk projections...")
        t1_map = hierarchy[1]
        t2_map = hierarchy[2]
        t3_map = hierarchy[3]

        batch_size = 5000
        for start in range(0, n, batch_size):
            end = min(start + batch_size, n)
            batch_params = []
            for i in range(start, end):
                t0 = int(t0_labels[i])
                batch_params.append((
                    chunk_ids[i], run_id,
                    float(xy[i, 0]), float(xy[i, 1]),
                    t0, t1_map[t0], t2_map[t0], t3_map[t0],
                    int(content_types[i]),
                ))
            cur.executemany(
                """INSERT INTO chunk_projections
                   (chunk_id, run_id, x, y, cluster_t0, cluster_t1, cluster_t2, cluster_t3, content_type)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                batch_params,
            )
            if (end - start) == batch_size:
                log(f"    {end}/{n} projections written...")

        cur.execute(
            "UPDATE cluster_runs SET status = 'completed', finished_at = now() WHERE id = %s",
            (run_id,),
        )

        cur.execute(
            """INSERT INTO active_cluster_run (singleton, run_id)
               VALUES (true, %s)
               ON CONFLICT (singleton) DO UPDATE SET run_id = %s, activated_at = now()""",
            (run_id, run_id),
        )

    return run_id
