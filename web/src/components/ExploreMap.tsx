"use client";

import { useMemo, useCallback } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer } from "@deck.gl/layers";
import { OrthographicView } from "@deck.gl/core";
import type { ExplorePoints } from "@/lib/explore-data";
import { clusterColor } from "@/lib/explore-data";

interface ExploreMapProps {
  points: ExplorePoints;
  tier: number;
  contentFilter: Set<number>;
  onPointClick: (index: number) => void;
}

const INITIAL_VIEW_STATE = {
  target: [0.5, 0.5, 0] as [number, number, number],
  zoom: 8,
  minZoom: 4,
  maxZoom: 16,
};

export function ExploreMap({
  points,
  tier,
  contentFilter,
  onPointClick,
}: ExploreMapProps) {
  const clusterArrayForTier = useMemo(() => {
    switch (tier) {
      case 0: return points.clusterT0;
      case 1: return points.clusterT1;
      case 2: return points.clusterT2;
      case 3: return points.clusterT3;
      default: return points.clusterT2;
    }
  }, [points, tier]);

  const filteredIndices = useMemo(() => {
    const indices: number[] = [];
    for (let i = 0; i < points.count; i++) {
      if (contentFilter.has(points.contentType[i])) {
        indices.push(i);
      }
    }
    return indices;
  }, [points, contentFilter]);

  const handleClick = useCallback(
    (info: { index: number }) => {
      if (info.index >= 0 && info.index < filteredIndices.length) {
        onPointClick(filteredIndices[info.index]);
      }
    },
    [onPointClick, filteredIndices]
  );

  const layer = useMemo(
    () =>
      new ScatterplotLayer({
        id: "chunks",
        data: { length: filteredIndices.length },
        getPosition: (_: unknown, { index }: { index: number }) => {
          const i = filteredIndices[index];
          return [points.x[i], points.y[i], 0];
        },
        getFillColor: (_: unknown, { index }: { index: number }) => {
          const i = filteredIndices[index];
          const label = clusterArrayForTier[i];
          const [r, g, b] = clusterColor(label);
          return [r, g, b, 200];
        },
        getRadius: 1,
        radiusMinPixels: 1.5,
        radiusMaxPixels: 6,
        pickable: true,
        onClick: handleClick,
        updateTriggers: {
          getPosition: [filteredIndices],
          getFillColor: [tier, filteredIndices],
        },
      }),
    [points, tier, filteredIndices, clusterArrayForTier, handleClick]
  );

  const views = useMemo(
    () => new OrthographicView({ id: "ortho", flipY: true }),
    []
  );

  return (
    <DeckGL
      views={views}
      initialViewState={INITIAL_VIEW_STATE}
      controller={true}
      layers={[layer]}
      style={{ position: "absolute", inset: "0" }}
      getCursor={() => "crosshair"}
    />
  );
}
