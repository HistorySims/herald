"use client";

import { useEffect, useRef, useCallback } from "react";
import OpenSeadragon from "openseadragon";

interface PageViewerProps {
  imageUrl: string | null;
  className?: string;
}

export function PageViewer({ imageUrl, className = "" }: PageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const currentUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const viewer = OpenSeadragon({
      element: containerRef.current,
      showNavigator: false,
      showZoomControl: false,
      showHomeControl: false,
      showFullPageControl: false,
      showRotationControl: false,
      animationTime: 0.5,
      minZoomLevel: 0.3,
      maxZoomLevel: 10,
      visibilityRatio: 0.5,
      constrainDuringPan: true,
      gestureSettingsMouse: { scrollToZoom: true },
      gestureSettingsTouch: { pinchToZoom: true },
    });

    viewerRef.current = viewer;

    return () => {
      viewer.destroy();
      viewerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!viewerRef.current || !imageUrl || imageUrl === currentUrlRef.current)
      return;
    currentUrlRef.current = imageUrl;
    viewerRef.current.close();
    viewerRef.current.addSimpleImage({ url: imageUrl });
  }, [imageUrl]);

  const handleZoomIn = useCallback(() => {
    viewerRef.current?.viewport.zoomBy(1.5);
  }, []);

  const handleZoomOut = useCallback(() => {
    viewerRef.current?.viewport.zoomBy(0.67);
  }, []);

  const handleHome = useCallback(() => {
    viewerRef.current?.viewport.goHome();
  }, []);

  return (
    <div className={`relative h-full ${className}`}>
      <div ref={containerRef} className="w-full h-full" />

      {/* Custom zoom controls */}
      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <button
          onClick={handleZoomIn}
          className="w-8 h-8 rounded bg-stone-800/80 text-stone-100 text-lg
            hover:bg-stone-700/90 transition-colors flex items-center justify-center"
          title="Zoom in"
        >
          +
        </button>
        <button
          onClick={handleZoomOut}
          className="w-8 h-8 rounded bg-stone-800/80 text-stone-100 text-lg
            hover:bg-stone-700/90 transition-colors flex items-center justify-center"
          title="Zoom out"
        >
          -
        </button>
        <button
          onClick={handleHome}
          className="w-8 h-8 rounded bg-stone-800/80 text-stone-100 text-sm
            hover:bg-stone-700/90 transition-colors flex items-center justify-center"
          title="Fit to page"
        >
          Fit
        </button>
      </div>

      {/* Empty state */}
      {!imageUrl && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="text-center">
            <p className="text-stone-500 text-sm">
              Click a citation to view the original page
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
