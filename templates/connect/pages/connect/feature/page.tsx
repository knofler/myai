"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Priority = "must-have" | "should-have" | "nice-to-have";
type FeatureStatus = "reported" | "triaged" | "working" | "solved" | "deployed" | "rejected";
type SortMode = "newest" | "votes";

interface FeatureRequest {
  _id: string;
  title: string;
  description: string;
  userStory?: string;
  proposedSolution?: string;
  priority: Priority;
  status: FeatureStatus;
  votes: number;
  hasVoted?: boolean;
  reporter: "user" | "ai";
  userId?: { name?: string; email?: string } | string;
  aiAnalysis?: string;
  implementationPlan?: string;
  prLink?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PRIORITY_CONFIG: Record<Priority, { label: string; bg: string; text: string; border: string }> = {
  "must-have": { label: "Must Have", bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/30" },
  "should-have": { label: "Should Have", bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30" },
  "nice-to-have": { label: "Nice to Have", bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/30" },
};

const STATUS_CONFIG: Record<FeatureStatus, { label: string; bg: string; text: string; border: string }> = {
  reported: { label: "Reported", bg: "bg-zinc-500/10", text: "text-zinc-400", border: "border-zinc-500/30" },
  triaged: { label: "Triaged", bg: "bg-blue-500/10", text: "text-blue-400", border: "border-blue-500/30" },
  working: { label: "Working", bg: "bg-amber-500/10", text: "text-amber-400", border: "border-amber-500/30" },
  solved: { label: "Solved", bg: "bg-emerald-500/10", text: "text-emerald-400", border: "border-emerald-500/30" },
  deployed: { label: "Deployed", bg: "bg-violet-500/10", text: "text-violet-400", border: "border-violet-500/30" },
  rejected: { label: "Rejected", bg: "bg-red-500/10", text: "text-red-400", border: "border-red-500/30" },
};

const STATUS_TABS: Array<{ value: FeatureStatus | "all"; label: string }> = [
  { value: "all", label: "All" },
  { value: "reported", label: "Reported" },
  { value: "working", label: "Working" },
  { value: "solved", label: "Solved" },
  { value: "deployed", label: "Deployed" },
];

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

export default function FeatureRequestsPage() {
  // Form state
  const [formOpen, setFormOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [userStory, setUserStory] = useState("");
  const [proposedSolution, setProposedSolution] = useState("");
  const [priority, setPriority] = useState<Priority>("should-have");
  const [submitting, setSubmitting] = useState(false);

  // List state
  const [features, setFeatures] = useState<FeatureRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<FeatureStatus | "all">("all");
  const [sortMode, setSortMode] = useState<SortMode>("newest");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [votingIds, setVotingIds] = useState<Set<string>>(new Set());

  // Toast
  const [toast, setToast] = useState<{ message: string; type: "success" | "error" } | null>(null);

  // ---------------------------------------------------------------------------
  // Data Fetching
  // ---------------------------------------------------------------------------

  const fetchFeatures = useCallback(async () => {
    try {
      const res = await fetch("/api/connect/features", { credentials: "include" });
      if (res.ok) {
        const data = await res.json();
        const items = (data.data || data.features || []).map((f: Record<string, unknown>) => ({
          ...f,
          votes: f.upvotes ?? f.votes ?? 0,
        }));
        setFeatures(items);
      }
    } catch {
      // Silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchFeatures();
  }, [fetchFeatures]);

  // ---------------------------------------------------------------------------
  // Form Submit
  // ---------------------------------------------------------------------------

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !description.trim()) return;

    setSubmitting(true);
    try {
      const res = await fetch("/api/connect/features", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          title: title.trim(),
          description: description.trim(),
          userProblem: userStory.trim() || undefined,
          proposedSolution: proposedSolution.trim() || undefined,
          priority,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to submit feature request");
      }

      setToast({ message: "Feature request submitted successfully", type: "success" });
      setTitle("");
      setDescription("");
      setUserStory("");
      setProposedSolution("");
      setPriority("should-have");
      setFormOpen(false);
      setLoading(true);
      fetchFeatures();
    } catch (err) {
      setToast({
        message: err instanceof Error ? err.message : "Failed to submit feature request",
        type: "error",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Vote Handler
  // ---------------------------------------------------------------------------

  const handleVote = async (featureId: string) => {
    if (votingIds.has(featureId)) return;

    setVotingIds((prev) => new Set(prev).add(featureId));
    try {
      const res = await fetch(`/api/connect/features/${featureId}/vote`, {
        method: "POST",
        credentials: "include",
      });

      if (res.ok) {
        const data = await res.json();
        setFeatures((prev) =>
          prev.map((f) =>
            f._id === featureId
              ? { ...f, votes: data.data?.upvotes ?? f.votes + (f.hasVoted ? -1 : 1), hasVoted: data.data?.voted ?? !f.hasVoted }
              : f
          )
        );
      }
    } catch {
      // Silently fail
    } finally {
      setVotingIds((prev) => {
        const next = new Set(prev);
        next.delete(featureId);
        return next;
      });
    }
  };

  // ---------------------------------------------------------------------------
  // Filtered + Sorted
  // ---------------------------------------------------------------------------

  const filteredFeatures = (statusFilter === "all"
    ? features
    : features.filter((f) => f.status === statusFilter)
  ).sort((a, b) => {
    if (sortMode === "votes") return (b.votes || 0) - (a.votes || 0);
    return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
  });

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="mx-auto max-w-5xl space-y-6 px-4 py-8 sm:px-6 lg:px-8 animate-fade-in">
      {/* Toast */}
      {toast && <Toast message={toast.message} type={toast.type} onDismiss={() => setToast(null)} />}

      {/* Breadcrumb + Header */}
      <div>
        <Link href="/connect" className="text-sm text-zinc-500 hover:text-zinc-300 transition-colors">
          Connect Hub
        </Link>
        <span className="mx-2 text-zinc-600">/</span>
        <span className="text-sm text-zinc-300">Feature Requests</span>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Feature Requests</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Suggest ideas and vote on what gets built next
          </p>
        </div>
        <button
          onClick={() => setFormOpen(!formOpen)}
          className="flex items-center gap-2 rounded-lg border border-violet-500/30 bg-violet-500/10 px-4 py-2 text-sm font-medium text-violet-400 transition-colors hover:bg-violet-500/20"
        >
          {formOpen ? (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
              </svg>
              Close
            </>
          ) : (
            <>
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
              </svg>
              Request Feature
            </>
          )}
        </button>
      </div>

      {/* ================================================================= */}
      {/* Request Form (Collapsible)                                        */}
      {/* ================================================================= */}
      {formOpen && (
        <form onSubmit={handleSubmit} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900">
          <div className="border-b border-zinc-800 px-6 py-4">
            <h2 className="text-base font-semibold text-zinc-100">Request a Feature</h2>
            <p className="mt-1 text-sm text-zinc-500">Describe the feature you would like to see</p>
          </div>

          <div className="space-y-5 p-6">
            {/* Title */}
            <div>
              <label htmlFor="feat-title" className="mb-1.5 block text-sm font-medium text-zinc-300">
                Title <span className="text-red-400">*</span>
              </label>
              <input
                id="feat-title"
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Short name for the feature"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </div>

            {/* Description */}
            <div>
              <label htmlFor="feat-desc" className="mb-1.5 block text-sm font-medium text-zinc-300">
                Description <span className="text-red-400">*</span>
              </label>
              <textarea
                id="feat-desc"
                required
                rows={3}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What problem does this feature solve?"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-y"
              />
            </div>

            {/* User Story */}
            <div>
              <label htmlFor="feat-story" className="mb-1.5 block text-sm font-medium text-zinc-300">
                User Story <span className="text-zinc-500">(optional)</span>
              </label>
              <textarea
                id="feat-story"
                rows={2}
                value={userStory}
                onChange={(e) => setUserStory(e.target.value)}
                placeholder="As a user, I want... so that..."
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-y"
              />
            </div>

            {/* Proposed Solution */}
            <div>
              <label htmlFor="feat-solution" className="mb-1.5 block text-sm font-medium text-zinc-300">
                Proposed Solution <span className="text-zinc-500">(optional)</span>
              </label>
              <textarea
                id="feat-solution"
                rows={2}
                value={proposedSolution}
                onChange={(e) => setProposedSolution(e.target.value)}
                placeholder="How do you envision this working?"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500 resize-y"
              />
            </div>

            {/* Priority */}
            <div>
              <label className="mb-1.5 block text-sm font-medium text-zinc-300">Priority</label>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(PRIORITY_CONFIG) as Priority[]).map((pri) => {
                  const cfg = PRIORITY_CONFIG[pri];
                  const isActive = priority === pri;
                  return (
                    <button
                      key={pri}
                      type="button"
                      onClick={() => setPriority(pri)}
                      className={`rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors ${
                        isActive
                          ? `${cfg.bg} ${cfg.text} ${cfg.border}`
                          : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                      }`}
                    >
                      {cfg.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Submit */}
            <div className="flex justify-end border-t border-zinc-800 pt-4">
              <button
                type="button"
                onClick={() => setFormOpen(false)}
                className="mr-3 rounded-lg px-4 py-2 text-sm font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submitting || !title.trim() || !description.trim()}
                className="flex items-center gap-2 rounded-lg bg-violet-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? (
                  <>
                    <svg className="h-4 w-4 animate-spin" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                    </svg>
                    Submitting...
                  </>
                ) : (
                  "Submit Feature Request"
                )}
              </button>
            </div>
          </div>
        </form>
      )}

      {/* ================================================================= */}
      {/* Feature List                                                      */}
      {/* ================================================================= */}

      {/* Filter + Sort Row */}
      <div className="flex items-center justify-between gap-4">
        {/* Status tabs */}
        <div className="flex items-center gap-1 overflow-x-auto border-b border-zinc-800 pb-px">
          {STATUS_TABS.map((tab) => (
            <button
              key={tab.value}
              onClick={() => setStatusFilter(tab.value)}
              className={`whitespace-nowrap rounded-t-lg px-3 py-2 text-sm font-medium transition-colors ${
                statusFilter === tab.value
                  ? "border-b-2 border-violet-500 text-violet-400"
                  : "text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Sort toggle */}
        <div className="flex shrink-0 items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
          <button
            onClick={() => setSortMode("newest")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              sortMode === "newest"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Newest
          </button>
          <button
            onClick={() => setSortMode("votes")}
            className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
              sortMode === "votes"
                ? "bg-zinc-800 text-zinc-100"
                : "text-zinc-500 hover:text-zinc-300"
            }`}
          >
            Most Voted
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="animate-pulse rounded-lg border border-zinc-800 bg-zinc-900 p-5">
              <div className="flex items-start gap-4">
                <div className="h-10 w-10 rounded-lg bg-zinc-800" />
                <div className="flex-1">
                  <div className="h-5 w-48 rounded bg-zinc-800" />
                  <div className="mt-2 h-3 w-3/4 rounded bg-zinc-800" />
                </div>
                <div className="flex gap-2">
                  <div className="h-5 w-16 rounded-full bg-zinc-800" />
                  <div className="h-5 w-16 rounded-full bg-zinc-800" />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Empty State */}
      {!loading && filteredFeatures.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 py-16">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-zinc-800">
            <svg className="h-6 w-6 text-zinc-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
            </svg>
          </div>
          <h3 className="text-sm font-semibold text-zinc-300">
            {statusFilter === "all" ? "No feature requests yet" : `No ${statusFilter} features`}
          </h3>
          <p className="mt-1 text-sm text-zinc-500">
            {statusFilter === "all"
              ? "Be the first to suggest something! Click \"Request Feature\" above."
              : "Try a different filter to see other requests."}
          </p>
        </div>
      )}

      {/* Feature Cards */}
      {!loading && filteredFeatures.length > 0 && (
        <div className="space-y-3">
          {filteredFeatures.map((feature) => {
            const priCfg = PRIORITY_CONFIG[feature.priority] || PRIORITY_CONFIG["should-have"];
            const statusCfg = STATUS_CONFIG[feature.status] || STATUS_CONFIG.reported;
            const isExpanded = expandedId === feature._id;

            return (
              <div key={feature._id} className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900 transition-colors hover:border-zinc-700">
                {/* Summary Row */}
                <div className="flex items-start gap-3 px-5 py-4">
                  {/* Vote Button */}
                  <button
                    onClick={() => handleVote(feature._id)}
                    disabled={votingIds.has(feature._id)}
                    className={`flex shrink-0 flex-col items-center gap-0.5 rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                      feature.hasVoted
                        ? "border-violet-500/40 bg-violet-500/10 text-violet-400"
                        : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-violet-500/30 hover:text-violet-400"
                    } disabled:opacity-50`}
                    title={feature.hasVoted ? "Remove vote" : "Upvote"}
                  >
                    <svg className="h-3.5 w-3.5" fill={feature.hasVoted ? "currentColor" : "none"} viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
                    </svg>
                    <span>{feature.votes || 0}</span>
                  </button>

                  {/* Content */}
                  <button
                    onClick={() => setExpandedId(isExpanded ? null : feature._id)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <div className="flex items-start justify-between gap-3">
                      <h3 className="text-sm font-semibold text-zinc-100 truncate">
                        {feature.title}
                      </h3>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${priCfg.bg} ${priCfg.text} ${priCfg.border}`}>
                          {priCfg.label}
                        </span>
                        <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${statusCfg.bg} ${statusCfg.text} ${statusCfg.border}`}>
                          {statusCfg.label}
                        </span>
                      </div>
                    </div>
                    <p className="mt-1 text-xs text-zinc-500 truncate">
                      {feature.description}
                    </p>
                    <div className="mt-2 flex items-center gap-3 text-xs text-zinc-500">
                      <span>{new Date(feature.createdAt).toLocaleDateString()}</span>
                      <span className="inline-flex items-center gap-1">
                        {feature.reporter === "ai" ? (
                          <>
                            <svg className="h-3 w-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                              <path strokeLinecap="round" strokeLinejoin="round" d="M9.813 15.904L9 18.75l-.813-2.846a4.5 4.5 0 00-3.09-3.09L2.25 12l2.846-.813a4.5 4.5 0 003.09-3.09L9 5.25l.813 2.846a4.5 4.5 0 003.09 3.09L15.75 12l-2.846.813a4.5 4.5 0 00-3.09 3.09z" />
                            </svg>
                            AI
                          </>
                        ) : (feature.userId as { name?: string })?.name || "User"}
                      </span>
                      <svg className={`ml-auto h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
                      </svg>
                    </div>
                  </button>
                </div>

                {/* Expanded Details */}
                {isExpanded && (
                  <div className="border-t border-zinc-800 px-5 py-4 space-y-4">
                    <div>
                      <h4 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Description</h4>
                      <p className="mt-1 text-sm text-zinc-300 whitespace-pre-wrap">{feature.description}</p>
                    </div>

                    {feature.userStory && (
                      <div>
                        <h4 className="text-xs font-medium uppercase tracking-wider text-zinc-500">User Story</h4>
                        <p className="mt-1 text-sm text-zinc-300 italic whitespace-pre-wrap">{feature.userStory}</p>
                      </div>
                    )}

                    {feature.proposedSolution && (
                      <div>
                        <h4 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Proposed Solution</h4>
                        <p className="mt-1 text-sm text-zinc-300 whitespace-pre-wrap">{feature.proposedSolution}</p>
                      </div>
                    )}

                    {feature.aiAnalysis && (
                      <div className="rounded-lg border border-violet-500/20 bg-violet-500/5 p-3">
                        <h4 className="text-xs font-medium uppercase tracking-wider text-violet-400">AI Analysis</h4>
                        <p className="mt-1 text-sm text-zinc-300 whitespace-pre-wrap">{feature.aiAnalysis}</p>
                      </div>
                    )}

                    {feature.implementationPlan && (
                      <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                        <h4 className="text-xs font-medium uppercase tracking-wider text-emerald-400">Implementation Plan</h4>
                        <p className="mt-1 text-sm text-zinc-300 whitespace-pre-wrap">{feature.implementationPlan}</p>
                      </div>
                    )}

                    {feature.prLink && (
                      <div>
                        <h4 className="text-xs font-medium uppercase tracking-wider text-zinc-500">Pull Request</h4>
                        <a
                          href={feature.prLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-sm text-violet-400 hover:text-violet-300 transition-colors"
                        >
                          {feature.prLink}
                          <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13.5 6H5.25A2.25 2.25 0 003 8.25v10.5A2.25 2.25 0 005.25 21h10.5A2.25 2.25 0 0018 18.75V10.5m-10.5 6L21 3m0 0h-5.25M21 3v5.25" />
                          </svg>
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
