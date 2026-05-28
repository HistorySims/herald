import { getSupabase } from "@/lib/supabase";

export async function GET() {
  const supabase = getSupabase();

  const { data: activeRun, error: runError } = await supabase
    .from("active_cluster_run")
    .select("run_id")
    .single();

  if (runError || !activeRun) {
    return Response.json({ error: "No active cluster run" }, { status: 404 });
  }

  const allIds: string[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from("chunk_projections")
      .select("chunk_id")
      .eq("run_id", activeRun.run_id)
      .order("chunk_id")
      .range(offset, offset + pageSize - 1);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;

    allIds.push(...data.map((r: { chunk_id: string }) => r.chunk_id));
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  return Response.json(allIds, {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
