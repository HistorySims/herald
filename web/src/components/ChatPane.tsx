"use client";

import { useState, useRef, useEffect } from "react";
import type { Message, Citation, AskResponse } from "@/lib/types";
import { MessageBubble } from "./MessageBubble";

interface ChatPaneProps {
  onCitationClick: (citation: Citation) => void;
  activeCitationIndex: number | null;
}

export function ChatPane({ onCitationClick, activeCitationIndex }: ChatPaneProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleSubmit = async () => {
    const question = input.trim();
    if (!question || loading) return;

    setInput("");
    setLoading(true);

    const userMsg: Message = { role: "user", content: question };
    const assistantMsg: Message = {
      role: "assistant",
      content: "",
      loading: true,
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);

    try {
      const resp = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question }),
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

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        let eventType = "";
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7);
          } else if (line.startsWith("data: ")) {
            const data = line.slice(6);
            try {
              const parsed = JSON.parse(data);
              if (eventType === "token") {
                streamedText += parsed.text;
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
                const response = parsed as AskResponse;
                setMessages((prev) => {
                  const updated = [...prev];
                  updated[updated.length - 1] = {
                    role: "assistant",
                    content: response.text,
                    citations: response.citations,
                    refused: response.refused,
                    loading: false,
                  };
                  return updated;
                });
              } else if (eventType === "error") {
                throw new Error(parsed.error);
              }
            } catch (e) {
              if (e instanceof SyntaxError) continue;
              throw e;
            }
          }
        }
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
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stone-200 bg-stone-50">
        <h1 className="text-lg font-serif font-semibold text-stone-800">
          Herald
        </h1>
        <p className="text-xs text-stone-500">
          Semantic research over historic New York newspapers, 1842-1846
        </p>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4">
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
                    onClick={() => {
                      setInput(q);
                      textareaRef.current?.focus();
                    }}
                    className="block w-full text-left text-sm px-3 py-2 rounded-lg
                      border border-stone-200 text-stone-600 hover:bg-stone-50
                      hover:border-stone-300 transition-colors"
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
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="px-4 py-3 border-t border-stone-200 bg-stone-50">
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
            onClick={handleSubmit}
            disabled={loading || !input.trim()}
            className="px-4 py-2 rounded-lg bg-amber-800 text-amber-50 text-sm font-medium
              hover:bg-amber-700 transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? "..." : "Ask"}
          </button>
        </div>
        <p className="text-xs text-stone-400 mt-1">
          Enter to send, Shift+Enter for newline
        </p>
      </div>
    </div>
  );
}
