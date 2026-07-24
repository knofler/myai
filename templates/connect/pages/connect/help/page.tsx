"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type HelpCategory = "all" | "getting-started" | "technical" | "billing";

interface HelpArticle {
  _id: string;
  question: string;
  answer: string;
  category: "getting-started" | "technical" | "billing";
  helpful?: number;
  notHelpful?: number;
  userFeedback?: "up" | "down" | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CATEGORY_TABS: Array<{ value: HelpCategory; label: string }> = [
  { value: "all", label: "All" },
  { value: "getting-started", label: "Getting Started" },
  { value: "technical", label: "Technical" },
  { value: "billing", label: "Billing" },
];

const CATEGORY_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  "getting-started": { bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/30" },
  technical: { bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/30" },
  billing: { bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30" },
};

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function Toast({ message, type, onDismiss }: { message: string; type: "success" | "error"; onDismiss: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 5000);
    return () => clearTimeout(timer);
  }, [onDismiss]);

  return (
    <div className={`fixed top-4 right-4 z-50 flex items-center gap-2 rounded-lg border px-4 py-3 text-sm font-medium shadow-lg ${
      type === "success"
        ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
        : "border-red-500/30 bg-red-500/10 text-red-400"
    }`}>
      {type === "success" ? (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 12.75l6 6 9-13.5" />
        </svg>
      ) : (
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      )}
      {message}
      <button onClick={onDismiss} className="ml-2 text-current opacity-60 hover:opacity-100">
        <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function HelpPage() {
  // State
  const [articles, setArticles] = useState<HelpArticle[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [category, setCategory] = useState<HelpCategory>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [feedbackSending, setFeedbackSending] = useState<Set<string>>(new Set());

  // Toast
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // ---------------------------------------------------------------------------
  // Debounced search
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedQuery(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------

  const fetchArticles = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (debouncedQuery) params.set("q", debouncedQuery);
      if (category !== "all") params.set("category", category);

      const url = `/api/connect/help${params.toString() ? `?${params.toString()}` : ""}`;
      const res = await fetch(url, { credentials: "include" });

      if (res.ok) {
        const data = await res.json();
        setArticles(data.data || data.articles || []);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, [debouncedQuery, category]);

  useEffect(() => {
    fetchArticles();
  }, [fetchArticles]);

  // ---------------------------------------------------------------------------
  // Feedback handler
  // ---------------------------------------------------------------------------

  const handleFeedback = async (articleId: string, type: "up" | "down") => {
    if (feedbackSending.has(articleId)) return;

    setFeedbackSending((prev) => new Set(prev).add(articleId));
    try {
      const res = await fetch(`/api/connect/help/${articleId}/feedback`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ type }),
      });

      if (res.ok) {
        setArticles((prev) =>
          prev.map((a) =>
            a._id === articleId
              ? { ...a, userFeedback: type }
              : a
          )
        );
        setToast({ message: "Thanks for your feedback!", type: "success" });
      }
    } catch {
      setToast({ message: "Failed to send feedback", type: "error" });
    } finally {
      setFeedbackSending((prev) => {
        const next = new Set(prev);
        next.delete(articleId);
        return next;
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Filtered articles
  // ---------------------------------------------------------------------------

  const filteredArticles = category === "all"
    ? articles
    : articles.filter((a) => a.category === category);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8 animate-fade-in">
      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}

      {/* Breadcrumb */}
      <div>
        <Link href="/connect" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
          Connect Hub
        </Link>
        <span className="mx-2 text-zinc-600">/</span>
        <span className="text-sm text-zinc-300">Help & FAQ</span>
      </div>

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Help & FAQ</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Find answers to common questions
        </p>
      </div>

      {/* ================================================================= */}
      {/* Search Bar                                                        */}
      {/* ================================================================= */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          <svg className="h-5 w-5 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-5.197-5.197m0 0A7.5 7.5 0 105.196 5.196a7.5 7.5 0 0010.607 10.607z" />
          </svg>
        </div>
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Search help articles..."
          className="w-full rounded-lg border border-zinc-700 bg-zinc-800 py-2.5 pl-10 pr-4 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
        />
        {searchQuery && (
          <button
            onClick={() => setSearchQuery("")}
            className="absolute inset-y-0 right-0 flex items-center pr-3 text-zinc-500 hover:text-zinc-300"
          >
            <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        )}
      </div>

      {/* ================================================================= */}
      {/* Category Tabs                                                     */}
      {/* ================================================================= */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 pb-px">
        {CATEGORY_TABS.map((tab) => (
          <button
            key={tab.value}
            onClick={() => setCategory(tab.value)}
            className={`whitespace-nowrap rounded-t-lg px-3 py-2 text-sm font-medium transition-colors ${
              category === tab.value
                ? "border-b-2 border-violet-500 text-violet-400"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* ================================================================= */}
      {/* Loading                                                           */}
      {/* ================================================================= */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="animate-pulse rounded-lg border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-center gap-3">
                <div className="h-5 w-5 rounded bg-zinc-800" />
                <div className="h-5 w-2/3 rounded bg-zinc-800" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ================================================================= */}
      {/* Empty State                                                       */}
      {/* ================================================================= */}
      {!loading && filteredArticles.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 py-16">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800">
            <svg className="h-6 w-6 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-zinc-300">
            {debouncedQuery ? "No articles match your search" : "No help articles yet"}
          </h3>
          <p className="mt-1 text-sm text-zinc-500">
            {debouncedQuery
              ? "Try different keywords or browse by category."
              : "Help articles will appear here as they are published."}
          </p>
        </div>
      )}

      {/* ================================================================= */}
      {/* FAQ List                                                          */}
      {/* ================================================================= */}
      {!loading && filteredArticles.length > 0 && (
        <div className="space-y-2">
          {filteredArticles.map((article) => {
            const isExpanded = expandedId === article._id;
            const catCfg = CATEGORY_COLORS[article.category] || CATEGORY_COLORS.technical;

            return (
              <div key={article._id} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-700">
                {/* Question (toggle) */}
                <button
                  onClick={() => setExpandedId(isExpanded ? null : article._id)}
                  className="flex w-full items-start gap-3 px-5 py-4 text-left"
                >
                  {/* Expand icon */}
                  <svg
                    className={`mt-0.5 h-4 w-4 shrink-0 text-zinc-500 transition-transform ${isExpanded ? "rotate-90" : ""}`}
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M8.25 4.5l7.5 7.5-7.5 7.5" />
                  </svg>

                  <div className="min-w-0 flex-1">
                    <h3 className="text-sm font-semibold text-zinc-100">
                      {article.question}
                    </h3>
                  </div>

                  {/* Category badge */}
                  <span className={`shrink-0 inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${catCfg.bg} ${catCfg.text} ${catCfg.border}`}>
                    {article.category === "getting-started" ? "Getting Started" : article.category.charAt(0).toUpperCase() + article.category.slice(1)}
                  </span>
                </button>

                {/* Answer (expanded) */}
                {isExpanded && (
                  <div className="border-t border-zinc-800 px-5 py-4 space-y-4">
                    <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">
                      {article.answer}
                    </p>

                    {/* Feedback */}
                    <div className="flex items-center gap-3 border-t border-zinc-800 pt-3">
                      <span className="text-xs text-zinc-500">Was this helpful?</span>
                      <button
                        onClick={() => handleFeedback(article._id, "up")}
                        disabled={article.userFeedback !== null && article.userFeedback !== undefined}
                        className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                          article.userFeedback === "up"
                            ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
                            : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-emerald-500/30 hover:text-emerald-400"
                        } disabled:cursor-default`}
                      >
                        <svg className="h-3.5 w-3.5" fill={article.userFeedback === "up" ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M6.633 10.5c.806 0 1.533-.446 2.031-1.08a9.041 9.041 0 012.861-2.4c.723-.384 1.35-.956 1.653-1.715a4.498 4.498 0 00.322-1.672V3a.75.75 0 01.75-.75A2.25 2.25 0 0116.5 4.5c0 1.152-.26 2.243-.723 3.218-.266.558.107 1.282.725 1.282h3.126c1.026 0 1.945.694 2.054 1.715.045.422.068.85.068 1.285a11.95 11.95 0 01-2.649 7.521c-.388.482-.987.729-1.605.729H14.23c-.483 0-.964-.078-1.423-.23l-3.114-1.04a4.501 4.501 0 00-1.423-.23H5.904M14.25 9h2.25M5.904 18.75c.083.228.22.442.39.624a2.996 2.996 0 002.566 1.126h.11c1.243 0 2.254-1.01 2.254-2.254a2.25 2.25 0 00-.37-1.246" />
                        </svg>
                        Yes
                      </button>
                      <button
                        onClick={() => handleFeedback(article._id, "down")}
                        disabled={article.userFeedback !== null && article.userFeedback !== undefined}
                        className={`flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium transition-colors ${
                          article.userFeedback === "down"
                            ? "border-red-500/30 bg-red-500/10 text-red-400"
                            : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-red-500/30 hover:text-red-400"
                        } disabled:cursor-default`}
                      >
                        <svg className="h-3.5 w-3.5" fill={article.userFeedback === "down" ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 15h2.25m8.024-9.75c.011.05.028.1.05.148.593 1.2.925 2.55.925 3.977 0 1.487-.36 2.89-.999 4.125m.023-8.25c-.076-.365.183-.75.575-.75h.908c.889 0 1.713.518 1.972 1.368.339 1.11.521 2.287.521 3.507 0 1.553-.295 3.036-.831 4.398C20.613 14.547 19.833 15 19 15h-1.053c-.472 0-.745-.556-.5-.96a8.95 8.95 0 00.303-.54m.023-8.25H16.48a4.5 4.5 0 01-1.423-.23l-3.114-1.04a4.5 4.5 0 00-1.423-.23H6.504c-.618 0-1.217.247-1.605.729A11.95 11.95 0 002.25 12c0 .434.023.863.068 1.285C2.427 14.306 3.346 15 4.372 15h3.126c.618 0 .991.724.725 1.282A7.471 7.471 0 007.5 19.5a2.25 2.25 0 002.25 2.25.75.75 0 00.75-.75v-.633c0-.573.11-1.14.322-1.672.304-.76.93-1.33 1.653-1.715a9.04 9.04 0 002.86-2.4c.5-.634 1.226-1.08 2.032-1.08h.384" />
                        </svg>
                        No
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ================================================================= */}
      {/* AI Chat Placeholder                                               */}
      {/* ================================================================= */}
      <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
        <div className="flex items-center gap-4 px-6 py-5">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-violet-500/20 bg-violet-500/10">
            <svg className="h-5 w-5 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-zinc-300">
              Can&apos;t find what you need?
            </h3>
            <p className="mt-0.5 text-xs text-zinc-500">
              AI-powered chat support is coming soon. In the meantime, submit a bug report or feature request.
            </p>
          </div>
          <button
            disabled
            className="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-500 cursor-not-allowed opacity-50"
          >
            Chat with AI
          </button>
        </div>
      </div>
    </div>
  );
}
