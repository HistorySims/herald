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

  const { data: projections, error } = await supabase
    .from("chunk_projections")
    .select("chunk_id")
    .eq("run_id", activeRun.run_id)
    .order("chunk_id");

  if (error || !projections) {
    return Response.json({ error: error?.message ?? "No data" }, { status: 500 });
  }

  const chunkIds = projections.map((r: { chunk_id: string }) => r.chunk_id);

  const { data: chunks, error: chunkError } = await supabase
    .from("chunks")
    .select("id, page_id")
    .in("id", chunkIds);

  if (chunkError || !chunks) {
    return Response.json({ error: chunkError?.message ?? "No chunks" }, { status: 500 });
  }

  const pageIds = [...new Set(chunks.map((c: { page_id: string }) => c.page_id))];

  const { data: pages, error: pageError } = await supabase
    .from("pages")
    .select("id, issue_id")
    .in("id", pageIds);

  if (pageError || !pages) {
    return Response.json({ error: pageError?.message ?? "No pages" }, { status: 500 });
  }

  const issueIds = [...new Set(pages.map((p: { issue_id: string }) => p.issue_id))];

  const { data: issues, error: issueError } = await supabase
    .from("issues")
    .select("id, date_issued")
    .in("id", issueIds);

  if (issueError || !issues) {
    return Response.json({ error: issueError?.message ?? "No issues" }, { status: 500 });
  }

  const issueMap = new Map(issues.map((i: { id: string; date_issued: string }) => [i.id, i.date_issued]));
  const pageToIssue = new Map(pages.map((p: { id: string; issue_id: string }) => [p.id, p.issue_id]));
  const chunkToPage = new Map(chunks.map((c: { id: string; page_id: string }) => [c.id, c.page_id]));

  let minDate = "9999-12-31";
  for (const d of issueMap.values()) {
    if (d < minDate) minDate = d;
  }
  const minDateObj = new Date(minDate);

  const n = chunkIds.length;
  const buf = new ArrayBuffer(4 + n * 2);
  const view = new DataView(buf);
  view.setUint32(0, n, true);

  for (let i = 0; i < n; i++) {
    const cid = chunkIds[i];
    const pid = chunkToPage.get(cid);
    const iid = pid ? pageToIssue.get(pid) : undefined;
    const dateStr = iid ? issueMap.get(iid) : undefined;
    let offset = 0;
    if (dateStr) {
      const d = new Date(dateStr);
      offset = Math.floor((d.getTime() - minDateObj.getTime()) / (24 * 60 * 60 * 1000));
    }
    view.setUint16(4 + i * 2, offset, true);
  }

  return new Response(buf, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "X-Min-Date": minDate,
    },
  });
}
