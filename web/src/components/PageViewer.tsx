"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import OpenSeadragon from "openseadragon";

interface PageViewerProps {
  imageUrl: string | null;
  className?: string;
}

export function PageViewer({ imageUrl, className = "" }: PageViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<OpenSeadragon.Viewer | null>(null);
  const currentUrlRef = useRef<string | null>(null);
  const [loading, setLoading] = useState(false);

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

    viewer.addHandler("open", () => setLoading(false));
    viewer.addHandler("open-failed", () => setLoading(false));

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
    setLoading(true);
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

  const btnClass =
    "w-10 h-10 md:w-8 md:h-8 rounded bg-stone-800/80 text-stone-100 " +
    "hover:bg-stone-700/90 active:bg-stone-600/90 transition-colors " +
    "flex items-center justify-center touch-manipulation";

  return (
    <div className={`relative h-full ${className}`}>
      <div ref={containerRef} className="w-full h-full" />

      {/* Loading indicator */}
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/30">
          <div className="flex items-center gap-2 text-stone-300 text-sm">
            <span className="inline-block w-5 h-5 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
            Loading page image...
          </div>
        </div>
      )}

      {/* Zoom controls */}
      <div className="absolute top-3 right-3 flex flex-col gap-1">
        <button onClick={handleZoomIn} className={btnClass} title="Zoom in">
          +
        </button>
        <button onClick={handleZoomOut} className={btnClass} title="Zoom out">
          &minus;
        </button>
        <button onClick={handleHome} className={`${btnClass} text-sm`} title="Fit to page">
          Fit
        </button>
      </div>

      {/* Empty state */}
      {!imageUrl && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-stone-500 text-sm">
            Click a citation to view the original page
          </p>
        </div>
      )}
    </div>
  );
}
