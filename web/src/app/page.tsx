"use client";

import { useState, useCallback } from "react";
import { ChatPane } from "@/components/ChatPane";
import { PageViewer } from "@/components/PageViewer";
import type { Citation } from "@/lib/types";

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
      {/* Chat pane — full height when viewer closed, half on mobile when open */}
      <div
        className={`${
          showViewer
            ? "hidden md:flex md:h-full md:w-1/2 lg:w-[45%]"
            : "h-full w-full"
        } flex-shrink-0 border-r border-stone-200 flex flex-col`}
      >
        <ChatPane
          onCitationClick={handleCitationClick}
          activeCitationIndex={activeCitationIndex}
        />
      </div>

      {/* Viewer pane */}
      {showViewer && (
        <div className="flex-1 flex flex-col bg-[#1a1a1a] min-h-0 h-full">
          {/* Viewer header */}
          {viewerMeta && (
            <div className="px-3 py-2 bg-stone-900 border-b border-stone-700 flex items-center justify-between flex-shrink-0">
              <div className="text-xs text-stone-400 font-mono truncate mr-2">
                {viewerMeta.paper} &middot; {viewerMeta.date} &middot; p.{viewerMeta.page}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                {/* Mobile: back to chat */}
                <button
                  onClick={() => {
                    setShowViewer(false);
                    setActiveCitationIndex(null);
                  }}
                  className="md:hidden text-stone-400 hover:text-stone-200 text-xs
                    border border-stone-600 rounded px-2 py-1"
                >
                  Back to chat
                </button>
                {/* Desktop: close viewer */}
                <button
                  onClick={() => {
                    setShowViewer(false);
                    setActiveCitationIndex(null);
                  }}
                  className="hidden md:block text-stone-500 hover:text-stone-300 text-sm"
                  title="Close viewer"
                >
                  Close
                </button>
              </div>
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
