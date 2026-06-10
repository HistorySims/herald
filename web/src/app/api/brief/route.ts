// POST /api/brief — Research Brief orchestrator.
//
// Phase 1 flow:
//   1. Haiku translates the modern research question into 1840s
//      vocabulary, names, places, candidate date ranges, and short
//      search phrases.
//   2. Voyage embeds the restated question + the top search phrases.
//   3. Cluster matching (FINE tier = 0):
//        - cosine similarity of each cluster centroid to the averaged
//          query embedding
//        - FTS hits per cluster, by querying match_chunks_fts on each
//          period_term / search_phrase and tallying cluster_t0 of the
//          hits
//        - weighted combine (constants in @/lib/brief)
//   4. Top-N cards: assemble geometry (size, dates, peak week,
//      burstiness, drift, papers, weekly sparkline, shape tag) and
//      roll up via parent_id for medium/broad themes.
//   5. Sonnet writes an orientation paragraph + "suggested next
//      queries" keyed to the restated question and the matched cards.
//
// Out of scope for Phase 1: quarantine mining, entity extraction,
// c-TF-IDF terms, fragment mining. Constants live in lib/brief.ts.

import { NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import { getSupabase } from "@/lib/supabase";
import { embedQueries } from "@/lib/voyage";
import {
  burstinessFromCounts,
  combineRelevance,
  cosineSimilarity,
  deriveShapeTag,
  isoWeekStart,
  MAX_EMBED_PHRASES,
  MAX_FTS_PHRASES,
  meanVector,
  parseCentroid,
  TOP_N_FINE,
  WEAK_RELEVANCE_THRESHOLD,
  type BriefResponse,
  type ClusterCard,
  type ParentEntry,
  type TranslationOutput,
} from "@/lib/brief";
import {
  checkRateLimit,
  clientIp,
  jsonError,
  rateLimitResponse,
} from "@/lib/rate-limit";

export const maxDuration = 60;

const MAX_QUESTION_LENGTH = 500;

const TRANSLATION_SYSTEM = `You are translating a modern academic research question into the vocabulary of 1840s American newspapers (1842-1846, primarily the New-York Daily Tribune and the Albany Evening Journal).

Modern researchers ask questions in modern terms. 1840s papers used the names, places, idioms, and legal vocabulary of their day. To match the corpus well, we need both registers.

Return ONLY raw JSON (no markdown fences, no commentary) with these fields:
{
  "period_terms": ["3-10 short phrases a period newspaper would actually have printed"],
  "likely_entities": ["proper names (people, places, organizations) likely to appear in coverage"],
  "candidate_date_ranges": ["zero or more strings like '1845-07 to 1845-09'; empty array if no date hint"],
  "search_phrases": ["3-6 short query strings in period diction, suitable for full-text search"],
  "restated_question": "one-sentence neutral restatement, preserving the historian's intent"
}

Guidance:
- period_terms should be CONTEMPORARY language: "distress warrant" not "judicial seizure of property"; "rent in arrears" not "rent delinquency"; "anti-renters" not "tenant activists".
- likely_entities should be specific people, papers, places, or organizations from that era when the question's subject suggests them.
- For events with known date windows (Anti-Rent disturbances peaked summer 1845), include the range; otherwise leave the array empty rather than guessing.
- search_phrases are what you'd actually type into Chronicling America's search box.
- restated_question is in plain modern English but neutral — strip rhetorical framing.

Output JSON only.`;

const ORIENTATION_SYSTEM = `You are writing a one-paragraph orientation for a research brief over 1840s New York newspapers (New-York Daily Tribune, Albany Evening Journal; 1842-1846).

You will receive: the researcher's restated question, and a ranked list of clusters our system matched, each with a label, a shape tag describing how the coverage behaves over time, member size, date span, and contributing papers.

Write:

1. A short ORIENTATION paragraph (3-6 sentences) keyed to the question. Name the top 2-3 clusters by their labels, summarize what their shape tags imply about how the story unfolded, and call out any divergence between papers if it is visible in their contribution percentages. Do NOT invent facts the data does not support. If confidence_low is true, lead with that caveat plainly.

2. A NEXT QUERIES section: 3-5 concrete follow-up queries, mixing:
   - in-tool queries (questions the researcher could ask the chat with a cluster scope)
   - external queries (suggested phrases to paste into chroniclingamerica.loc.gov/search/ for coverage beyond this corpus)

Format your response EXACTLY as:

ORIENTATION:
<your paragraph>

NEXT_QUERIES:
- <query 1>
- <query 2>
- ...

Do not add markdown headers, citations, or commentary outside this structure.`;

interface ClusterRow {
  id: string;
  label: number;
  size: number;
  centroid: number[] | string | null;
  date_min: string | null;
  date_max: string | null;
  parent_id: string | null;
  label_text: string | null;
  drift_cumulative: number | null;
  drift_net: number | null;
  drift_weeks: number | null;
}

interface FtsHit {
  chunk_id: string;
}

interface MemberRow {
  chunk_id: string;
  chunks: {
    status: string | null;
    pages: {
      issues: {
        date_issued: string;
        papers: { lccn: string; title: string } | null;
      } | null;
    } | null;
  } | null;
}

export async function POST(req: NextRequest) {
  if (!checkRateLimit("brief", clientIp(req))) {
    return rateLimitResponse();
  }

  let body: { question?: string };
  try {
    body = await req.json();
  } catch {
    return jsonError("Invalid JSON body", 400);
  }
  const question = body.question?.trim();
  if (!question) return jsonError("Missing question", 400);
  if (question.length > MAX_QUESTION_LENGTH) {
    return jsonError(
      `Question exceeds ${MAX_QUESTION_LENGTH} character limit`,
      400,
    );
  }

  const anthropic = getAnthropic();
  const supabase = getSupabase();

  // ---- 1. Translation ---------------------------------------------------
  const translation = await translateQuestion(anthropic, question);

  // ---- 2. Embed restated question + search phrases ----------------------
  const phrases = [
    translation.restated_question,
    ...translation.search_phrases.slice(0, MAX_EMBED_PHRASES - 1),
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  if (phrases.length === 0) {
    return jsonError("Translation produced no usable phrases", 500);
  }
  const embeddings = await embedQueries(phrases);
  const queryVector = meanVector(embeddings);

  // ---- 3. Active cluster run --------------------------------------------
  const { data: activeRun } = await supabase
    .from("active_cluster_run")
    .select("run_id")
    .single();
  if (!activeRun) {
    return jsonError("No active cluster run", 404);
  }
  const runId = activeRun.run_id;

  // ---- 4. Load fine clusters + parents (all tiers) ----------------------
  const clusters = await loadAllClusters(supabase, runId);
  const fineClusters = clusters.filter((c) => c.tier === 0);
  const clusterById = new Map<string, ClusterRow & { tier: number }>();
  for (const c of clusters) clusterById.set(c.id, c);

  // ---- 5. Centroid scoring on fine tier ---------------------------------
  // cosine sim → in [-1, 1]; clamp to [0, 1] for combine.
  const semanticByLabel = new Map<number, number>();
  for (const c of fineClusters) {
    const vec = parseCentroid(c.centroid);
    if (!vec || vec.length !== queryVector.length) continue;
    const sim = cosineSimilarity(queryVector, vec);
    semanticByLabel.set(c.label, Math.max(0, sim));
  }

  // ---- 6. FTS scoring: count hits per fine cluster ----------------------
  const ftsPhrases = uniqueShortPhrases(
    [...translation.search_phrases, ...translation.period_terms],
    MAX_FTS_PHRASES,
  );
  const ftsHitsByLabel = await ftsHitsPerFineCluster(
    supabase,
    runId,
    ftsPhrases,
  );

  // ---- 7. Combine + pick top N -----------------------------------------
  const maxFtsHits = Math.max(1, ...Array.from(ftsHitsByLabel.values()));
  const maxSemantic = Math.max(
    1e-9,
    ...Array.from(semanticByLabel.values()),
  );

  const scored = fineClusters.map((c) => {
    const sem = semanticByLabel.get(c.label) ?? 0;
    const fts = ftsHitsByLabel.get(c.label) ?? 0;
    const semNorm = sem / maxSemantic;
    const ftsNorm = Math.log1p(fts) / Math.log1p(maxFtsHits);
    return {
      cluster: c,
      relevance: combineRelevance(semNorm, ftsNorm),
      semantic_sim: sem,
      fts_hits: fts,
    };
  });
  scored.sort((a, b) => b.relevance - a.relevance);
  const top = scored.slice(0, TOP_N_FINE);

  // ---- 8. Build cards ---------------------------------------------------
  const cards: ClusterCard[] = [];
  for (const entry of top) {
    const card = await buildCard(
      supabase,
      runId,
      entry.cluster,
      clusterById,
      entry.relevance,
      entry.semantic_sim,
      entry.fts_hits,
    );
    if (card) cards.push(card);
  }

  // ---- 9. Confidence guard ----------------------------------------------
  const topRelevance = cards.length > 0 ? cards[0].relevance : 0;
  const confidence_low = topRelevance < WEAK_RELEVANCE_THRESHOLD;
  const confidence_message = confidence_low
    ? "Your question matches this corpus weakly. The clusters below are the nearest themes we found; treat the orientation as a sketch rather than an answer."
    : null;

  // ---- 10. Sonnet orientation + next queries ----------------------------
  const { orientation, next_queries } = await composeBrief(
    anthropic,
    translation.restated_question,
    cards,
    confidence_low,
  );

  const response: BriefResponse = {
    translation,
    orientation,
    next_queries,
    cards,
    confidence_low,
    confidence_message,
    generated_at: new Date().toISOString(),
  };

  return Response.json(response, {
    headers: { "Cache-Control": "no-store" },
  });
}

// ===================== helpers =====================

function getAnthropic(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("Missing ANTHROPIC_API_KEY");
  return new Anthropic({ apiKey: key });
}

async function translateQuestion(
  anthropic: Anthropic,
  question: string,
): Promise<TranslationOutput> {
  const resp = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 800,
    temperature: 0,
    system: TRANSLATION_SYSTEM,
    messages: [{ role: "user", content: question }],
  });
  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("")
    .trim();
  const json = stripJsonFence(text);
  let parsed: Partial<TranslationOutput>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error(`Translation returned non-JSON: ${text.slice(0, 200)}`);
  }
  return {
    period_terms: asStrings(parsed.period_terms),
    likely_entities: asStrings(parsed.likely_entities),
    candidate_date_ranges: asStrings(parsed.candidate_date_ranges),
    search_phrases: asStrings(parsed.search_phrases),
    restated_question:
      typeof parsed.restated_question === "string" && parsed.restated_question.trim()
        ? parsed.restated_question.trim()
        : question,
  };
}

function stripJsonFence(s: string): string {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (m ? m[1] : s).trim();
}

function asStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqueShortPhrases(phrases: string[], cap: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of phrases) {
    const k = p.trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p.trim());
    if (out.length >= cap) break;
  }
  return out;
}

async function loadAllClusters(
  supabase: ReturnType<typeof getSupabase>,
  runId: string,
): Promise<(ClusterRow & { tier: number })[]> {
  const out: (ClusterRow & { tier: number })[] = [];
  const pageSize = 500;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("clusters")
      .select(
        "id, tier, label, size, centroid, date_min, date_max, parent_id, label_text, drift_cumulative, drift_net, drift_weeks",
      )
      .eq("run_id", runId)
      .order("tier")
      .order("label")
      .range(offset, offset + pageSize - 1);
    if (error) throw new Error(`load clusters: ${error.message}`);
    if (!data || data.length === 0) break;
    out.push(...(data as unknown as (ClusterRow & { tier: number })[]));
    if (data.length < pageSize) break;
    offset += pageSize;
  }
  return out;
}

async function ftsHitsPerFineCluster(
  supabase: ReturnType<typeof getSupabase>,
  runId: string,
  phrases: string[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (phrases.length === 0) return counts;

  const chunkIds = new Set<string>();
  for (const phrase of phrases) {
    const { data, error } = await supabase.rpc("match_chunks_fts", {
      query: phrase,
      match_count: 200,
      filter_paper_lccn: null,
      filter_date_from: null,
      filter_date_to: null,
    });
    if (error) continue; // tolerate per-phrase FTS errors
    for (const r of (data ?? []) as FtsHit[]) chunkIds.add(r.chunk_id);
  }
  if (chunkIds.size === 0) return counts;

  // Map chunk_ids → cluster_t0. Chunk the IN(...) since
  // PostgREST/URL limits cap large in-lists.
  const idList = Array.from(chunkIds);
  const batch = 200;
  for (let i = 0; i < idList.length; i += batch) {
    const slice = idList.slice(i, i + batch);
    const { data, error } = await supabase
      .from("chunk_projections")
      .select("cluster_t0")
      .eq("run_id", runId)
      .in("chunk_id", slice);
    if (error || !data) continue;
    for (const row of data as { cluster_t0: number }[]) {
      if (row.cluster_t0 < 0) continue;
      counts.set(row.cluster_t0, (counts.get(row.cluster_t0) ?? 0) + 1);
    }
  }
  return counts;
}

async function buildCard(
  supabase: ReturnType<typeof getSupabase>,
  runId: string,
  cluster: ClusterRow & { tier: number },
  clusterById: Map<string, ClusterRow & { tier: number }>,
  relevance: number,
  semantic_sim: number,
  fts_hits: number,
): Promise<ClusterCard | null> {
  // Pull active+content_type=0 members for the card geometry. The
  // stored size includes all members; the card only counts the ones
  // that pass the active+content filter.
  const members: { date: string; lccn: string; title: string }[] = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("chunk_projections")
      .select(
        "chunk_id, chunks!inner(status, pages!inner(issues!inner(date_issued, papers!inner(lccn, title))))",
      )
      .eq("run_id", runId)
      .eq("cluster_t0", cluster.label)
      .eq("content_type", 0)
      .range(offset, offset + pageSize - 1);
    if (error) return null;
    if (!data || data.length === 0) break;
    for (const row of data as unknown as MemberRow[]) {
      if (row.chunks?.status !== "active") continue;
      const d = row.chunks?.pages?.issues?.date_issued;
      const p = row.chunks?.pages?.issues?.papers;
      if (!d || !p) continue;
      members.push({ date: d, lccn: p.lccn, title: p.title });
    }
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  // Weekly counts (ISO week start, Monday).
  const weeklyMap = new Map<string, number>();
  for (const m of members) {
    const wk = isoWeekStart(new Date(m.date));
    weeklyMap.set(wk, (weeklyMap.get(wk) ?? 0) + 1);
  }
  const weekly_counts = Array.from(weeklyMap.entries())
    .map(([week, count]) => ({ week, count }))
    .sort((a, b) => a.week.localeCompare(b.week));

  let peak_week: string | null = null;
  let peak_count = 0;
  for (const w of weekly_counts) {
    if (w.count > peak_count) {
      peak_count = w.count;
      peak_week = w.week;
    }
  }

  // Paper proportions (active+content only).
  const papersMap = new Map<string, { title: string; count: number }>();
  for (const m of members) {
    const cur = papersMap.get(m.lccn);
    if (cur) cur.count += 1;
    else papersMap.set(m.lccn, { title: m.title, count: 1 });
  }
  const papers = Array.from(papersMap.entries())
    .map(([lccn, v]) => ({
      lccn,
      title: v.title,
      count: v.count,
      share: members.length > 0 ? v.count / members.length : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const burstiness = burstinessFromCounts(weekly_counts.map((w) => w.count));
  const drift_ratio =
    cluster.drift_cumulative && cluster.drift_cumulative > 1e-9
      ? Math.min(1, (cluster.drift_net ?? 0) / cluster.drift_cumulative)
      : null;
  const weeks = weekly_counts.length;

  const shape = deriveShapeTag(
    burstiness,
    drift_ratio,
    cluster.drift_cumulative,
    weeks,
  );

  // Parent chain via parent_id.
  const parent_chain: ParentEntry[] = [];
  let cursor: (ClusterRow & { tier: number }) | null = cluster;
  const seen = new Set<string>();
  while (cursor?.parent_id) {
    if (seen.has(cursor.parent_id)) break;
    seen.add(cursor.parent_id);
    const next: (ClusterRow & { tier: number }) | null =
      clusterById.get(cursor.parent_id) ?? null;
    if (!next) break;
    parent_chain.push({
      tier: next.tier,
      label: next.label,
      label_text: next.label_text,
    });
    cursor = next;
  }

  return {
    tier: 0,
    label: cluster.label,
    label_text: cluster.label_text,
    size: cluster.size,
    active_size: members.length,
    date_min: cluster.date_min ?? "",
    date_max: cluster.date_max ?? "",
    peak_week,
    peak_count,
    burstiness,
    drift_net: cluster.drift_net,
    drift_cumulative: cluster.drift_cumulative,
    drift_ratio,
    weeks,
    papers,
    weekly_counts,
    shape_tag: shape.tag,
    shape_explanation: shape.explanation,
    parent_chain,
    relevance,
    semantic_sim,
    fts_hits,
  };
}

async function composeBrief(
  anthropic: Anthropic,
  restated: string,
  cards: ClusterCard[],
  confidence_low: boolean,
): Promise<{ orientation: string; next_queries: string[] }> {
  if (cards.length === 0) {
    return {
      orientation:
        "No clusters in the active run matched this question with enough signal to characterize. The corpus may not cover this topic, or the question needs rephrasing in period vocabulary.",
      next_queries: [],
    };
  }
  const userMsg = buildOrientationUserMessage(restated, cards, confidence_low);
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 900,
    temperature: 0.2,
    system: ORIENTATION_SYSTEM,
    messages: [{ role: "user", content: userMsg }],
  });
  const text = resp.content
    .filter((b) => b.type === "text")
    .map((b) => (b as Anthropic.TextBlock).text)
    .join("")
    .trim();
  return parseOrientationOutput(text);
}

function buildOrientationUserMessage(
  restated: string,
  cards: ClusterCard[],
  confidence_low: boolean,
): string {
  const lines: string[] = [];
  lines.push(`RESTATED QUESTION: ${restated}`);
  lines.push(`confidence_low: ${confidence_low}`);
  lines.push("");
  lines.push("MATCHED CLUSTERS (ranked):");
  cards.forEach((c, i) => {
    const label = c.label_text ?? `(unlabeled cluster #${c.label})`;
    const dateSpan = `${c.date_min || "?"} → ${c.date_max || "?"}`;
    const paperBlurb = c.papers
      .slice(0, 3)
      .map((p) => `${p.title} ${(p.share * 100).toFixed(0)}%`)
      .join(", ");
    const ratio = c.drift_ratio !== null ? c.drift_ratio.toFixed(2) : "—";
    lines.push(
      `${i + 1}. ${label} — shape=${c.shape_tag}; n=${c.active_size}/${c.size}; ` +
        `${dateSpan}; weeks=${c.weeks}; burst=${c.burstiness.toFixed(2)}; ` +
        `ratio=${ratio}; papers=[${paperBlurb}]; relevance=${c.relevance.toFixed(2)}`,
    );
    if (c.parent_chain.length > 0) {
      const chain = c.parent_chain
        .map((p) => p.label_text ?? `tier${p.tier}#${p.label}`)
        .join(" → ");
      lines.push(`     parent themes: ${chain}`);
    }
  });
  return lines.join("\n");
}

function parseOrientationOutput(text: string): {
  orientation: string;
  next_queries: string[];
} {
  // Split on the two labels. Be lenient with whitespace / extra colons.
  const ori = text.match(/ORIENTATION:\s*([\s\S]*?)(?:\n\s*NEXT_QUERIES:|$)/i);
  const nq = text.match(/NEXT_QUERIES:\s*([\s\S]*)$/i);
  const orientation = ori?.[1]?.trim() ?? text.trim();
  const queriesBlock = nq?.[1]?.trim() ?? "";
  const next_queries = queriesBlock
    .split("\n")
    .map((line) => line.replace(/^[-*\d.\s]+/, "").trim())
    .filter(Boolean);
  return { orientation, next_queries };
}
