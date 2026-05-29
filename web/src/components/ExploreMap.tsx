"use client";

import { useMemo, useCallback } from "react";
import DeckGL from "@deck.gl/react";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import { OrthographicView } from "@deck.gl/core";
import type { ExplorePoints } from "@/lib/explore-data";
import { clusterColor } from "@/lib/explore-data";

interface ExploreMapProps {
  points: ExplorePoints;
  tier: number;
  contentFilter: Set<number>;
  showOutliers: boolean;
  selectedIndex: number | null;
  selectedLabel: string | null;
  onPointClick: (index: number) => void;
}

const INITIAL_VIEW_STATE = {
  target: [0.5, 0.5, 0] as [number, number, number],
  zoom: 8,
  minZoom: 4,
  maxZoom: 18,
};

export function ExploreMap({
  points,
  tier,
  contentFilter,
  showOutliers,
  selectedIndex,
  selectedLabel,
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
      if (!contentFilter.has(points.contentType[i])) continue;
      if (!showOutliers && clusterArrayForTier[i] < 0) continue;
      indices.push(i);
    }
    return indices;
  }, [points, contentFilter, showOutliers, clusterArrayForTier]);

  const handleClick = useCallback(
    (info: { index: number }) => {
      if (info.index >= 0 && info.index < filteredIndices.length) {
        onPointClick(filteredIndices[info.index]);
      }
    },
    [onPointClick, filteredIndices]
  );

  const dotLayer = useMemo(
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
          const alpha = label < 0 ? 100 : 200;
          return [r, g, b, alpha];
        },
        getRadius: (_: unknown, { index }: { index: number }) => {
          const i = filteredIndices[index];
          return clusterArrayForTier[i] < 0 ? 0.5 : 1;
        },
        radiusMinPixels: 1.5,
        radiusMaxPixels: 8,
        pickable: true,
        onClick: handleClick,
        updateTriggers: {
          getPosition: [filteredIndices],
          getFillColor: [tier, filteredIndices],
          getRadius: [tier, filteredIndices],
        },
      }),
    [points, tier, filteredIndices, clusterArrayForTier, handleClick]
  );

  const highlightData = useMemo(() => {
    if (selectedIndex === null) return [];
    return [{
      position: [points.x[selectedIndex], points.y[selectedIndex]] as [number, number],
      label: selectedLabel ?? "",
    }];
  }, [selectedIndex, selectedLabel, points]);

  const highlightLayer = useMemo(
    () =>
      new ScatterplotLayer({
        id: "selected-highlight",
        data: highlightData,
        getPosition: (d) => [...d.position, 0] as [number, number, number],
        getFillColor: [0, 0, 0, 0],
        getLineColor: [255, 255, 255, 255],
        getRadius: 3,
        getLineWidth: 1.5,
        stroked: true,
        filled: false,
        radiusMinPixels: 10,
        radiusMaxPixels: 16,
        lineWidthMinPixels: 2,
        lineWidthMaxPixels: 3,
        pickable: false,
      }),
    [highlightData]
  );

  const labelLayer = useMemo(
    () =>
      new TextLayer({
        id: "selected-label",
        data: highlightData,
        getPosition: (d) => [...d.position, 0] as [number, number, number],
        getText: (d) => d.label,
        getSize: 13,
        getColor: [255, 255, 255, 255],
        getPixelOffset: [18, -2],
        getTextAnchor: "start",
        getAlignmentBaseline: "center",
        fontFamily: "ui-monospace, monospace",
        fontWeight: 500,
        background: true,
        backgroundPadding: [4, 2, 4, 2],
        getBackgroundColor: [20, 20, 20, 220],
        pickable: false,
      }),
    [highlightData]
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
      layers={[dotLayer, highlightLayer, labelLayer]}
      style={{ position: "absolute", inset: "0" }}
      getCursor={({ isDragging, isHovering }) =>
        isDragging ? "grabbing" : isHovering ? "pointer" : "grab"
      }
    />
  );
}
