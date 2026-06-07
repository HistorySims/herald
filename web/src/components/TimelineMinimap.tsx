"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TimelineData } from "@/lib/explore-data";
import { clusterColor } from "@/lib/explore-data";

interface TimelineMinimapProps {
  timeline: TimelineData;
  chunkIds: string[] | null;
  tier: number;
  searchMatches: Set<number> | null;
  contentFilter: Set<number>;
  minDate: string;
  onChunkHover?: (chunkIndex: number | null) => void;
  onChunkClick?: (chunkIndex: number) => void;
}

const GUTTER_PX = 8;
const COLUMN_PAD = 2;
const MIN_CHUNK_HEIGHT = 1;
const MAX_CHUNK_HEIGHT = 16;
const DEFAULT_CHUNK_HEIGHT = 2;

interface ColumnEntry {
  /** index into the source timeline arrays (matches chunkIds order) */
  globalIdx: number;
  dateOffset: number;
}

export function TimelineMinimap({
  timeline,
  chunkIds,
  tier,
  searchMatches,
  contentFilter,
  minDate,
  onChunkHover,
  onChunkClick,
}: TimelineMinimapProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [chunkHeight, setChunkHeight] = useState(DEFAULT_CHUNK_HEIGHT);
  const [scrollY, setScrollY] = useState(0);
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  const [hoveredGlobalIdx, setHoveredGlobalIdx] = useState<number | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(
    null
  );

  // The cluster array for the current tier (typed array view, no copy).
  const clusterArr = useMemo(() => {
    switch (tier) {
      case 0: return timeline.clusterT0;
      case 1: return timeline.clusterT1;
      case 2: return timeline.clusterT2;
      case 3: return timeline.clusterT3;
      default: return timeline.clusterT2;
    }
  }, [timeline, tier]);

  // Group chunks into per-paper columns, each chronologically ordered.
  // This is O(N) per filter change. For 26k chunks it's fast enough.
  const columns = useMemo(() => {
    const cols: ColumnEntry[][] = timeline.papers.map(() => []);
    for (let i = 0; i < timeline.count; i++) {
      if (!contentFilter.has(timeline.contentType[i])) continue;
      const colIdx = timeline.paperIdx[i];
      if (colIdx >= cols.length) continue;
      cols[colIdx].push({ globalIdx: i, dateOffset: timeline.dateOffset[i] });
    }
    for (const col of cols) col.sort((a, b) => a.dateOffset - b.dateOffset);
    return cols;
  }, [timeline, contentFilter]);

  // Total visual stack height per column
  const stackHeightsPx = useMemo(
    () => columns.map((col) => col.length * chunkHeight),
    [columns, chunkHeight]
  );

  // Resize the canvas to its CSS box, retina-aware
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const resize = () => {
      const rect = container.getBoundingClientRect();
      setCanvasSize({ w: Math.max(1, rect.width), h: Math.max(1, rect.height) });
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    window.addEventListener("resize", resize);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", resize);
    };
  }, []);

  // Clamp scrollY whenever inputs change
  const maxStackPx = useMemo(
    () => Math.max(0, ...stackHeightsPx),
    [stackHeightsPx]
  );
  const maxScroll = Math.max(0, maxStackPx - canvasSize.h);

  useEffect(() => {
    setScrollY((y) => Math.max(0, Math.min(y, maxScroll)));
  }, [maxScroll]);

  // Wheel: pan vertical; Ctrl/Cmd+wheel = zoom
  const onWheel = useCallback(
    (e: React.WheelEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Zoom around the cursor's chunk
        const canvas = canvasRef.current;
        if (!canvas) return;
        const rect = canvas.getBoundingClientRect();
        const cursorY = e.clientY - rect.top;
        const beforeIdx = (cursorY + scrollY) / chunkHeight;
        const dir = e.deltaY < 0 ? 1.15 : 1 / 1.15;
        const next = Math.max(
          MIN_CHUNK_HEIGHT,
          Math.min(MAX_CHUNK_HEIGHT, chunkHeight * dir)
        );
        setChunkHeight(next);
        // Adjust scroll so cursor stays over the same chunk index
        setScrollY(Math.max(0, beforeIdx * next - cursorY));
      } else {
        setScrollY((y) => Math.max(0, Math.min(maxScroll, y + e.deltaY)));
      }
    },
    [chunkHeight, scrollY, maxScroll]
  );

  // Click-and-drag panning. Listeners attached to `window` (not the
  // canvas) so the drag survives the cursor leaving the canvas during
  // a fast drag.
  const dragState = useRef<{ startY: number; startScroll: number } | null>(null);
  const onMouseDown = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      dragState.current = { startY: e.clientY, startScroll: scrollY };
      const onMove = (ev: MouseEvent) => {
        if (!dragState.current) return;
        const dy = dragState.current.startY - ev.clientY;
        setScrollY(
          Math.max(0, Math.min(maxScroll, dragState.current.startScroll + dy))
        );
      };
      const onUp = () => {
        dragState.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    },
    [scrollY, maxScroll]
  );

  // Hover lookup is O(1): map cursor → column, then column-index → globalIdx
  const indexAt = useCallback(
    (x: number, y: number): number | null => {
      if (canvasSize.w <= 0 || timeline.papers.length === 0) return null;
      const usableW = canvasSize.w - GUTTER_PX;
      const colW = usableW / timeline.papers.length;
      const colIdx = Math.floor((x - GUTTER_PX) / colW);
      if (colIdx < 0 || colIdx >= columns.length) return null;
      const col = columns[colIdx];
      if (col.length === 0) return null;
      const localIdx = Math.floor((y + scrollY) / chunkHeight);
      if (localIdx < 0 || localIdx >= col.length) return null;
      return col[localIdx].globalIdx;
    },
    [canvasSize.w, columns, chunkHeight, scrollY, timeline.papers.length]
  );

  const onMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const idx = indexAt(x, y);
      if (idx !== hoveredGlobalIdx) {
        setHoveredGlobalIdx(idx);
        onChunkHover?.(idx);
      }
      setTooltipPos(idx === null ? null : { x: e.clientX, y: e.clientY });
    },
    [indexAt, hoveredGlobalIdx, onChunkHover]
  );

  const onMouseLeave = useCallback(() => {
    if (hoveredGlobalIdx !== null) {
      setHoveredGlobalIdx(null);
      onChunkHover?.(null);
    }
    setTooltipPos(null);
  }, [hoveredGlobalIdx, onChunkHover]);

  const onClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const canvas = canvasRef.current;
      if (!canvas || !onChunkClick) return;
      const rect = canvas.getBoundingClientRect();
      const idx = indexAt(e.clientX - rect.left, e.clientY - rect.top);
      if (idx !== null) onChunkClick(idx);
    },
    [indexAt, onChunkClick]
  );

  // Drawing — rAF scheduled by useEffect; cancel in cleanup so we don't
  // pile up frames. The effect's deps list is the closure over what the
  // draw function actually uses.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || canvasSize.w === 0 || canvasSize.h === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(canvasSize.w * dpr);
    canvas.height = Math.floor(canvasSize.h * dpr);
    canvas.style.width = `${canvasSize.w}px`;
    canvas.style.height = `${canvasSize.h}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let rafId: number | null = null;
    const draw = () => {
      rafId = null;
      ctx.clearRect(0, 0, canvasSize.w, canvasSize.h);

      // Background
      ctx.fillStyle = "#0f0f0f";
      ctx.fillRect(0, 0, canvasSize.w, canvasSize.h);

      // Column dividers
      const usableW = canvasSize.w - GUTTER_PX;
      const colW = usableW / Math.max(1, timeline.papers.length);
      ctx.fillStyle = "#1a1a1a";
      for (let c = 1; c < timeline.papers.length; c++) {
        const x = GUTTER_PX + c * colW;
        ctx.fillRect(x - 0.5, 0, 1, canvasSize.h);
      }

      // Per column, virtual-window through chunks visible in [0, h]
      for (let c = 0; c < columns.length; c++) {
        const col = columns[c];
        if (col.length === 0) continue;

        // Binary search for the first visible row
        let lo = 0;
        let hi = col.length - 1;
        const firstVisibleY = scrollY;
        const lastVisibleY = scrollY + canvasSize.h;
        const firstRow = Math.max(0, Math.floor(firstVisibleY / chunkHeight));
        const lastRow = Math.min(
          col.length - 1,
          Math.ceil(lastVisibleY / chunkHeight)
        );
        // (using arithmetic instead of binary search since chunks within
        // a column are densely packed at exactly chunkHeight)
        lo = firstRow;
        hi = lastRow;

        const colXStart = GUTTER_PX + c * colW + COLUMN_PAD;
        const colXEnd = GUTTER_PX + (c + 1) * colW - COLUMN_PAD;
        const colWidth = Math.max(1, colXEnd - colXStart);

        for (let row = lo; row <= hi; row++) {
          const entry = col[row];
          const y = row * chunkHeight - scrollY;
          if (y + chunkHeight < 0 || y > canvasSize.h) continue;

          const i = entry.globalIdx;
          const isHit = searchMatches?.has(i) ?? false;

          if (isHit) {
            // Gutter flare on the left edge of this column
            ctx.fillStyle = "#FFA500";
            const flareH = Math.max(2, chunkHeight + 2);
            ctx.fillRect(GUTTER_PX + c * colW, y - 1, 4, flareH);

            ctx.fillStyle = "#FFA500";
            ctx.fillRect(colXStart, y, colWidth, Math.max(1, chunkHeight));
          } else {
            const label = clusterArr[i];
            const [r, g, b] = clusterColor(label);
            // Darken by 1 - quality so worse OCR appears as deeper gray
            const q = timeline.quality[i] / 255;
            const k = Math.max(0.2, Math.min(1, 0.4 + 0.6 * q));
            ctx.fillStyle = `rgb(${Math.round(r * k)}, ${Math.round(g * k)}, ${Math.round(b * k)})`;
            ctx.fillRect(colXStart, y, colWidth, Math.max(1, chunkHeight));
          }
        }
      }

      // Hover ring
      if (hoveredGlobalIdx !== null) {
        const colIdx = timeline.paperIdx[hoveredGlobalIdx];
        const col = columns[colIdx];
        if (col) {
          const localIdx = col.findIndex(
            (e) => e.globalIdx === hoveredGlobalIdx
          );
          if (localIdx >= 0) {
            const y = localIdx * chunkHeight - scrollY;
            const colXStart = GUTTER_PX + colIdx * colW;
            const colXEnd = GUTTER_PX + (colIdx + 1) * colW;
            ctx.strokeStyle = "rgba(255,255,255,0.9)";
            ctx.lineWidth = 1;
            ctx.strokeRect(
              colXStart + 0.5,
              y - 0.5,
              colXEnd - colXStart - 1,
              Math.max(2, chunkHeight) + 1
            );
          }
        }
      }
    };

    rafId = requestAnimationFrame(draw);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [
    canvasSize,
    columns,
    clusterArr,
    timeline,
    searchMatches,
    chunkHeight,
    scrollY,
    hoveredGlobalIdx,
  ]);

  const hoveredChunkInfo = useMemo(() => {
    if (hoveredGlobalIdx === null) return null;
    const idx = hoveredGlobalIdx;
    const paperIdx = timeline.paperIdx[idx];
    const paper = timeline.papers[paperIdx];
    const d = new Date(minDate);
    d.setUTCDate(d.getUTCDate() + timeline.dateOffset[idx]);
    return {
      paper: paper?.title ?? paper?.lccn ?? "—",
      date: d.toISOString().slice(0, 10),
      quality: timeline.quality[idx] / 255,
      cluster: clusterArr[idx],
      chunkId: chunkIds?.[idx] ?? null,
    };
  }, [hoveredGlobalIdx, timeline, chunkIds, clusterArr, minDate]);

  return (
    <div className="relative h-full w-full bg-stone-950" ref={containerRef}>
      {/* Column headers */}
      <div
        className="absolute top-0 left-0 right-0 z-10 flex pointer-events-none"
        style={{ paddingLeft: GUTTER_PX }}
      >
        {timeline.papers.map((p) => (
          <div
            key={p.lccn}
            className="flex-1 px-1 py-0.5 text-[9px] text-stone-500 truncate"
            title={p.title}
          >
            {p.title.replace(/\s*\(.*?\)\s*/g, "").trim()}
          </div>
        ))}
      </div>

      <canvas
        ref={canvasRef}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        onClick={onClick}
        className="block cursor-crosshair select-none"
        style={{ touchAction: "none" }}
      />

      {tooltipPos && hoveredChunkInfo && (
        <div
          className="fixed z-50 pointer-events-none bg-stone-900 border border-stone-700 text-stone-200 text-xs rounded shadow-lg px-2 py-1"
          style={{
            left: tooltipPos.x + 12,
            top: tooltipPos.y + 12,
            maxWidth: 260,
          }}
        >
          <div className="font-mono text-[10px] text-stone-400">
            {hoveredChunkInfo.date}
          </div>
          <div className="truncate">{hoveredChunkInfo.paper}</div>
          <div className="text-stone-500 text-[10px]">
            cluster #{hoveredChunkInfo.cluster} · OCR{" "}
            {Math.round(hoveredChunkInfo.quality * 100)}%
          </div>
        </div>
      )}

      {/* Zoom hint */}
      <div className="absolute bottom-1 left-1 text-[9px] text-stone-600 pointer-events-none">
        ⌘+wheel zoom · drag pan
      </div>
    </div>
  );
}
