import { NextRequest } from "next/server";
import { getSupabase } from "@/lib/supabase";

export async function GET(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return Response.json({ error: "Missing id parameter" }, { status: 400 });
  }

  const supabase = getSupabase();

  const { data: chunk, error: chunkError } = await supabase
    .from("chunks")
    .select("id, content, page_id")
    .eq("id", id)
    .single();

  if (chunkError || !chunk) {
    return Response.json({ error: "Chunk not found" }, { status: 404 });
  }

  const { data: page, error: pageError } = await supabase
    .from("pages")
    .select("id, sequence, image_url, issue_id")
    .eq("id", chunk.page_id)
    .single();

  if (pageError || !page) {
    return Response.json({ error: "Page not found" }, { status: 404 });
  }

  const { data: issue, error: issueError } = await supabase
    .from("issues")
    .select("id, date_issued, edition, paper_id")
    .eq("id", page.issue_id)
    .single();

  if (issueError || !issue) {
    return Response.json({ error: "Issue not found" }, { status: 404 });
  }

  const { data: paper, error: paperError } = await supabase
    .from("papers")
    .select("lccn, title")
    .eq("id", issue.paper_id)
    .single();

  if (paperError || !paper) {
    return Response.json({ error: "Paper not found" }, { status: 404 });
  }

  const { data: activeRun } = await supabase
    .from("active_cluster_run")
    .select("run_id")
    .single();

  let clusterLabels: number[] = [];
  let contentType = 0;
  if (activeRun) {
    const { data: proj } = await supabase
      .from("chunk_projections")
      .select("cluster_t0, cluster_t1, cluster_t2, cluster_t3, content_type")
      .eq("chunk_id", id)
      .eq("run_id", activeRun.run_id)
      .single();
    if (proj) {
      clusterLabels = [proj.cluster_t0, proj.cluster_t1, proj.cluster_t2, proj.cluster_t3];
      contentType = proj.content_type;
    }
  }

  return Response.json({
    chunk_id: chunk.id,
    content: chunk.content,
    paper_title: paper.title,
    paper_lccn: paper.lccn,
    date_issued: issue.date_issued,
    edition: issue.edition,
    page_sequence: page.sequence,
    image_url: page.image_url,
    cluster_labels: clusterLabels,
    content_type: contentType,
  });
}
