import { getSupabase } from "@/lib/supabase";

export async function GET() {
  const supabase = getSupabase();

  const { data: activeRun, error: runError } = await supabase
    .from("active_cluster_run")
    .select("run_id")
    .single();

  if (runError || !activeRun) {
    return Response.json(
      { error: `No active cluster run: ${runError?.message ?? "empty result"}` },
      { status: 404 }
    );
  }

  const runId = activeRun.run_id;

  const { data, error } = await supabase
    .from("chunk_projections")
    .select("x, y, cluster_t0, cluster_t1, cluster_t2, cluster_t3, content_type, chunk_id")
    .eq("run_id", runId)
    .order("chunk_id");

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (!data || data.length === 0) {
    return Response.json({ error: "No projection data found" }, { status: 404 });
  }

  const n = data.length;
  // 4 + n*17 bytes for point data, then n*36 bytes for chunk_id strings (UUID without dashes = 32 chars, but we'll use 36 with dashes)
  // Actually, send chunk_ids as a separate JSON array in a header-like structure
  // Format: 4-byte count + n * 17 bytes point data
  const pointBuf = new ArrayBuffer(4 + n * 17);
  const view = new DataView(pointBuf);

  view.setUint32(0, n, true); // little-endian count

  for (let i = 0; i < n; i++) {
    const offset = 4 + i * 17;
    const row = data[i];
    view.setFloat32(offset, row.x, true);
    view.setFloat32(offset + 4, row.y, true);
    view.setUint16(offset + 8, row.cluster_t0, true);
    view.setUint16(offset + 10, row.cluster_t1, true);
    view.setUint16(offset + 12, row.cluster_t2, true);
    view.setUint16(offset + 14, row.cluster_t3, true);
    view.setUint8(offset + 16, row.content_type);
  }

  return new Response(pointBuf, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "X-Run-Id": runId,
    },
  });
}
