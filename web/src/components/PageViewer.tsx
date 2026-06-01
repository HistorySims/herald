"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface PageViewerProps {
  imageUrl: string | null;
  className?: string;
}

const ZOOM_LEVELS = [1, 1.5, 2, 3, 4];

export function PageViewer({ imageUrl, className = "" }: PageViewerProps) {
  const [zoomIdx, setZoomIdx] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const prevUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (imageUrl !== prevUrlRef.current) {
      prevUrlRef.current = imageUrl;
      setZoomIdx(0);
      setLoaded(false);
      setError(false);
    }
  }, [imageUrl]);

  const proxiedUrl = imageUrl
    ? `/api/page-image?url=${encodeURIComponent(imageUrl)}`
    : null;

  const zoom = ZOOM_LEVELS[zoomIdx];

  const handleZoomIn = useCallback(() => {
    setZoomIdx((i) => Math.min(i + 1, ZOOM_LEVELS.length - 1));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoomIdx((i) => Math.max(i - 1, 0));
  }, []);

  const handleFit = useCallback(() => {
    setZoomIdx(0);
  }, []);

  const btnClass =
    "w-10 h-10 md:w-8 md:h-8 rounded bg-stone-800/80 text-stone-100 " +
    "hover:bg-stone-700/90 active:bg-stone-600/90 transition-colors " +
    "flex items-center justify-center touch-manipulation";

  return (
    <div className={`relative h-full ${className}`}>
      {imageUrl ? (
        <div
          className="w-full h-full overflow-auto"
          style={{ WebkitOverflowScrolling: "touch" }}
        >
          {!loaded && !error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="flex items-center gap-2 text-stone-400 text-sm">
                <span className="inline-block w-5 h-5 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                Loading page...
              </div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center px-6">
                <p className="text-stone-400 text-sm mb-2">
                  Could not load the newspaper page image.
                </p>
                <a
                  href={imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-500 hover:text-amber-400 text-sm underline"
                >
                  Open image directly
                </a>
              </div>
            </div>
          )}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={proxiedUrl ?? ""}
            src={proxiedUrl ?? ""}
            alt="Newspaper page scan"
            onLoad={() => { setLoaded(true); setError(false); }}
            onError={() => { setLoaded(false); setError(true); }}
            className="select-none"
            style={{
              width: `${zoom * 100}%`,
              display: error ? "none" : "block",
            }}
            draggable={false}
          />
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-stone-500 text-sm">
            Click a citation to view the original page
          </p>
        </div>
      )}

      {/* Zoom controls */}
      {imageUrl && loaded && (
        <div className="absolute top-3 right-3 flex flex-col gap-1">
          <button
            onClick={handleZoomIn}
            disabled={zoomIdx >= ZOOM_LEVELS.length - 1}
            className={btnClass}
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={handleZoomOut}
            disabled={zoomIdx <= 0}
            className={btnClass}
            title="Zoom out"
          >
            &minus;
          </button>
          <button onClick={handleFit} className={`${btnClass} text-sm`} title="Fit to width">
            Fit
          </button>
        </div>
      )}
    </div>
  );
}
