import { getSupabase } from "@/lib/supabase";

export async function GET() {
  const supabase = getSupabase();

  const results: Record<string, unknown> = {};

  const { data: run, error: runErr } = await supabase
    .from("active_cluster_run")
    .select("*")
    .single();
  results.active_cluster_run = { data: run, error: runErr?.message ?? null };

  const { count, error: countErr } = await supabase
    .from("chunk_projections")
    .select("*", { count: "exact", head: true });
  results.chunk_projections_count = { count, error: countErr?.message ?? null };

  const { count: clusterCount, error: clusterErr } = await supabase
    .from("clusters")
    .select("*", { count: "exact", head: true });
  results.clusters_count = { count: clusterCount, error: clusterErr?.message ?? null };

  return Response.json(results);
}
