"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface PageViewerProps {
  imageUrl: string | null;
  resourceUrl: string | null;
  className?: string;
}

const ZOOM_LEVELS = [1, 1.5, 2, 3, 4];

interface LocResourceFile {
  url?: string;
  mimetype?: string;
  height?: number;
}
interface LocResource {
  url?: string;
  files?: LocResourceFile[];
}
interface LocResourceJson {
  resources?: LocResource[];
  image_url?: string | string[];
}

function pickBestImageUrl(json: LocResourceJson): string | null {
  const candidates: { url: string; height: number; mimetype: string }[] = [];

  if (Array.isArray(json.image_url)) {
    for (const u of json.image_url) {
      if (typeof u === "string") candidates.push({ url: u, height: 9999, mimetype: "image/jpeg" });
    }
  } else if (typeof json.image_url === "string") {
    candidates.push({ url: json.image_url, height: 9999, mimetype: "image/jpeg" });
  }

  for (const res of json.resources ?? []) {
    for (const f of res.files ?? []) {
      if (!f.url) continue;
      const mt = f.mimetype ?? "";
      if (!mt.startsWith("image/")) continue;
      candidates.push({
        url: f.url,
        height: f.height ?? 0,
        mimetype: mt,
      });
    }
  }

  // Prefer JPEG over JP2/TIFF, prefer larger height (but cap at 4000 to avoid the gigantic master)
  candidates.sort((a, b) => {
    const aJpeg = a.mimetype === "image/jpeg" ? 0 : 1;
    const bJpeg = b.mimetype === "image/jpeg" ? 0 : 1;
    if (aJpeg !== bJpeg) return aJpeg - bJpeg;
    const aH = a.height > 4000 ? 4000 : a.height;
    const bH = b.height > 4000 ? 4000 : b.height;
    return bH - aH;
  });

  return candidates[0]?.url ?? null;
}

export function PageViewer({
  imageUrl,
  resourceUrl,
  className = "",
}: PageViewerProps) {
  const [zoomIdx, setZoomIdx] = useState(0);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const prevUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (imageUrl === prevUrlRef.current) return;
    prevUrlRef.current = imageUrl;
    setZoomIdx(0);
    setLoaded(false);
    setError(false);
    setResolvedSrc(null);

    if (!imageUrl || !resourceUrl) return;

    let cancelled = false;
    setDiscovering(true);

    fetch(`${resourceUrl}?fo=json`, {
      credentials: "omit",
      mode: "cors",
      headers: { Accept: "application/json" },
    })
      .then((r) => {
        if (!r.ok) throw new Error(`metadata ${r.status}`);
        return r.json() as Promise<LocResourceJson>;
      })
      .then((json) => {
        if (cancelled) return;
        const best = pickBestImageUrl(json);
        setResolvedSrc(best ?? imageUrl);
      })
      .catch(() => {
        if (cancelled) return;
        setResolvedSrc(imageUrl);
      })
      .finally(() => {
        if (!cancelled) setDiscovering(false);
      });

    return () => {
      cancelled = true;
    };
  }, [imageUrl, resourceUrl]);

  const zoom = ZOOM_LEVELS[zoomIdx];

  const handleZoomIn = useCallback(() => {
    setZoomIdx((i) => Math.min(i + 1, ZOOM_LEVELS.length - 1));
  }, []);
  const handleZoomOut = useCallback(() => {
    setZoomIdx((i) => Math.max(i - 1, 0));
  }, []);
  const handleFit = useCallback(() => setZoomIdx(0), []);

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
          {(discovering || (!loaded && !error)) && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
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
                  href={resourceUrl ?? imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-500 hover:text-amber-400 text-sm underline"
                >
                  Open on Library of Congress
                </a>
              </div>
            </div>
          )}
          {resolvedSrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={resolvedSrc}
              src={resolvedSrc}
              alt="Newspaper page scan"
              onLoad={() => {
                setLoaded(true);
                setError(false);
              }}
              onError={() => {
                setLoaded(false);
                setError(true);
              }}
              className="select-none"
              style={{
                width: `${zoom * 100}%`,
                display: error ? "none" : "block",
              }}
              draggable={false}
            />
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-stone-500 text-sm">
            Click a citation to view the original page
          </p>
        </div>
      )}

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
          <button
            onClick={handleFit}
            className={`${btnClass} text-sm`}
            title="Fit to width"
          >
            Fit
          </button>
        </div>
      )}
    </div>
  );
}
