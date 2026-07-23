import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";
import {
  checkRateLimit,
  clientIp,
  jsonError,
  rateLimitResponse,
} from "@/lib/rate-limit";

export async function GET(request: NextRequest) {
  if (!checkRateLimit("explore-read", clientIp(request))) {
    return rateLimitResponse();
  }

  const tier = parseInt(request.nextUrl.searchParams.get("tier") ?? "0", 10);
  if (tier < 0 || tier > 3 || isNaN(tier)) {
    return jsonError("tier must be 0-3", 400);
  }

  const supabase = getSupabase();

  const { data: activeRun, error: runError } = await supabase
    .from("active_cluster_run")
    .select("run_id")
    .single();

  if (runError || !activeRun) {
    return jsonError("No active cluster run", 404);
  }

  const COLS_WITH_DRIFT =
    "id, label, size, date_min, date_max, parent_id, label_text, " +
    "drift_net, drift_cumulative";
  const COLS_BASE =
    "id, label, size, date_min, date_max, parent_id, label_text";

  const query = (cols: string) =>
    supabase
      .from("clusters")
      .select(cols)
      .eq("run_id", activeRun.run_id)
      .eq("tier", tier)
      .order("label");

  const primary = await query(COLS_WITH_DRIFT);
  // Fall back to the base columns if the drift columns aren't present
  // (a database that predates migration 0007).
  const result = primary.error ? await query(COLS_BASE) : primary;
  if (result.error) {
    return jsonError(result.error.message, 500);
  }

  return Response.json(result.data ?? [], {
    headers: { "Cache-Control": "public, max-age=3600" },
  });
}
