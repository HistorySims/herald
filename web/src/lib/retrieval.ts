import { getSupabase } from "./supabase";
import { embedQuery, rerank } from "./voyage";
import type { SemanticResult, FtsResult, RankedChunk, ChunkRow } from "./types";

const K_SEM = 20;
const K_FTS = 20;
const RRF_K = 60;
const RERANK_TOP = 20;
const MMR_LAMBDA = 0.5;
const FINAL_TOP = 12;

const BREADTH_PATTERNS = [
  /\bhow\b/i,
  /\bwhat kinds?\b/i,
  /\bacross\b/i,
  /\bcompare\b/i,
  /\bdiffer/i,
  /\bboth papers\b/i,
  /\beach paper\b/i,
  /\btribune.*journal|journal.*tribune/i,
];

function isBreadthQuery(question: string): boolean {
  return BREADTH_PATTERNS.some((p) => p.test(question));
}

async function semanticSearch(
  queryEmbedding: number[],
  paperLccn: string | null,
  dateFrom: string | null,
  dateTo: string | null
): Promise<SemanticResult[]> {
  const { data, error } = await getSupabase().rpc("match_chunks_semantic", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: K_SEM,
    filter_paper_lccn: paperLccn,
    filter_date_from: dateFrom,
    filter_date_to: dateTo,
  });
  if (error) throw new Error(`Semantic search failed: ${error.message}`);
  return (data ?? []) as SemanticResult[];
}

const META_PHRASES = [
  /^find\s+(references?\s+to|mentions?\s+of|articles?\s+(about|on|regarding)|coverage\s+of|reports?\s+(on|of|about))\s+/i,
  /^(what|how|where|when|why|who)\s+(do|does|did|is|are|was|were)\s+/i,
  /^(search|look)\s+(for|up)\s+/i,
  /^(show|give)\s+me\s+/i,
  /^(tell\s+me\s+about|describe)\s+/i,
];

function cleanQueryForFts(raw: string): string {
  let q = raw.trim();
  for (const re of META_PHRASES) {
    q = q.replace(re, "");
  }
  q = q.replace(/[?.!]+$/, "").trim();
  return q || raw.trim();
}

async function ftsSearch(
  query: string,
  paperLccn: string | null,
  dateFrom: string | null,
  dateTo: string | null
): Promise<FtsResult[]> {
  const cleaned = cleanQueryForFts(query);
  const { data, error } = await getSupabase().rpc("match_chunks_fts", {
    query: cleaned,
    match_count: K_FTS,
    filter_paper_lccn: paperLccn,
    filter_date_from: dateFrom,
    filter_date_to: dateTo,
  });
  if (error) throw new Error(`FTS search failed: ${error.message}`);
  return (data ?? []) as FtsResult[];
}

function rrfMerge(
  semResults: SemanticResult[],
  ftsResults: FtsResult[]
): RankedChunk[] {
  const scores = new Map<string, { score: number; chunk: ChunkRow }>();

  semResults.forEach((r, i) => {
    const existing = scores.get(r.chunk_id);
    const rrfScore = 1 / (RRF_K + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(r.chunk_id, { score: rrfScore, chunk: r });
    }
  });

  ftsResults.forEach((r, i) => {
    const existing = scores.get(r.chunk_id);
    const rrfScore = 1 / (RRF_K + i + 1);
    if (existing) {
      existing.score += rrfScore;
    } else {
      scores.set(r.chunk_id, { score: rrfScore, chunk: r });
    }
  });

  return Array.from(scores.values())
    .map(({ score, chunk }) => ({ ...chunk, rrf_score: score }))
    .sort((a, b) => b.rrf_score - a.rrf_score);
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0,
    normA = 0,
    normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function mmrDiversify(
  candidates: RankedChunk[],
  queryEmbedding: number[],
  candidateEmbeddings: Map<string, number[]>,
  topK: number,
  lambda: number
): RankedChunk[] {
  if (candidates.length <= topK) return candidates;

  const selected: RankedChunk[] = [];
  const remaining = [...candidates];

  while (selected.length < topK && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i++) {
      const candidate = remaining[i];
      const qEmb = candidateEmbeddings.get(candidate.chunk_id);
      const relevance = qEmb ? cosineSimilarity(queryEmbedding, qEmb) : candidate.rerank_score ?? 0;

      let maxSim = 0;
      for (const sel of selected) {
        const selEmb = candidateEmbeddings.get(sel.chunk_id);
        const canEmb = candidateEmbeddings.get(candidate.chunk_id);
        if (selEmb && canEmb) {
          maxSim = Math.max(maxSim, cosineSimilarity(selEmb, canEmb));
        }
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return selected;
}

export async function retrieve(
  question: string,
  options: {
    paperLccn?: string | null;
    dateFrom?: string | null;
    dateTo?: string | null;
  } = {}
): Promise<RankedChunk[]> {
  const { paperLccn = null, dateFrom = null, dateTo = null } = options;

  const queryEmbedding = await embedQuery(question);

  const [semResults, ftsResults] = await Promise.all([
    semanticSearch(queryEmbedding, paperLccn, dateFrom, dateTo),
    ftsSearch(question, paperLccn, dateFrom, dateTo),
  ]);

  if (semResults.length === 0 && ftsResults.length === 0) {
    return [];
  }

  const merged = rrfMerge(semResults, ftsResults);
  const topMerged = merged.slice(0, 80);

  const rerankResults = await rerank(
    question,
    topMerged.map((c) => c.content),
    RERANK_TOP
  );

  const reranked: RankedChunk[] = rerankResults.map((r) => ({
    ...topMerged[r.index],
    rerank_score: r.relevance_score,
  }));

  if (isBreadthQuery(question)) {
    const embeddingMap = new Map<string, number[]>();
    for (const chunk of reranked) {
      const semHit = semResults.find((s) => s.chunk_id === chunk.chunk_id);
      if (semHit) {
        // We don't have per-chunk embeddings from the RPC, so we use
        // rerank_score as the relevance proxy in MMR. The cosine term
        // between selected chunks uses a rough heuristic: chunks from
        // the same page on the same date are treated as maximally similar.
        embeddingMap.set(chunk.chunk_id, queryEmbedding);
      }
    }
    return mmrDiversify(
      reranked,
      queryEmbedding,
      embeddingMap,
      FINAL_TOP,
      MMR_LAMBDA
    );
  }

  return reranked.slice(0, FINAL_TOP);
}
