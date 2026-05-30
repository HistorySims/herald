"use client";

import type { BurstyTopic } from "@/lib/burstiness";
import { clusterColor } from "@/lib/explore-data";

interface BurstyTopicsProps {
  topics: BurstyTopic[];
  minDate: string;
  focusedCluster: number | null;
  onTopicClick: (topic: BurstyTopic) => void;
  onAskClick: (topic: BurstyTopic) => void;
}

function offsetToShortDate(minDate: string, offset: number): string {
  const d = new Date(minDate);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function BurstyTopics({
  topics,
  minDate,
  focusedCluster,
  onTopicClick,
  onAskClick,
}: BurstyTopicsProps) {
  if (topics.length === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide">
          Bursty Topics
        </h3>
      </div>
      <p className="text-xs text-stone-500 mb-2">
        Clusters with sharp temporal spikes — likely emerging stories.
      </p>
      <div className="space-y-1">
        {topics.map((t) => {
          const [r, g, b] = clusterColor(t.cluster);
          const isFocused = focusedCluster === t.cluster;
          return (
            <div
              key={t.cluster}
              className={`rounded ${isFocused ? "bg-amber-900/40" : ""}`}
            >
              <button
                onClick={() => onTopicClick(t)}
                className={`w-full text-left px-2 py-1.5 rounded-t text-xs transition-colors flex items-center gap-2 ${
                  isFocused
                    ? "text-stone-100"
                    : "text-stone-400 hover:bg-stone-800 hover:text-stone-200"
                }`}
              >
                <span
                  className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                  style={{ backgroundColor: `rgb(${r}, ${g}, ${b})` }}
                />
                <span className="flex-1">
                  <span className="font-mono">
                    {offsetToShortDate(minDate, t.peakDay)}
                  </span>{" "}
                  &middot; peak {t.peakCount}
                </span>
                <span className="text-stone-500 text-[10px] flex-shrink-0">
                  B={t.burstiness.toFixed(2)} &middot; n={t.size}
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
    </div>
  );
}
