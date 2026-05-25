"use client";

import { useState, useRef, useEffect, useLayoutEffect, useCallback } from "react";
import type { Message, Citation, AskResponse } from "@/lib/types";
import { MessageBubble } from "./MessageBubble";
import { FilterControls } from "./FilterControls";

const STORAGE_KEY = "herald-messages-v2";

function loadMessages(): Message[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Message[];
    return parsed.filter((m) => !m.loading);
  } catch {
    return [];
  }
}

function saveMessages(messages: Message[]) {
  try {
    const completed = messages.filter((m) => !m.loading);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(completed));
  } catch { /* quota exceeded — silently drop */ }
}

interface ChatPaneProps {
  onCitationClick: (citation: Citation) => void;
  activeCitationIndex: number | null;
}

export function ChatPane({ onCitationClick, activeCitationIndex }: ChatPaneProps) {
  const [messages, setMessages] = useState<Message[]>(loadMessages);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<"idle" | "searching" | "streaming">("idle");
  const [filters, setFilters] = useState<{
    paperLccn: string | null;
    dateFrom: string | null;
    dateTo: string | null;
  }>({ paperLccn: null, dateFrom: null, dateTo: null });
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const justSubmittedRef = useRef(false);
  const savedScrollTopRef = useRef(0);

  useEffect(() => {
    if (justSubmittedRef.current) {
      justSubmittedRef.current = false;
      messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
    }
  }, [messages]);

  // Pin scroll position during streaming to fight iOS Safari auto-scroll
  useLayoutEffect(() => {
    if (phase === "streaming" && scrollContainerRef.current) {
      scrollContainerRef.current.scrollTop = savedScrollTopRef.current;
    }
  }, [messages, phase]);

  useEffect(() => {
    saveMessages(messages);
  }, [messages]);

  const handleClearConversation = useCallback(() => {
    setMessages([]);
    localStorage.removeItem(STORAGE_KEY);
  }, []);

  const handleSubmit = useCallback(async (overrideQuestion?: string) => {
    const question = (overrideQuestion ?? input).trim();
    if (!question || loading) return;

    setInput("");
    setLoading(true);
    setPhase("searching");

    const userMsg: Message = { role: "user", content: question };
    const assistantMsg: Message = {
      role: "assistant",
      content: "",
      loading: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    justSubmittedRef.current = true;

    try {
      const resp = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question,
          paper_lccn: filters.paperLccn,
          date_from: filters.dateFrom,
          date_to: filters.dateTo,
        }),
      });

      if (!resp.ok) {
        const err = await resp.json();
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let buffer = "";
      let streamedText = "";
      let eventType = "";
      let lastResponse: AskResponse | null = null;

      function processLine(line: string) {
        if (line.startsWith("event: ")) {
          eventType = line.slice(7).trim();
        } else if (line.startsWith("data: ")) {
          const data = line.slice(6);
          const parsed = JSON.parse(data);
          if (eventType === "token") {
            setPhase("streaming");
            streamedText += parsed.text;
            if (scrollContainerRef.current) {
              savedScrollTopRef.current = scrollContainerRef.current.scrollTop;
            }
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: "assistant",
                content: streamedText,
                loading: true,
              };
              return updated;
            });
          } else if (eventType === "done") {
            lastResponse = parsed as AskResponse;
            setMessages((prev) => {
              const updated = [...prev];
              updated[updated.length - 1] = {
                role: "assistant",
                content: lastResponse!.text,
                citations: lastResponse!.citations,
                refused: lastResponse!.refused,
                loading: false,
              };
              return updated;
            });
          } else if (eventType === "error") {
            throw new Error(parsed.error);
          }
        }
      }

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          try {
            processLine(line);
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // Flush: decode any remaining bytes and process leftover buffer
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const line of buffer.split("\n")) {
          try {
            processLine(line);
          } catch (e) {
            if (e instanceof SyntaxError) continue;
            throw e;
          }
        }
      }

      // Fallback: if stream ended without a done event, finalize without citations
      if (!lastResponse && streamedText) {
        setMessages((prev) => {
          const updated = [...prev];
          updated[updated.length - 1] = {
            role: "assistant",
            content: streamedText,
            loading: false,
          };
          return updated;
        });
      }
    } catch (err) {
      const errorMessage =
        err instanceof Error ? err.message : "Something went wrong";
      setMessages((prev) => {
        const updated = [...prev];
        updated[updated.length - 1] = {
          role: "assistant",
          content: `Error: ${errorMessage}`,
          loading: false,
        };
        return updated;
      });
    } finally {
      setLoading(false);
      setPhase("idle");
    }
  }, [input, loading, filters]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stone-200 bg-stone-50 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-serif font-semibold text-stone-800">
            Herald
          </h1>
          <p className="text-xs text-stone-500">
            Semantic research over historic New York newspapers, 1842&ndash;1846
          </p>
        </div>
        {messages.length > 0 && (
          <button
            onClick={handleClearConversation}
            disabled={loading}
            className="text-xs text-stone-400 hover:text-stone-600 transition-colors
              border border-stone-300 rounded px-2 py-1 mt-0.5
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            New chat
          </button>
        )}
      </div>

      {/* Messages */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto px-4 py-4">
        {messages.length === 0 && (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md">
              <h2 className="text-xl font-serif text-stone-700 mb-2">
                Ask a question
              </h2>
              <p className="text-sm text-stone-500 mb-4">
                Search across the New-York Daily Tribune and Albany Evening
                Journal for coverage of the Anti-Rent Wars and more.
              </p>
              <div className="space-y-2">
                {[
                  "How do the papers report the killing of Sheriff Steele?",
                  "Find references to the Calico Indians",
                  "How does the Tribune characterize tenants vs. landlords?",
                ].map((q) => (
                  <button
                    key={q}
                    onClick={() => handleSubmit(q)}
                    disabled={loading}
                    className="block w-full text-left text-sm px-3 py-2 rounded-lg
                      border border-stone-200 text-stone-600 hover:bg-stone-50
                      hover:border-stone-300 transition-colors
                      disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble
            key={i}
            message={msg}
            activeCitationIndex={activeCitationIndex}
            onCitationClick={onCitationClick}
          />
        ))}
        {phase === "searching" && messages.length > 0 && messages[messages.length - 1].content === "" && (
          <div className="flex justify-start mb-4">
            <div className="bg-stone-100 border border-stone-200 rounded-xl px-4 py-3">
              <div className="flex items-center gap-2 text-sm text-stone-500">
                <span className="inline-block w-4 h-4 border-2 border-stone-400 border-t-transparent rounded-full animate-spin" />
                Searching the corpus...
              </div>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-stone-200 bg-stone-50 space-y-2">
        <FilterControls
          onFiltersChange={setFilters}
          disabled={loading}
        />
        <div className="flex gap-2">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about the Anti-Rent Wars, 1842-1846..."
            disabled={loading}
            rows={1}
            className="flex-1 resize-none rounded-lg border border-stone-300 px-3 py-2
              text-sm text-stone-900 placeholder:text-stone-400
              focus:outline-none focus:ring-2 focus:ring-amber-600 focus:border-transparent
              disabled:opacity-50 disabled:cursor-not-allowed"
          />
          <button
            onClick={() => handleSubmit()}
            disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-lg bg-amber-800 text-amber-50 text-sm font-medium
              hover:bg-amber-700 transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "..." : "Ask"}
          </button>
        </div>
        <p className="text-xs text-stone-400">
          Enter to send &middot; Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}
