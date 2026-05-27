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

  const { data, error } = await supabase
    .from("chunk_projections")
    .select("chunk_id")
    .eq("run_id", activeRun.run_id)
    .order("chunk_id");

  if (error || !data) {
    return Response.json({ error: error?.message ?? "No data" }, { status: 500 });
  }

  return Response.json(
    data.map((r: { chunk_id: string }) => r.chunk_id),
    { headers: { "Cache-Control": "public, max-age=3600" } }
  );
}
