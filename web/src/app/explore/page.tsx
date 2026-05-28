"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { ExploreMap } from "@/components/ExploreMap";
import { ExploreSidebar } from "@/components/ExploreSidebar";
import { ChunkDetail } from "@/components/ChunkDetail";
import {
  ExplorePoints,
  parsePointsBinary,
  ChunkDetail as ChunkDetailType,
} from "@/lib/explore-data";

export default function ExplorePage() {
  const [points, setPoints] = useState<ExplorePoints | null>(null);
  const [chunkIds, setChunkIds] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tier, setTier] = useState(2);
  const [contentFilter, setContentFilter] = useState<Set<number>>(
    new Set([0, 1, 2, 3])
  );
  const [showOutliers, setShowOutliers] = useState(true);
  const [selectedChunk, setSelectedChunk] = useState<ChunkDetailType | null>(
    null
  );
  const [loadingChunk, setLoadingChunk] = useState(false);

  useEffect(() => {
    async function load() {
      try {
        const resp = await fetch("/api/explore/points");
        if (!resp.ok) {
          const err = await resp.json();
          throw new Error(err.error || `HTTP ${resp.status}`);
        }
        const buf = await resp.arrayBuffer();
        setPoints(parsePointsBinary(buf));
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  useEffect(() => {
    fetch("/api/explore/chunk-ids")
      .then((r) => r.json())
      .then((ids) => setChunkIds(ids))
      .catch(() => {});
  }, []);

  const handlePointClick = useCallback(
    async (index: number) => {
      if (!chunkIds || !chunkIds[index]) return;
      setLoadingChunk(true);
      try {
        const resp = await fetch(
          `/api/explore/chunk?id=${chunkIds[index]}`
        );
        if (resp.ok) {
          setSelectedChunk(await resp.json());
        }
      } finally {
        setLoadingChunk(false);
      }
    },
    [chunkIds]
  );

  const stats = useMemo(() => {
    if (!points) return { total: 0, visible: 0, outliers: 0 };
    let outliers = 0;
    let visible = 0;
    const clusterArr =
      tier === 0 ? points.clusterT0 :
      tier === 1 ? points.clusterT1 :
      tier === 2 ? points.clusterT2 :
      points.clusterT3;
    for (let i = 0; i < points.count; i++) {
      const isOutlier = clusterArr[i] < 0;
      if (isOutlier) outliers++;
      if (!contentFilter.has(points.contentType[i])) continue;
      if (!showOutliers && isOutlier) continue;
      visible++;
    }
    return { total: points.count, visible, outliers };
  }, [points, tier, contentFilter, showOutliers]);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-stone-900">
        <div className="flex items-center gap-3 text-stone-400">
          <span className="inline-block w-5 h-5 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
          Loading corpus map...
        </div>
      </div>
    );
  }

  if (error || !points) {
    return (
      <div className="h-full flex items-center justify-center bg-stone-900">
        <div className="text-center px-6">
          <p className="text-stone-400 text-sm mb-2">
            {error || "No cluster data available"}
          </p>
          <a
            href="/"
            className="text-amber-500 hover:text-amber-400 text-sm underline"
          >
            Back to search
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col md:flex-row bg-stone-900">
      <div className="flex-1 relative min-h-[50vh] md:min-h-0">
        <ExploreMap
          points={points}
          tier={tier}
          contentFilter={contentFilter}
          showOutliers={showOutliers}
          onPointClick={handlePointClick}
        />
        <div className="absolute top-3 left-3">
          <a
            href="/"
            className="text-xs text-stone-400 hover:text-stone-200 bg-stone-800/80 px-2 py-1 rounded"
          >
            Back to search
          </a>
        </div>
        <div className="absolute top-3 right-3 text-xs text-stone-500 bg-stone-800/80 px-2 py-1 rounded">
          {stats.visible.toLocaleString()} / {stats.total.toLocaleString()} chunks
        </div>
        <div className="absolute bottom-3 left-3 text-xs text-stone-500 bg-stone-800/80 px-2 py-1 rounded">
          Pinch / scroll to zoom · drag to pan · tap a dot
        </div>
      </div>

      <div className="w-full md:w-72 lg:w-80 border-t md:border-t-0 md:border-l border-stone-700 bg-stone-900 overflow-y-auto">
        <ExploreSidebar
          tier={tier}
          onTierChange={setTier}
          contentFilter={contentFilter}
          onContentFilterChange={setContentFilter}
          showOutliers={showOutliers}
          onShowOutliersChange={setShowOutliers}
          outlierCount={stats.outliers}
          totalCount={stats.total}
          visibleCount={stats.visible}
        />
        {(selectedChunk || loadingChunk) && (
          <ChunkDetail
            chunk={selectedChunk}
            loading={loadingChunk}
            onClose={() => setSelectedChunk(null)}
          />
        )}
      </div>
    </div>
  );
}
