# Herald — Current Status

*Last updated: June 2026*

A snapshot of what Herald actually does today, after Phases 1 + 2 and the substantial post-Phase-2 evolution of the explore feature. Replaces the Phase 1 and Phase 2 plan docs as the working reference.

---

## What Herald is

A semantic-search and visualization tool over a corpus of 1840s New York newspapers (currently 26,308 chunks across the New-York Daily Tribune and the Albany Evening Journal, June-September 1845, with sparse 1842 data already deleted to free space).

It has two main surfaces:

### `/` — Question-answer chat
- Three response **modes** selectable per query:
  - **Synthesis** — historian-style analysis with paper attribution
  - **Research** — librarian-style source-by-source guide with quotes and a Chronicling America search suggestion
  - **Directory** — instant Postgres-FTS-only listing, no LLM call ($0)
- Conversation history persists in `localStorage` so reloading doesn't lose context.
- Citations render as clickable badges that open the **page viewer**.
- Optional **cluster scope**: a URL parameter (`?scope_tier=N&scope_label=N`) restricts retrieval to chunks in a specific cluster. Shows an amber banner with the cluster name and a Clear button.

### `/explore` — Cluster map
- WebGL scatter plot (`deck.gl`) of all 26k chunks projected with UMAP.
- Color = cluster at the currently selected tier.
- **Four hierarchical tiers** computed by HDBSCAN (leaf method, `min_cluster_size=15`) at the leaf, then scipy agglomerative merging with **size-weighted centroids** (NYC/Syracuse/Buffalo effect) up to tier 3.
- **Bursty Topics** sidebar ranks clusters at the current tier by coefficient-of-variation of daily article counts — the more sharply spiked in time, the higher the rank. Each topic shows its auto-generated label (or color swatch if Haiku declined), peak date, peak count, burstiness, and size.
- Tap a Bursty Topic → focuses it (cluster mates outlined in white) → "What's this story?" button generates a Sonnet research-mode summary of 12 representative chunks sampled evenly across the cluster's date range. **Cached** in the `clusters.story_text` column — same cluster ever after, free.
- Tap any individual dot → chunk detail panel with content, paper, date, cluster label, and the same "What's this cluster's story?" button.
- **Map search**: free-text Postgres FTS over all chunks; matches highlighted with gold rings on the map.
- **Date window** filter with width presets (1 wk / 2 wk / 1 mo / All) and a sliding window that lets you scrub through the corpus over time.
- **Content filter** toggles (Content / Ad / Legal / Bad OCR) classified heuristically during the clustering batch job.
- **Outlier toggle** to show/hide HDBSCAN's noise cluster (label -1) — often dominated by garbled OCR.

---

## Pipeline architecture

### Ingest (Python CLI, GitHub Actions workflow)
- `herald ingest --lccn X --from D --to D [--sample-days "1,15"]`
- Pulls from Chronicling America via the loc.gov JSON API.
- Voyage AI `voyage-3.5` embeddings, 1024 dim, batched at 128.
- Stores in Supabase Postgres (`papers / issues / pages / chunks`) with HNSW + GIN indexes.
- **Sparse mode** added post-plan: pick specific days of each month (e.g., 1st and 15th) for wide-but-shallow temporal coverage.

### Retrieval (TypeScript, Next.js API route)
- Hybrid: Voyage semantic embedding + Postgres FTS, RRF merged (k=60).
- Voyage `rerank-2.5` over top 80 → top 20.
- MMR diversity for breadth-y queries.
- 12 chunks to Sonnet for synthesis.
- Optional cluster-scope filter that bypasses semantic + FTS and reranks every chunk in the cluster against the question directly.

### Clustering (Python CLI, GitHub Actions workflow)
- `herald cluster` reads all current chunk embeddings.
- HDBSCAN on the raw 1024-dim vectors (not on UMAP output — clustering topology and visualization layout stay decoupled).
- Outliers (label -1) are preserved through all four tiers.
- Agglomerative merge at tiers 1, 2, 3 with **proportional sub-cluster sampling** for label generation: bigger sub-clusters contribute more rep chunks to the Haiku prompt, so the dominant theme drowns out fringe sub-topics.
- UMAP projection to 2D, normalized to [0,1].
- Content classification (content / ad / legal / bad OCR) via heuristic regex + small English word list.
- Auto-labels via Haiku, **rate-limit-paced** at 1.3s between calls to stay under Anthropic's 50 RPM limit.
- `herald relabel` regenerates labels against the active run without re-clustering.

### Synthesis (TypeScript, Next.js API routes)
- Claude Sonnet 4.6 for all chat and cluster-story responses.
- Citation validator catches hallucinated `[N]` markers and retries once with a stronger reminder before failing.

---

## What's blocked

**Library of Congress is now behind Cloudflare bot protection.** This blocks every cloud-IP path:

- **Ingest** from GitHub Actions returns 403. The original Phase 1 ingest succeeded in May, before the protection or before our cumulative request history triggered a block. Subsequent attempts have failed; we've emailed LOC's NDNP team asking for a User-Agent allowlist.
- **Image proxy** through Vercel returns 502 / Cloudflare challenge HTML. We removed the proxy.
- **Inline `<img>` from the user's browser** also gets Cloudflare HTML instead of an image (img tags can't solve JS challenges).
- **Iframing the LOC page** gets blocked by their `X-Frame-Options: DENY`.

The viewer is now an honest fallback card with an "Open on Library of Congress" button. Users solve the Cloudflare challenge once in a new tab.

**5¢ Cleanup (Phase 3)** is deferred until ingest/image access is restored, because the vision OCR worker needs to fetch page images from LOC.

---

## What grew beyond plan

- **Whole `/explore` page** — hierarchical clustering, burstiness, weighted centroids, cluster stories, map search, click feedback. None of this was in the original Phase 1/2 plans.
- **Response modes** — Synthesis/Research/Directory wasn't planned; the original plan had a single synthesis prompt.
- **Cluster auto-labels with size-weighted sampling** — the NYC effect was specifically requested as a constraint mid-iteration.
- **Cluster story caching** — added once we noticed users would re-ask the same questions and Haiku/Sonnet costs would compound.

---

## What's next

See `docs/PLAN.md` for the original three-phase roadmap (Phase 3 still deferred). The active candidates for the *next* increment:

1. **Map-to-chat bridge** — restore the "Search within cluster" navigation that we removed when it felt non-intuitive, but make it more discoverable.
2. **Annotations / favorites** — let users mark clusters they've explored and add notes. localStorage first, DB later.
3. **Broader-tier label quality** — labels at tier 2 and 3 are still noisier than tier 0/1 even after weighted sampling. Consider only labeling fine tiers, or doing a separate prompt that asks for an umbrella theme.
4. **LOC unblock follow-up** — when (if) LOC responds and access is restored, ship Phase 3 as designed (auth, Stripe, vision Cleanup) and resume corpus expansion.
