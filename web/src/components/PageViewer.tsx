"use client";

import { useCallback, useEffect, useRef, useState } from "react";

interface PageViewerProps {
  imageUrl: string | null;
  resourceUrl: string | null;
  className?: string;
}

const IFRAME_LOAD_TIMEOUT_MS = 12000;

function deriveLocPageUrl(imageUrl: string): string {
  const legacy = imageUrl.match(
    /^https:\/\/chroniclingamerica\.loc\.gov\/lccn\/([^/]+)\/([^/]+)\/(ed-\d+)\/(seq-\d+)\.(?:jpg|jp2|pdf)$/
  );
  if (legacy) {
    return `https://www.loc.gov/resource/${legacy[1]}/${legacy[2]}/${legacy[3]}/${legacy[4]}/`;
  }
  return imageUrl;
}

function bestLinkUrl(
  resourceUrl: string | null,
  imageUrl: string | null
): string {
  if (resourceUrl && resourceUrl.trim()) return resourceUrl;
  if (imageUrl) return deriveLocPageUrl(imageUrl);
  return "https://www.loc.gov/";
}

export function PageViewer({
  imageUrl,
  resourceUrl,
  className = "",
}: PageViewerProps) {
  const [iframeFailed, setIframeFailed] = useState(false);
  const [iframeLoaded, setIframeLoaded] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const timerRef = useRef<number | null>(null);
  const prevUrlRef = useRef<string | null>(null);

  const targetUrl = imageUrl ? bestLinkUrl(resourceUrl, imageUrl) : null;

  useEffect(() => {
    if (imageUrl === prevUrlRef.current) return;
    prevUrlRef.current = imageUrl;
    setIframeFailed(false);
    setIframeLoaded(false);

    if (!targetUrl) return;

    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      // If onLoad never fires within the budget, LOC has blocked iframing
      if (!iframeLoaded) setIframeFailed(true);
    }, IFRAME_LOAD_TIMEOUT_MS);

    return () => {
      if (timerRef.current) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [imageUrl, targetUrl, iframeLoaded]);

  const handleIframeLoad = useCallback(() => {
    setIframeLoaded(true);
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  if (!imageUrl) {
    return (
      <div className={`relative h-full ${className}`}>
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="text-stone-500 text-sm">
            Click a citation to view the original page
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className={`relative h-full ${className}`}>
      {iframeFailed ? (
        <div className="absolute inset-0 flex items-center justify-center bg-stone-900">
          <div className="text-center px-6">
            <p className="text-stone-400 text-sm mb-2">
              The Library of Congress blocks embedding this page.
            </p>
            <p className="text-stone-500 text-xs mb-4">
              You may need to pass a Cloudflare check the first time.
            </p>
            <a
              href={targetUrl ?? "https://www.loc.gov/"}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block px-4 py-2 bg-amber-800 text-amber-50 text-sm rounded hover:bg-amber-700"
            >
              Open on Library of Congress
            </a>
          </div>
        </div>
      ) : (
        <>
          {!iframeLoaded && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <div className="flex flex-col items-center gap-3 text-stone-400 text-sm">
                <span className="inline-block w-5 h-5 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                Loading from Library of Congress...
                <a
                  href={targetUrl ?? "https://www.loc.gov/"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-amber-500 hover:text-amber-400 text-xs underline pointer-events-auto mt-2"
                >
                  Or open in a new tab
                </a>
              </div>
            </div>
          )}
          {targetUrl && (
            <iframe
              key={targetUrl}
              ref={iframeRef}
              src={targetUrl}
              onLoad={handleIframeLoad}
              referrerPolicy="no-referrer"
              className="w-full h-full border-0 bg-stone-900"
              title="Newspaper page on Library of Congress"
            />
          )}
        </>
      )}
    </div>
  );
}
