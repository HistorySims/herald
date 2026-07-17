"use client";

// The dossier's anatomy panel: three bands sharing one time axis.
//
//   Band 1 — coverage volume: a smoothed per-paper streamgraph; each
//     week's slice carries its own opacity (fog-of-war = OCR quality),
//     clipped inside the smooth silhouette so the shape stays sleek.
//   Band 2 — drift path: weekly centroids drawn in a FIXED-SCALE
//     window of corpus UMAP space, so trail length is comparable
//     across clusters (the old version normalized each cluster's own
//     bounding box to fill the panel, which made every cluster look
//     like it traveled corner-to-corner). A locator inset shows where
//     the window sits in the full [0,1]² map; percentile readouts
//     answer "is that a lot?" numerically.
//   Band 3 — week vocabulary: the scrubbed week's c-TF-IDF terms as
//     chips, neighbors dimmed.
//
// One scrubber drives all three. Releasing it never scrolls the page
// — the parent highlights the matching week in the evidence feed and
// offers an explicit "↓ evidence" jump button instead.

import { useId, useMemo } from "react";
import type { DossierChunk, DossierWeek } from "@/lib/dossier";
import { paperColor, qualityOpacity, shortPaperName } from "@/lib/dossier";

const W = 360;
const PAD_X = 14;
const STREAM_H = 84;
const COMET_H = 190;
const TRAIL_COLOR = "#fbbf24";

// Fixed UMAP-space span of the comet window (fraction of the [0,1]
// corpus map). Every cluster renders at this zoom unless its cloud
// genuinely doesn't fit, so trail length is visually comparable
// between dossiers. Tunable.
const COMET_SPAN = 0.35;

interface Props {
  weeks: DossierWeek[];
  papers: { lccn: string; title: string }[];
  chunks: DossierChunk[];
  driftNet: number | null;
  driftRatio: number | null;
  driftNetPct?: number | null;
  driftRatioPct?: number | null;
  weekIndex: number;
  onWeekChange: (i: number) => void;
  onJumpToWeek?: () => void;
}

// ---- geometry helpers ---------------------------------------------------

type Pt = [number, number];

/** Catmull-Rom → cubic Bézier "C" segments (no leading M). */
function curveSegs(pts: Pt[]): string {
  if (pts.length < 2) return "";
  const out: string[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    out.push(
      `C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${p2[0].toFixed(2)},${p2[1].toFixed(2)}`,
    );
  }
  return out.join(" ");
}

function smoothOpenPath(pts: Pt[]): string {
  if (pts.length === 0) return "";
  return `M${pts[0][0].toFixed(2)},${pts[0][1].toFixed(2)} ${curveSegs(pts)}`;
}

/** Closed area between a smoothed top edge and a smoothed bottom edge. */
function smoothAreaPath(top: Pt[], bottom: Pt[]): string {
  if (top.length === 0) return "";
  const back = [...bottom].reverse();
  return (
    `M${top[0][0].toFixed(2)},${top[0][1].toFixed(2)} ` +
    curveSegs(top) +
    ` L${back[0][0].toFixed(2)},${back[0][1].toFixed(2)} ` +
    curveSegs(back) +
    " Z"
  );
}

// ---- component ----------------------------------------------------------

export function ClusterAnatomy({
  weeks,
  papers,
  chunks,
  driftNet,
  driftRatio,
  driftNetPct,
  driftRatioPct,
  weekIndex,
  onWeekChange,
  onJumpToWeek,
}: Props) {
  const uid = useId().replace(/[^a-zA-Z0-9]/g, "");
  const n = weeks.length;
  const xAt = (i: number) =>
    n <= 1 ? W / 2 : PAD_X + (i * (W - 2 * PAD_X)) / (n - 1);

  const maxCount = useMemo(
    () => Math.max(1, ...weeks.map((w) => w.chunk_count)),
    [weeks],
  );

  // ---- Band 1 geometry: smoothed silhouette-centered stack ------------
  const stream = useMemo(() => {
    const center = STREAM_H / 2;
    const maxHalf = STREAM_H / 2 - 8;
    // Per paper: smoothed top/bottom edges across weeks.
    const layers = papers.map((p, pi) => {
      const top: Pt[] = [];
      const bottom: Pt[] = [];
      weeks.forEach((w, i) => {
        const total = w.chunk_count;
        const half = (total / maxCount) * maxHalf;
        const t0 = center - half;
        const height = 2 * half;
        let cum = 0;
        for (let q = 0; q < pi; q++) {
          cum += w.count_by_paper[papers[q].lccn] ?? 0;
        }
        const cnt = w.count_by_paper[p.lccn] ?? 0;
        const y0 = t0 + (total > 0 ? (cum / total) * height : 0);
        const y1 = t0 + (total > 0 ? ((cum + cnt) / total) * height : 0);
        top.push([xAt(i), y0]);
        bottom.push([xAt(i), y1]);
      });
      return { paper: p, pi, area: smoothAreaPath(top, bottom) };
    });
    // Per-week quality strips (drawn clipped inside each layer).
    const strips = weeks.map((w, i) => {
      const x0 = i === 0 ? 0 : (xAt(i - 1) + xAt(i)) / 2;
      const x1 = i === n - 1 ? W : (xAt(i) + xAt(i + 1)) / 2;
      return {
        x: x0,
        width: Math.max(0.5, x1 - x0),
        opacity: qualityOpacity(w.mean_ocr_quality ?? 1),
      };
    });
    return { layers, strips };
  }, [weeks, papers, maxCount, n]);

  // ---- Band 2 geometry: fixed-scale UMAP window ------------------------
  const comet = useMemo(() => {
    const xs = chunks.map((c) => c.x);
    const ys = chunks.map((c) => c.y);
    const trailPts = weeks
      .map((w, i) => ({ i, x: w.centroid_x, y: w.centroid_y }))
      .filter((p): p is { i: number; x: number; y: number } =>
        p.x !== null && p.y !== null);
    for (const p of trailPts) {
      xs.push(p.x);
      ys.push(p.y);
    }
    if (xs.length === 0) return null;

    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;

    const innerW = W - 2 * PAD_X;
    const innerH = COMET_H - 2 * PAD_X;
    const aspect = innerW / innerH;
    // Fixed span floor — expand only if the cloud genuinely overflows.
    const spanX = Math.max(
      COMET_SPAN,
      (maxX - minX) * 1.2,
      (maxY - minY) * 1.2 * aspect,
    );
    const spanY = spanX / aspect;
    const x0 = cx - spanX / 2;
    const y0 = cy - spanY / 2;

    const px = (x: number) => PAD_X + ((x - x0) / spanX) * innerW;
    // Flip Y: UMAP y-up → SVG y-down.
    const py = (y: number) => COMET_H - PAD_X - ((y - y0) / spanY) * innerH;

    return {
      px,
      py,
      trail: trailPts.map((p) => ({ i: p.i, X: px(p.x), Y: py(p.y) })),
      window: { x0, y0, spanX, spanY },
    };
  }, [chunks, weeks]);

  const paperIdx = useMemo(() => {
    const m = new Map<string, number>();
    papers.forEach((p, i) => m.set(p.lccn, i));
    return m;
  }, [papers]);

  const current = weeks[weekIndex];
  const prev = weeks[weekIndex - 1];
  const next = weeks[weekIndex + 1];
  if (n === 0) return null;

  const drawnTrail = comet
    ? comet.trail.filter((p) => p.i <= weekIndex)
    : [];
  const marker = drawnTrail.length
    ? drawnTrail[drawnTrail.length - 1]
    : null;
  const grade = (i: number) => (n > 1 ? i / (n - 1) : 1);

  return (
    <div className="space-y-3">
      {/* Paper legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-stone-400">
        {papers.map((p, i) => (
          <span key={p.lccn} className="inline-flex items-center gap-1.5">
            <span
              className="inline-block w-2.5 h-2.5 rounded-full"
              style={{ backgroundColor: paperColor(i) }}
            />
            {shortPaperName(p.title)}
          </span>
        ))}
        <span className="text-stone-600">opacity = OCR quality</span>
      </div>

      {/* Band 1 — coverage volume */}
      <div>
        <div className="text-[10px] uppercase tracking-widest text-stone-500 pb-1">
          Coverage volume
        </div>
        <svg
          viewBox={`0 0 ${W} ${STREAM_H}`}
          className="w-full block rounded-2xl bg-stone-900/80 ring-1 ring-stone-800"
          preserveAspectRatio="none"
        >
          {n === 1
            ? papers.map((p, pi) => {
                const w = weeks[0];
                const total = w.chunk_count || 1;
                const cnt = w.count_by_paper[p.lccn] ?? 0;
                let cum = 0;
                for (let q = 0; q < pi; q++) {
                  cum += w.count_by_paper[papers[q].lccn] ?? 0;
                }
                const half = (STREAM_H - 16) / 2;
                const top = STREAM_H / 2 - half + (cum / total) * 2 * half;
                const h = (cnt / total) * 2 * half;
                return (
                  <rect
                    key={p.lccn}
                    x={W / 2 - 14}
                    width={28}
                    y={top}
                    height={Math.max(1, h)}
                    rx={3}
                    fill={paperColor(pi)}
                    opacity={qualityOpacity(w.mean_ocr_quality ?? 1)}
                  />
                );
              })
            : stream.layers.map(({ paper, pi, area }) => (
                <g key={paper.lccn}>
                  <clipPath id={`${uid}-layer-${pi}`}>
                    <path d={area} />
                  </clipPath>
                  <g clipPath={`url(#${uid}-layer-${pi})`}>
                    {stream.strips.map((s, si) => (
                      <rect
                        key={si}
                        x={s.x}
                        y={0}
                        width={s.width}
                        height={STREAM_H}
                        fill={paperColor(pi)}
                        opacity={s.opacity}
                      />
                    ))}
                  </g>
                </g>
              ))}
          {/* Scrub cursor */}
          <line
            x1={xAt(weekIndex)}
            x2={xAt(weekIndex)}
            y1={4}
            y2={STREAM_H - 4}
            stroke="#fafaf9"
            strokeWidth={1.25}
            strokeLinecap="round"
            opacity={0.85}
          />
        </svg>
      </div>

      {/* Band 2 — drift path */}
      <div>
        <div className="text-[10px] uppercase tracking-widest text-stone-500 pb-1">
          Drift path{" "}
          <span className="normal-case tracking-normal text-stone-600">
            · fixed scale — comparable across clusters
          </span>
        </div>
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${COMET_H}`}
            className="w-full block rounded-2xl bg-stone-900/80 ring-1 ring-stone-800"
          >
            {comet && (
              <>
                {/* Member point-cloud underlay */}
                {chunks.map((c) => (
                  <circle
                    key={c.chunk_id}
                    cx={comet.px(c.x)}
                    cy={comet.py(c.y)}
                    r={1.4}
                    fill={paperColor(paperIdx.get(c.paper_lccn) ?? 0)}
                    opacity={0.1 + 0.16 * c.quality}
                  />
                ))}
                {/* Smoothed route ribbon (full trail, faint) */}
                {comet.trail.length >= 2 && (
                  <path
                    d={smoothOpenPath(comet.trail.map((p) => [p.X, p.Y]))}
                    fill="none"
                    stroke={TRAIL_COLOR}
                    strokeWidth={4}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    opacity={0.12}
                  />
                )}
                {/* Time-graded segments up to the scrubbed week */}
                {drawnTrail.map((p, k) => {
                  if (k === 0) return null;
                  const a = drawnTrail[k - 1];
                  const t = grade(p.i);
                  return (
                    <line
                      key={p.i}
                      x1={a.X}
                      y1={a.Y}
                      x2={p.X}
                      y2={p.Y}
                      stroke={TRAIL_COLOR}
                      strokeWidth={1.25 + 1.75 * t}
                      strokeLinecap="round"
                      opacity={0.25 + 0.65 * t}
                    />
                  );
                })}
                {/* Week dots */}
                {drawnTrail.map((p) => (
                  <circle
                    key={`d${p.i}`}
                    cx={p.X}
                    cy={p.Y}
                    r={1.8}
                    fill={TRAIL_COLOR}
                    opacity={0.3 + 0.6 * grade(p.i)}
                  />
                ))}
                {/* Current-week marker */}
                {marker && (
                  <circle
                    cx={marker.X}
                    cy={marker.Y}
                    r={5}
                    fill={TRAIL_COLOR}
                    stroke="#fafaf9"
                    strokeWidth={1.5}
                  />
                )}
                {/* Locator inset — where this window sits in the full map */}
                <g transform={`translate(${W - 66}, ${COMET_H - 48})`}>
                  <rect
                    width={58}
                    height={40}
                    rx={5}
                    fill="#1c1917"
                    stroke="#44403c"
                    strokeWidth={0.75}
                    opacity={0.92}
                  />
                  <rect
                    x={Math.max(1, Math.min(56, comet.window.x0 * 58))}
                    y={Math.max(
                      1,
                      Math.min(
                        38,
                        (1 - comet.window.y0 - comet.window.spanY) * 40,
                      ),
                    )}
                    width={Math.min(56, comet.window.spanX * 58)}
                    height={Math.min(38, comet.window.spanY * 40)}
                    rx={2}
                    fill="none"
                    stroke={TRAIL_COLOR}
                    strokeWidth={1}
                    opacity={0.9}
                  />
                  <text
                    x={29}
                    y={49}
                    textAnchor="middle"
                    className="fill-stone-600"
                    fontSize={7}
                  >
                    corpus map
                  </text>
                </g>
              </>
            )}
          </svg>
          {/* Honest numbers, with corpus-relative context */}
          <div className="absolute top-2 right-2 text-right text-[10px] font-mono text-stone-400 bg-stone-900/85 rounded-lg px-2 py-1 space-y-0.5">
            <div>
              net drift {driftNet !== null ? driftNet.toFixed(3) : "—"}
              {driftNetPct != null && (
                <span className="text-amber-400/90">
                  {" "}· {Math.round(driftNetPct * 100)}th pctile
                </span>
              )}
            </div>
            <div>
              direction {driftRatio !== null ? driftRatio.toFixed(2) : "—"}
              {driftRatioPct != null && (
                <span className="text-amber-400/90">
                  {" "}· {Math.round(driftRatioPct * 100)}th pctile
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Band 3 — week vocabulary */}
      <div>
        <div className="text-[10px] uppercase tracking-widest text-stone-500 pb-1">
          Week vocabulary
        </div>
        <div className="rounded-2xl bg-stone-900/80 ring-1 ring-stone-800 px-3 py-2.5 min-h-[56px]">
          {current?.top_terms?.length ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              {prev?.top_terms?.slice(0, 2).map((t) => (
                <span
                  key={`p-${t}`}
                  className="text-[10px] text-stone-600 px-1.5 py-0.5 rounded-full ring-1 ring-stone-800"
                >
                  {t}
                </span>
              ))}
              {current.top_terms.map((t) => (
                <span
                  key={t}
                  className="text-sm font-serif text-amber-200 bg-stone-800/80 px-2.5 py-0.5 rounded-full"
                >
                  {t}
                </span>
              ))}
              {next?.top_terms?.slice(0, 2).map((t) => (
                <span
                  key={`n-${t}`}
                  className="text-[10px] text-stone-600 px-1.5 py-0.5 rounded-full ring-1 ring-stone-800"
                >
                  {t}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-stone-600 italic">
              No per-week terms yet — run the Cluster Recompute workflow to
              populate the word river.
            </p>
          )}
        </div>
      </div>

      {/* The scrubber */}
      <div className="space-y-1.5 pt-1">
        <input
          type="range"
          min={0}
          max={n - 1}
          step={1}
          value={weekIndex}
          onChange={(e) => onWeekChange(parseInt(e.target.value, 10))}
          className="w-full h-8 touch-none appearance-none bg-transparent cursor-pointer
            [&::-webkit-slider-runnable-track]:h-1.5
            [&::-webkit-slider-runnable-track]:rounded-full
            [&::-webkit-slider-runnable-track]:bg-stone-800
            [&::-webkit-slider-thumb]:appearance-none
            [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5
            [&::-webkit-slider-thumb]:rounded-full
            [&::-webkit-slider-thumb]:bg-amber-400
            [&::-webkit-slider-thumb]:shadow-md
            [&::-webkit-slider-thumb]:-mt-[7px]
            [&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full
            [&::-moz-range-track]:bg-stone-800
            [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5
            [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0
            [&::-moz-range-thumb]:bg-amber-400"
          aria-label="Scrub week"
        />
        <div className="flex items-center justify-between text-[10px] font-mono text-stone-500">
          <span>{weeks[0].week_start}</span>
          <span className="inline-flex items-center gap-2">
            <span className="text-amber-300">
              {current?.week_start} · {current?.chunk_count}{" "}
              chunk{current?.chunk_count === 1 ? "" : "s"}
            </span>
            {onJumpToWeek && (
              <button
                type="button"
                onClick={onJumpToWeek}
                className="px-2 py-0.5 rounded-full ring-1 ring-stone-700 text-stone-300 active:bg-stone-800"
              >
                ↓ evidence
              </button>
            )}
          </span>
          <span>{weeks[n - 1].week_start}</span>
        </div>
      </div>
    </div>
  );
}
