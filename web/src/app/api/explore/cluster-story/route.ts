import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { synthesizeStream } from "@/lib/synth";
import type { RankedChunk, Citation, AskResponse } from "@/lib/types";

const STORY_QUESTION =
  "What story do these passages collectively tell? Summarize the key events, people, places, and dates. Note how the coverage evolves across the dates of the passages.";

const REP_CHUNK_COUNT = 12;

interface ProjectionRow {
  chunk_id: string;
  chunks: {
    pages: { issues: { date_issued: string } | null } | null;
  } | null;
}

interface ChunkRow {
  id: string;
  content: string;
  page_id: string;
  pages: {
    sequence: number;
    image_url: string;
    issues: {
      date_issued: string;
      edition: number;
      papers: { lccn: string; title: string } | null;
    } | null;
  } | null;
}

function pickEvenlyByDate(rows: { chunk_id: string; date: string }[], n: number): string[] {
  if (rows.length <= n) return rows.map((r) => r.chunk_id);
  const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  const step = sorted.length / n;
  const picked: string[] = [];
  for (let k = 0; k < n; k++) {
    const idx = Math.min(Math.floor(k * step), sorted.length - 1);
    picked.push(sorted[idx].chunk_id);
  }
  return Array.from(new Set(picked));
}

export async function POST(req: NextRequest) {
  let body: { tier?: number; label?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { tier, label } = body;
  if (
    tier === undefined ||
    tier === null ||
    label === undefined ||
    label === null
  ) {
    return Response.json({ error: "Missing tier or label" }, { status: 400 });
  }
  if (tier < 0 || tier > 3) {
    return Response.json({ error: "tier must be 0-3" }, { status: 400 });
  }

  const supabase = getSupabase();
  const { data: activeRun, error: runError } = await supabase
    .from("active_cluster_run")
    .select("run_id")
    .single();
  if (runError || !activeRun) {
    return Response.json({ error: "No active cluster run" }, { status: 404 });
  }
  const runId = activeRun.run_id;

  const { data: cluster, error: clusterError } = await supabase
    .from("clusters")
    .select("id, story_text, story_citations")
    .eq("run_id", runId)
    .eq("tier", tier)
    .eq("label", label)
    .single();

  if (clusterError || !cluster) {
    return Response.json({ error: "Cluster not found" }, { status: 404 });
  }

  const encoder = new TextEncoder();

  if (cluster.story_text) {
    const cached: AskResponse = {
      text: cluster.story_text,
      citations: (cluster.story_citations ?? []) as Citation[],
      refused: false,
      input_tokens: 0,
      output_tokens: 0,
    };
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: token\ndata: ${JSON.stringify({ text: cached.text })}\n\n`
          )
        );
        controller.enqueue(
          encoder.encode(`event: done\ndata: ${JSON.stringify(cached)}\n\n`)
        );
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "X-Cache": "HIT",
      },
    });
  }

  const tierCol = `cluster_t${tier}` as
    | "cluster_t0" | "cluster_t1" | "cluster_t2" | "cluster_t3";

  const all: { chunk_id: string; date: string }[] = [];
  const pageSize = 1000;
  let offset = 0;
  while (true) {
    const { data, error } = await supabase
      .from("chunk_projections")
      .select(
        "chunk_id, chunks!inner(pages!inner(issues!inner(date_issued)))"
      )
      .eq("run_id", runId)
      .eq(tierCol, label)
      .range(offset, offset + pageSize - 1);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;

    for (const row of data as unknown as ProjectionRow[]) {
      const d = row.chunks?.pages?.issues?.date_issued;
      if (d) all.push({ chunk_id: row.chunk_id, date: d });
    }

    if (data.length < pageSize) break;
    offset += pageSize;
  }

  if (all.length === 0) {
    return Response.json(
      { error: "No chunks found for cluster" },
      { status: 404 }
    );
  }

  const repIds = pickEvenlyByDate(all, REP_CHUNK_COUNT);

  const { data: chunksData, error: chunksErr } = await supabase
    .from("chunks")
    .select(
      "id, content, page_id, pages!inner(sequence, image_url, issues!inner(date_issued, edition, papers!inner(lccn, title)))"
    )
    .in("id", repIds);

  if (chunksErr || !chunksData) {
    return Response.json(
      { error: chunksErr?.message ?? "Failed to load chunks" },
      { status: 500 }
    );
  }

  const chunksById = new Map<string, ChunkRow>();
  for (const c of chunksData as unknown as ChunkRow[]) chunksById.set(c.id, c);

  const chunks: RankedChunk[] = [];
  for (const id of repIds) {
    const row = chunksById.get(id);
    if (!row?.pages?.issues?.papers) continue;
    chunks.push({
      chunk_id: row.id,
      content: row.content,
      page_id: row.page_id,
      paper_lccn: row.pages.issues.papers.lccn,
      paper_title: row.pages.issues.papers.title,
      date_issued: row.pages.issues.date_issued,
      edition: row.pages.issues.edition,
      page_sequence: row.pages.sequence,
      image_url: row.pages.image_url,
      resource_url: row.pages.image_url,
      rrf_score: 0,
    });
  }

  if (chunks.length === 0) {
    return Response.json(
      { error: "Could not assemble chunks" },
      { status: 500 }
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      let finalResponse: AskResponse | null = null;
      try {
        for await (const event of synthesizeStream(
          STORY_QUESTION,
          chunks,
          "research"
        )) {
          if (event.type === "token") {
            controller.enqueue(
              encoder.encode(
                `event: token\ndata: ${JSON.stringify({ text: event.text })}\n\n`
              )
            );
          } else {
            finalResponse = event.response;
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify(event.response)}\n\n`
              )
            );
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Internal error";
        controller.enqueue(
          encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: message })}\n\n`
          )
        );
      } finally {
        controller.close();
      }

      if (finalResponse && !finalResponse.refused) {
        try {
          await supabase
            .from("clusters")
            .update({
              story_text: finalResponse.text,
              story_citations: finalResponse.citations,
              story_generated_at: new Date().toISOString(),
            })
            .eq("id", cluster.id);
        } catch {
          // Best-effort cache write; don't block the stream
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Cache": "MISS",
    },
  });
}
