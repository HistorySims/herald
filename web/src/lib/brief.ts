// Types, tuning constants, and helpers for the Research Brief feature.
//
// Phase 1 scope: question intake + translation, cluster matching by
// centroid+FTS, geometry cards from data we already store. Out of
// scope: quarantine mining, entity extraction, c-TF-IDF terms,
// proximity queries, fragment mining.

export interface TranslationOutput {
  period_terms: string[];
  likely_entities: string[];
  candidate_date_ranges: string[];
  search_phrases: string[];
  restated_question: string;
}

export interface ParentEntry {
  tier: number;
  label: number;
  label_text: string | null;
}

export interface PaperShare {
  lccn: string;
  title: string;
  count: number;
  share: number;
}

export interface WeeklyCount {
  // ISO week start (YYYY-MM-DD, Monday of the ISO week)
  week: string;
  count: number;
}

export interface ClusterCard {
  tier: number;
  label: number;
  label_text: string | null;
  size: number;            // stored cluster size (all member chunks)
  active_size: number;     // active + content_type=0 contributing to the card
  date_min: string;
  date_max: string;
  peak_week: string | null;
  peak_count: number;
  burstiness: number;      // CV of weekly counts; null-safe → 0
  drift_net: number | null;
  drift_cumulative: number | null;
  drift_ratio: number | null;
  weeks: number;
  papers: PaperShare[];
  weekly_counts: WeeklyCount[];
  shape_tag: string;
  shape_explanation: string;
  parent_chain: ParentEntry[];
  relevance: number;       // 0..1, weighted blend below
  semantic_sim: number;    // 0..1
  fts_hits: number;        // raw count of FTS matches that fell in this cluster
}

export interface BriefResponse {
  translation: TranslationOutput;
  orientation: string;
  cards: ClusterCard[];
  next_queries: string[];
  confidence_low: boolean;
  confidence_message: string | null;
  generated_at: string;
}

// -------- Tuning constants (Phase 1 defaults; tweak as we learn) ---------

export const TOP_N_FINE = 8;
export const SEMANTIC_WEIGHT = 0.6;
export const FTS_WEIGHT = 0.4;

// "Weak" floor below which the brief must flag low confidence rather
// than fabricate one.
export const WEAK_RELEVANCE_THRESHOLD = 0.25;

// Shape thresholds. Burstiness is CV of weekly chunk counts.
export const BURSTINESS_HIGH = 1.0;
export const BURSTINESS_HEARTBEAT = 0.5;
export const RATIO_HIGH = 0.30;
export const RATIO_LOW = 0.15;
export const SHORT_SPAN_WEEKS = 3;
export const CHURN_CUM_MIN = 1.5;

// Cap how many phrases we feed FTS/embed (token + latency budget).
export const MAX_FTS_PHRASES = 8;
export const MAX_EMBED_PHRASES = 6;

// -------- Helpers ---------------------------------------------------------

export function isoWeekStart(d: Date): string {
  // Monday of the ISO week as YYYY-MM-DD.
  const day = d.getUTCDay() || 7; // Sun=0 → 7
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() - (day - 1));
  return monday.toISOString().slice(0, 10);
}

export function deriveShapeTag(
  burstiness: number,
  drift_ratio: number | null,
  drift_cumulative: number | null,
  weeks: number,
): { tag: string; explanation: string } {
  const ratio = drift_ratio ?? 0;
  const cum = drift_cumulative ?? 0;

  if (burstiness >= BURSTINESS_HIGH && ratio >= RATIO_HIGH) {
    return {
      tag: "Directional evolving story",
      explanation:
        "Coverage spikes and the centroid moves in a coherent direction over time — framing or focus is shifting.",
    };
  }
  if (
    burstiness >= BURSTINESS_HIGH &&
    ratio < RATIO_HIGH &&
    weeks <= SHORT_SPAN_WEEKS
  ) {
    return {
      tag: "Spike-and-decay",
      explanation:
        "One concentrated burst, then drops off. Single event, single framing.",
    };
  }
  if (burstiness < BURSTINESS_HEARTBEAT) {
    return {
      tag: "Heartbeat",
      explanation:
        "Steady background coverage — neither bursty nor evolving. Recurring content.",
    };
  }
  if (cum >= CHURN_CUM_MIN && ratio < RATIO_LOW) {
    return {
      tag: "Churn",
      explanation:
        "High week-to-week variance with no net displacement — a recurring slot whose specific contents rotate (e.g. police court, market reports).",
    };
  }
  return {
    tag: "Topical thread",
    explanation:
      "Moderate burst, moderate movement — a recurring topic that develops gradually.",
  };
}

export function combineRelevance(
  semantic_sim_norm: number,
  fts_hits_norm: number,
): number {
  return SEMANTIC_WEIGHT * semantic_sim_norm + FTS_WEIGHT * fts_hits_norm;
}

// Cosine SIMILARITY (not distance). Defensive on length mismatch.
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  if (denom === 0) return 0;
  return dot / denom;
}

export function meanVector(vecs: number[][]): number[] {
  if (vecs.length === 0) return [];
  const dim = vecs[0].length;
  const out = new Array<number>(dim).fill(0);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) out[i] += v[i];
  }
  for (let i = 0; i < dim; i++) out[i] /= vecs.length;
  return out;
}

export function parseCentroid(c: number[] | string | null): number[] | null {
  if (Array.isArray(c)) return c;
  if (typeof c !== "string") return null;
  try {
    const trimmed = c.trim();
    if (trimmed.startsWith("[")) return JSON.parse(trimmed) as number[];
    return null;
  } catch {
    return null;
  }
}

// Coefficient-of-variation of weekly counts (same shape as the
// explore burstiness metric).
export function burstinessFromCounts(counts: number[]): number {
  if (counts.length === 0) return 0;
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  const mean = total / counts.length;
  const variance =
    counts.reduce((s, c) => s + (c - mean) ** 2, 0) / counts.length;
  const std = Math.sqrt(variance);
  return mean > 0 ? std / mean : 0;
}
