"use client";

import { useState, useCallback, useEffect, useRef } from "react";

interface PageViewerProps {
  imageUrl: string | null;
  resourceUrl: string | null;
  className?: string;
}

const ZOOM_LEVELS = [1, 1.5, 2, 3, 4];
const DISCOVERY_TIMEOUT_MS = 8000;
const IMAGE_TIMEOUT_MS = 30000;

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
      candidates.push({ url: f.url, height: f.height ?? 0, mimetype: mt });
    }
  }

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
  const [errorReason, setErrorReason] = useState<string>("");
  const prevUrlRef = useRef<string | null>(null);
  const imageTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (imageUrl === prevUrlRef.current) return;
    prevUrlRef.current = imageUrl;
    setZoomIdx(0);
    setLoaded(false);
    setError(false);
    setErrorReason("");
    setResolvedSrc(null);

    if (!imageUrl) return;

    const controller = new AbortController();
    const timeoutId = window.setTimeout(
      () => controller.abort(),
      DISCOVERY_TIMEOUT_MS
    );

    const runDiscovery = async (): Promise<string | null> => {
      if (!resourceUrl) return null;
      try {
        const resp = await fetch(`${resourceUrl}?fo=json`, {
          signal: controller.signal,
          credentials: "omit",
          headers: { Accept: "application/json" },
        });
        if (!resp.ok) return null;
        const ct = resp.headers.get("Content-Type") ?? "";
        if (!ct.includes("json")) return null;
        const json = (await resp.json()) as LocResourceJson;
        return pickBestImageUrl(json);
      } catch {
        return null;
      } finally {
        window.clearTimeout(timeoutId);
      }
    };

    let cancelled = false;
    runDiscovery().then((discovered) => {
      if (cancelled) return;
      const src = discovered ?? imageUrl;
      setResolvedSrc(src);
      if (imageTimerRef.current) window.clearTimeout(imageTimerRef.current);
      imageTimerRef.current = window.setTimeout(() => {
        setError(true);
        setErrorReason(
          "Image didn't load within 30 seconds. LOC may be blocking the request."
        );
      }, IMAGE_TIMEOUT_MS);
    });

    return () => {
      cancelled = true;
      controller.abort();
      if (imageTimerRef.current) {
        window.clearTimeout(imageTimerRef.current);
        imageTimerRef.current = null;
      }
    };
  }, [imageUrl, resourceUrl]);

  const handleImageLoad = useCallback(() => {
    setLoaded(true);
    setError(false);
    if (imageTimerRef.current) {
      window.clearTimeout(imageTimerRef.current);
      imageTimerRef.current = null;
    }
  }, []);

  const handleImageError = useCallback(() => {
    setLoaded(false);
    setError(true);
    setErrorReason("LOC returned a non-image response.");
    if (imageTimerRef.current) {
      window.clearTimeout(imageTimerRef.current);
      imageTimerRef.current = null;
    }
  }, []);

  const zoom = ZOOM_LEVELS[zoomIdx];

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
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-3 text-stone-400 text-sm">
                <span className="inline-block w-5 h-5 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                Loading page...
                {resourceUrl && (
                  <a
                    href={resourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-amber-500 hover:text-amber-400 text-xs underline pointer-events-auto mt-2"
                  >
                    Or open on LOC directly
                  </a>
                )}
              </div>
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="text-center px-6">
                <p className="text-stone-400 text-sm mb-2">
                  Could not load the page image inline.
                </p>
                {errorReason && (
                  <p className="text-stone-500 text-xs mb-3">{errorReason}</p>
                )}
                <a
                  href={resourceUrl ?? imageUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block px-4 py-2 bg-amber-800 text-amber-50 text-sm rounded hover:bg-amber-700"
                >
                  Open on Library of Congress
                </a>
              </div>
            </div>
          )}
          {resolvedSrc && !error && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={resolvedSrc}
              src={resolvedSrc}
              alt="Newspaper page scan"
              onLoad={handleImageLoad}
              onError={handleImageError}
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
            onClick={() => setZoomIdx((i) => Math.min(i + 1, ZOOM_LEVELS.length - 1))}
            disabled={zoomIdx >= ZOOM_LEVELS.length - 1}
            className={btnClass}
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={() => setZoomIdx((i) => Math.max(i - 1, 0))}
            disabled={zoomIdx <= 0}
            className={btnClass}
            title="Zoom out"
          >
            &minus;
          </button>
          <button onClick={() => setZoomIdx(0)} className={`${btnClass} text-sm`} title="Fit to width">
            Fit
          </button>
        </div>
      )}
    </div>
  );
}
