import { getSupabase } from "@/lib/supabase";

interface DateRow {
  chunk_id: string;
  date_issued: string;
}

export async function GET() {
  const supabase = getSupabase();

  const { data: activeRun, error: runError } = await supabase
    .from("active_cluster_run")
    .select("run_id")
    .single();

  if (runError || !activeRun) {
    return Response.json({ error: "No active cluster run" }, { status: 404 });
  }

  const all: DateRow[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .rpc("get_explore_dates", { active_run: activeRun.run_id })
      .range(offset, offset + pageSize - 1);

    if (error) {
      return Response.json({ error: error.message }, { status: 500 });
    }
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
    offset += pageSize;
  }

  if (all.length === 0) {
    return Response.json({ error: "No date data" }, { status: 404 });
  }

  let minDate = "9999-12-31";
  let maxDate = "0000-01-01";
  for (const row of all) {
    if (row.date_issued < minDate) minDate = row.date_issued;
    if (row.date_issued > maxDate) maxDate = row.date_issued;
  }
  const minDateObj = new Date(minDate);
  const maxOffset = Math.floor(
    (new Date(maxDate).getTime() - minDateObj.getTime()) / (24 * 60 * 60 * 1000)
  );

  const n = all.length;
  const buf = new ArrayBuffer(8 + n * 2);
  const view = new DataView(buf);
  view.setUint32(0, n, true);
  view.setUint32(4, maxOffset, true);

  for (let i = 0; i < n; i++) {
    const d = new Date(all[i].date_issued);
    const off = Math.floor((d.getTime() - minDateObj.getTime()) / (24 * 60 * 60 * 1000));
    view.setUint16(8 + i * 2, off, true);
  }

  return new Response(buf, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Cache-Control": "public, max-age=3600",
      "X-Min-Date": minDate,
      "X-Max-Date": maxDate,
    },
  });
}
