import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";

const MAX_MATCHES = 5000;
const PAGE = 1000;

export async function GET(request: NextRequest) {
  const q = request.nextUrl.searchParams.get("q")?.trim();
  if (!q) {
    return Response.json({ chunk_ids: [] });
  }

  const supabase = getSupabase();

  const all: string[] = [];
  let offset = 0;
  while (all.length < MAX_MATCHES) {
    const { data, error } = await supabase
      .from("chunks")
      .select("id")
      .eq("is_current", true)
      .textSearch("fts", q, { type: "websearch", config: "english" })
      .order("id")
      .range(offset, offset + PAGE - 1);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;

    all.push(...data.map((r: { id: string }) => r.id));
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  return Response.json(
    { chunk_ids: all },
    { headers: { "Cache-Control": "no-cache" } }
  );
}
