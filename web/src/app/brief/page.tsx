"use client";

import { useCallback, useState } from "react";
import { ResearchBrief } from "@/components/ResearchBrief";
import type { BriefResponse } from "@/lib/brief";

export default function BriefPage() {
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<BriefResponse | null>(null);

  const handleSubmit = useCallback(async () => {
    if (!question.trim() || loading) return;
    setLoading(true);
    setError(null);
    try {
      const resp = await fetch("/api/brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: question.trim() }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({ error: "Unknown error" }));
        throw new Error(data.error ?? `HTTP ${resp.status}`);
      }
      const data = (await resp.json()) as BriefResponse;
      setBrief(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [question, loading]);

  return (
    <div className="h-full flex flex-col bg-[#faf7f0] text-[#2c1810]">
      <header className="px-4 py-3 border-b border-stone-200 bg-stone-50 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-serif font-semibold text-stone-800">
            Research Brief
          </h1>
          <p className="text-xs text-stone-500">
            Plain-English question &rarr; organized finding aid keyed to the corpus
          </p>
        </div>
        <nav className="flex items-center gap-2 mt-0.5">
          <a
            href="/"
            className="text-xs text-stone-400 hover:text-stone-600 transition-colors border border-stone-300 rounded px-2 py-1"
          >
            Chat
          </a>
          <a
            href="/explore"
            className="text-xs text-stone-400 hover:text-stone-600 transition-colors border border-stone-300 rounded px-2 py-1"
          >
            Explore
          </a>
        </nav>
      </header>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
          <section className="space-y-3">
            <label
              htmlFor="brief-question"
              className="block text-sm font-medium text-stone-700"
            >
              Research question
            </label>
            <textarea
              id="brief-question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder='e.g. "How did rural communities respond to economic coercion by landlords?"'
              className="w-full border border-stone-300 rounded p-3 text-sm font-serif
                bg-white focus:outline-none focus:ring-2 focus:ring-stone-400"
              disabled={loading}
            />
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
              <p className="text-xs text-stone-500">
                We will translate your question into 1840s vocabulary, match
                clusters in the corpus, and assemble a brief. 30-60s.
              </p>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!question.trim() || loading}
                className="px-4 py-2 rounded bg-stone-800 text-stone-50 text-sm
                  hover:bg-stone-700 disabled:opacity-50 disabled:cursor-not-allowed
                  whitespace-nowrap"
              >
                {loading ? "Generating…" : "Generate research brief"}
              </button>
            </div>
            {error && (
              <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2">
                {error}
              </p>
            )}
            {loading && (
              <div className="text-xs text-stone-500 italic">
                Translating &rarr; matching clusters &rarr; assembling cards &rarr; composing orientation…
              </div>
            )}
          </section>

          {brief && <ResearchBrief brief={brief} />}
        </div>
      </div>
    </div>
  );
}
