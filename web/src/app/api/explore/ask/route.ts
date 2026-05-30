import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import { synthesizeStream } from "@/lib/synth";
import type { RankedChunk } from "@/lib/types";

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
      papers: {
        lccn: string;
        title: string;
      } | null;
    } | null;
  } | null;
}

export async function POST(req: NextRequest) {
  let body: { chunk_ids?: string[]; question?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { chunk_ids, question } = body;
  if (!chunk_ids || !Array.isArray(chunk_ids) || chunk_ids.length === 0) {
    return Response.json({ error: "Missing chunk_ids" }, { status: 400 });
  }
  if (!question || typeof question !== "string") {
    return Response.json({ error: "Missing question" }, { status: 400 });
  }
  if (chunk_ids.length > 20) {
    return Response.json(
      { error: "Too many chunks (max 20)" },
      { status: 400 }
    );
  }

  const supabase = getSupabase();
  const { data, error } = await supabase
    .from("chunks")
    .select(
      "id, content, page_id, pages!inner(sequence, image_url, issues!inner(date_issued, edition, papers!inner(lccn, title)))"
    )
    .in("id", chunk_ids);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }
  if (!data || data.length === 0) {
    return Response.json({ error: "No chunks found" }, { status: 404 });
  }

  const rows = data as unknown as ChunkRow[];
  const chunksById = new Map(rows.map((r) => [r.id, r]));

  const chunks: RankedChunk[] = [];
  for (const cid of chunk_ids) {
    const row = chunksById.get(cid);
    if (!row?.pages?.issues?.papers) continue;
    const paper = row.pages.issues.papers;
    const issue = row.pages.issues;
    const page = row.pages;
    chunks.push({
      chunk_id: row.id,
      content: row.content,
      page_id: row.page_id,
      paper_lccn: paper.lccn,
      paper_title: paper.title,
      date_issued: issue.date_issued,
      edition: issue.edition,
      page_sequence: page.sequence,
      image_url: page.image_url,
      resource_url: page.image_url,
      rrf_score: 0,
    });
  }

  if (chunks.length === 0) {
    return Response.json({ error: "Could not assemble chunks" }, { status: 500 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of synthesizeStream(question, chunks, "research")) {
          if (event.type === "token") {
            controller.enqueue(
              encoder.encode(
                `event: token\ndata: ${JSON.stringify({ text: event.text })}\n\n`
              )
            );
          } else {
            controller.enqueue(
              encoder.encode(
                `event: done\ndata: ${JSON.stringify(event.response)}\n\n`
              )
            );
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "Internal error";
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify({ error: message })}\n\n`)
        );
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
