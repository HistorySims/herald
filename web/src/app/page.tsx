"use client";

import { useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { ChatPane } from "@/components/ChatPane";
import type { Citation } from "@/lib/types";

const PageViewer = dynamic(
  () => import("@/components/PageViewer").then((m) => m.PageViewer),
  { ssr: false, loading: () => <div className="h-full bg-[#1a1a1a]" /> }
);

export default function Home() {
  const [viewerImageUrl, setViewerImageUrl] = useState<string | null>(null);
  const [activeCitationIndex, setActiveCitationIndex] = useState<number | null>(
    null
  );
  const [viewerMeta, setViewerMeta] = useState<{
    paper: string;
    date: string;
    page: number;
  } | null>(null);
  const [showViewer, setShowViewer] = useState(false);

  const handleCitationClick = useCallback((citation: Citation) => {
    setViewerImageUrl(citation.image_url);
    setActiveCitationIndex(citation.index);
    setViewerMeta({
      paper: citation.paper_title,
      date: citation.date_issued,
      page: citation.page_sequence,
    });
    setShowViewer(true);
  }, []);

  return (
    <div className="h-full flex flex-col md:flex-row">
      {/* Chat pane */}
      <div
        className={`${
          showViewer ? "h-1/2 md:h-full md:w-1/2 lg:w-[45%]" : "h-full w-full"
        } flex-shrink-0 border-r border-stone-200 transition-all`}
      >
        <ChatPane
          onCitationClick={handleCitationClick}
          activeCitationIndex={activeCitationIndex}
        />
      </div>

      {/* Viewer pane */}
      {showViewer && (
        <div className="flex-1 flex flex-col bg-[#1a1a1a] min-h-0">
          {viewerMeta && (
            <div className="px-3 py-2 bg-stone-900 border-b border-stone-700 flex items-center justify-between">
              <div className="text-xs text-stone-400 font-mono truncate">
                {viewerMeta.paper} &middot; {viewerMeta.date} &middot; p.
                {viewerMeta.page}
              </div>
              <button
                onClick={() => {
                  setShowViewer(false);
                  setActiveCitationIndex(null);
                }}
                className="text-stone-500 hover:text-stone-300 text-sm ml-2"
                title="Close viewer"
              >
                Close
              </button>
            </div>
          )}
          <div className="flex-1 min-h-0">
            <PageViewer imageUrl={viewerImageUrl} />
          </div>
        </div>
      )}
    </div>
  );
}
