import { NextRequest } from "next/server";
import { retrieve, retrieveScoped } from "@/lib/retrieval";
import { synthesizeStream } from "@/lib/synth";
import type { AskRequest } from "@/lib/types";

const MAX_QUESTION_LENGTH = 500;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;

const ipBuckets = new Map<string, number[]>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const timestamps = ipBuckets.get(ip) ?? [];
  const recent = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    ipBuckets.set(ip, recent);
    return false;
  }
  recent.push(now);
  ipBuckets.set(ip, recent);
  return true;
}

export async function POST(req: NextRequest) {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";

  if (!checkRateLimit(ip)) {
    return new Response(
      JSON.stringify({ error: "Rate limit exceeded. Try again in a minute." }),
      { status: 429, headers: { "Retry-After": "60", "Content-Type": "application/json" } }
    );
  }

  let body: AskRequest;
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const { question, mode, paper_lccn, date_from, date_to, scope_tier, scope_label } = body;

  if (!question || typeof question !== "string") {
    return new Response(
      JSON.stringify({ error: "Missing or invalid 'question' field" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    return new Response(
      JSON.stringify({
        error: `Question exceeds ${MAX_QUESTION_LENGTH} character limit`,
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const isScoped =
          scope_tier !== null && scope_tier !== undefined &&
          scope_label !== null && scope_label !== undefined;
        const chunks = isScoped
          ? await retrieveScoped(question, scope_tier!, scope_label!)
          : await retrieve(question, {
              paperLccn: paper_lccn ?? null,
              dateFrom: date_from ?? null,
              dateTo: date_to ?? null,
            });

        for await (const event of synthesizeStream(question, chunks, mode)) {
          if (event.type === "token") {
            controller.enqueue(
              encoder.encode(`event: token\ndata: ${JSON.stringify({ text: event.text })}\n\n`)
            );
          } else {
            controller.enqueue(
              encoder.encode(`event: done\ndata: ${JSON.stringify(event.response)}\n\n`)
            );
          }
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Internal server error";
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
