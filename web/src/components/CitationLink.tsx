"use client";

import type { Citation } from "@/lib/types";

interface CitationLinkProps {
  citation: Citation;
  isActive: boolean;
  onClick: (citation: Citation) => void;
}

export function CitationLink({ citation, isActive, onClick }: CitationLinkProps) {
  return (
    <button
      onClick={() => onClick(citation)}
      className={`inline-flex items-center justify-center min-w-[1.5em] h-[1.5em] px-1
        text-xs font-mono rounded-sm align-super cursor-pointer transition-colors
        ${isActive
          ? "bg-amber-700 text-amber-50"
          : "bg-amber-100 text-amber-800 hover:bg-amber-200"
        }`}
      title={`${citation.paper_title}, ${citation.date_issued}, p.${citation.page_sequence}`}
    >
      {citation.index}
    </button>
  );
}
