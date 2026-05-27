"use client";

import type { ChunkDetail as ChunkDetailType } from "@/lib/explore-data";
import { contentTypeLabel } from "@/lib/explore-data";

interface ChunkDetailProps {
  chunk: ChunkDetailType | null;
  loading: boolean;
  onClose: () => void;
}

export function ChunkDetail({ chunk, loading, onClose }: ChunkDetailProps) {
  return (
    <div className="border-t border-stone-700 p-4">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-medium text-stone-400 uppercase tracking-wide">
          Chunk Detail
        </h3>
        <button
          onClick={onClose}
          className="text-stone-500 hover:text-stone-300 text-sm"
        >
          Close
        </button>
      </div>

      {loading && (
        <div className="flex items-center gap-2 text-stone-500 text-sm py-4">
          <span className="inline-block w-4 h-4 border-2 border-stone-500 border-t-transparent rounded-full animate-spin" />
          Loading...
        </div>
      )}

      {chunk && !loading && (
        <div className="space-y-3">
          <div>
            <p className="text-xs text-stone-500 font-mono">
              {chunk.paper_title}
            </p>
            <p className="text-xs text-stone-500 font-mono">
              {chunk.date_issued} &middot; p.{chunk.page_sequence} &middot;{" "}
              {contentTypeLabel(chunk.content_type)}
            </p>
          </div>

          <p className="text-sm text-stone-300 leading-relaxed font-serif">
            {chunk.content}
          </p>

          <a
            href={chunk.image_url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block text-xs text-amber-500 hover:text-amber-400 underline"
          >
            View original page
          </a>
        </div>
      )}
    </div>
  );
}
