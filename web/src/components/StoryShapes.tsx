"use client";

import type { BurstyTopic } from "@/lib/burstiness";
import { clusterColor } from "@/lib/explore-data";

// A ranked topic carries the temporal stats (client-computed from the
// points binary) plus the DB drift geometry, so one panel can sort by
// any story-shape metric.
export interface RankedTopic extends BurstyTopic {
  driftNet: number | null;
  driftRatio: number | null;
}

export type ShapeSort = "bursty" | "drifting" | "evolving";

const SORTS: { key: ShapeSort; label: string; blurb: string }[] = [
  {
    key: "bursty",
    label: "Bursty",
    blurb: "Sharp temporal spikes — likely emerging stories.",
  },
  {
    key: "drifting",
    label: "Drifting",
    blurb:
      "Coverage vocabulary that traveled farthest end-to-end — the story looks different by the end than the start.",
  },
  {
    key: "evolving",
    label: "Evolving",
    blurb:
      "Movement in a coherent direction (not churn) — a story developing from event to analysis.",
  },
];

interface StoryShapesProps {
  topics: RankedTopic[];
  sort: ShapeSort;
  onSortChange: (s: ShapeSort) => void;
  minDate: string;
  focusedCluster: number | null;
  clusterLabels?: Map<number, string | null>;
  onTopicClick: (topic: RankedTopic) => void;
  onAskClick: (topic: RankedTopic) => void;
}

function offsetToShortDate(minDate: string, offset: number): string {
  const d = new Date(minDate);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function metricLine(t: RankedTopic, sort: ShapeSort, minDate: string): string {
  const peak = `${offsetToShortDate(minDate, t.peakDay)} · peak ${t.peakCount}`;
  if (sort === "drifting") {
    const v = t.driftNet !== null ? t.driftNet.toFixed(3) : "—";
    return `net drift ${v} · n=${t.size}`;
  }
  if (sort === "evolving") {
    const v = t.driftRatio !== null ? t.driftRatio.toFixed(2) : "—";
    return `direction ${v} · n=${t.size}`;
  }
  return `${peak} · B=${t.burstiness.toFixed(2)} · n=${t.size}`;
}

export function StoryShapes({
  topics,
  sort,
  onSortChange,
  minDate,
  focusedCluster,
  clusterLabels,
  onTopicClick,
  onAskClick,
}: StoryShapesProps) {
  const active = SORTS.find((s) => s.key === sort) ?? SORTS[0];

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide">
          Story Shapes
        </h3>
      </div>

      {/* Sort selector */}
      <div className="flex rounded-md bg-stone-800/60 p-0.5 mb-2">
        {SORTS.map((s) => (
          <button
            key={s.key}
            onClick={() => onSortChange(s.key)}
            className={`flex-1 text-[11px] py-1 rounded transition-colors ${
              s.key === sort
                ? "bg-stone-700 text-stone-100"
                : "text-stone-400 hover:text-stone-200"
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      <p className="text-xs text-stone-500 mb-2">{active.blurb}</p>

      {topics.length === 0 ? (
        <p className="text-xs text-stone-600 italic">
          {sort === "bursty"
            ? "No clusters at this tier meet the size floor."
            : "No drift data at this tier — run the Cluster Recompute workflow to populate drift metrics."}
        </p>
      ) : (
        <div className="space-y-1">
          {topics.map((t) => {
            const [r, g, b] = clusterColor(t.cluster);
            const isFocused = focusedCluster === t.cluster;
            const labelText = clusterLabels?.get(t.cluster);
            return (
              <div
                key={t.cluster}
                className={`rounded ${isFocused ? "bg-amber-900/40" : ""}`}
              >
                <button
                  onClick={() => onTopicClick(t)}
                  className={`w-full text-left px-2 py-1.5 rounded-t text-xs transition-colors flex items-start gap-2 ${
                    isFocused
                      ? "text-stone-100"
                      : "text-stone-400 hover:bg-stone-800 hover:text-stone-200"
                  }`}
                >
                  <span
                    className="inline-block w-3 h-3 rounded-full flex-shrink-0 mt-0.5"
                    style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }}
                  />
                  <span className="flex-1 min-w-0">
                    {labelText && (
                      <span className="block text-stone-200 font-medium leading-tight mb-0.5">
                        {labelText}
                      </span>
                    )}
                    <span className="block text-stone-500 text-[10px] font-mono">
                      {metricLine(t, sort, minDate)}
                    </span>
                  </span>
                </button>
                {isFocused && (
                  <button
                    onClick={() => onAskClick(t)}
                    className="w-full text-left px-2 py-1 text-xs text-amber-400 hover:text-amber-300 border-t border-stone-800"
                  >
                    → What&apos;s this story?
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
