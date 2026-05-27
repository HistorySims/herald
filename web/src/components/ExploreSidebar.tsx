"use client";

import { contentTypeLabel } from "@/lib/explore-data";

interface ExploreSidebarProps {
  tier: number;
  onTierChange: (tier: number) => void;
  contentFilter: Set<number>;
  onContentFilterChange: (filter: Set<number>) => void;
}

const TIERS = [
  { value: 0, label: "Fine", desc: "~500-2000 clusters" },
  { value: 1, label: "Medium", desc: "~80-150 clusters" },
  { value: 2, label: "Broad", desc: "~15-25 clusters" },
  { value: 3, label: "Macro", desc: "~3-7 clusters" },
];

const CONTENT_TYPES = [0, 1, 2, 3];

export function ExploreSidebar({
  tier,
  onTierChange,
  contentFilter,
  onContentFilterChange,
}: ExploreSidebarProps) {
  const toggleContentType = (t: number) => {
    const next = new Set(contentFilter);
    if (next.has(t)) {
      next.delete(t);
    } else {
      next.add(t);
    }
    onContentFilterChange(next);
  };

  return (
    <div className="p-4 space-y-5">
      <div>
        <h2 className="text-sm font-semibold text-stone-300 mb-1">
          Explore the Corpus
        </h2>
        <p className="text-xs text-stone-500">
          Each dot is a chunk of newspaper text. Color = cluster.
        </p>
      </div>

      <div>
        <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-2">
          Cluster Level
        </h3>
        <div className="space-y-1">
          {TIERS.map((t) => (
            <button
              key={t.value}
              onClick={() => onTierChange(t.value)}
              className={`w-full text-left px-3 py-1.5 rounded text-sm transition-colors ${
                tier === t.value
                  ? "bg-amber-800 text-amber-50"
                  : "text-stone-400 hover:bg-stone-800 hover:text-stone-200"
              }`}
            >
              <span className="font-medium">{t.label}</span>
              <span className="text-xs ml-2 opacity-70">{t.desc}</span>
            </button>
          ))}
        </div>
      </div>

      <div>
        <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide mb-2">
          Content Filter
        </h3>
        <div className="space-y-1">
          {CONTENT_TYPES.map((t) => (
            <label
              key={t}
              className="flex items-center gap-2 px-3 py-1 cursor-pointer text-sm text-stone-400 hover:text-stone-200"
            >
              <input
                type="checkbox"
                checked={contentFilter.has(t)}
                onChange={() => toggleContentType(t)}
                className="rounded border-stone-600 bg-stone-800 text-amber-600 focus:ring-amber-600"
              />
              {contentTypeLabel(t)}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
