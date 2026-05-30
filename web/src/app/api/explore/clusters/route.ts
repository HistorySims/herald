import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  const tier = parseInt(request.nextUrl.searchParams.get("tier") ?? "0", 10);
  if (tier < 0 || tier > 3 || isNaN(tier)) {
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

  const { data, error } = await supabase
    .from("clusters")
    .select("label, size, date_min, date_max, parent_id, label_text")
    .eq("run_id", activeRun.run_id)
    .eq("tier", tier)
    .order("label");

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data ?? [], {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
