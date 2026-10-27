'use client';

// /ask — put a question to a specialist agent without leaving the dashboard.
//
// The gateway has carried `agents_invoke` all along; nothing on the web side
// ever called it, so every LLM question had to start in a terminal. This is the
// smallest surface that closes that: pick an agent, ground it in a repo, ask.
//
// Answers route through the `budget` tier — DeepSeek — and the reply header
// states the provider and model that actually served each one. That is not
// decoration: an agent's own prose will cheerfully misreport itself (a DeepSeek
// call through a Claude-authored agent file opens with "I'm running as
// Claude"), and only the routing metadata is authoritative.

import { useEffect, useMemo, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState } from '@/components/ui/card';
import { plural, cap } from '@/lib/summary';
import type { AskResult } from '@/app/api/ask/route';

interface AgentOption {
  name: string;
  category: string;
}

/** The §5.1 one-line answer, read off state that is actually loaded — never a
 *  claim the page cannot support. Before a question is asked it says what the
 *  page is for, because there is no answer yet to describe. */
function askSummary(
  agentCount: number,
  agent: string,
  repo: string,
  loading: boolean,
  error: string | null,
  result: AskResult | null,
): string {
  if (loading) return `Asking ${agent}…`;
  if (error) return `That question did not run. ${error}`;
  if (result) {
    const seconds = (result.elapsedMs / 1000).toFixed(1);
    const grounded = result.memoryContextIncluded ? ` grounded in ${repo}` : '';
    return `${cap(result.agent)} answered in ${seconds}s via ${result.provider} (${result.model})${grounded}, spending ${plural(
      result.outputTokens,
      'output token',
    )}.`;
  }
  if (agentCount === 0) {
    return 'Ask one of your specialist agents a question. The agent roster is still loading from the gateway.';
  }
  return `Ask any of your ${plural(
    agentCount,
    'specialist agent',
  )} a question and get the answer here. Name a repo and the agent reads that repo's live state before it replies.`;
}

export default function AskPage() {
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agent, setAgent] = useState('solution-architect');
  const [repo, setRepo] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<AskResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/ask')
      .then((r) => r.json())
      .then((d: { agents?: AgentOption[] }) => {
        if (!cancelled && Array.isArray(d.agents)) setAgents(d.agents);
      })
      .catch(() => {
        /* The picker falls back to a plain text field; the ask still works. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Grouped so a 62-entry flat list is navigable.
  const grouped = useMemo(() => {
    const by = new Map<string, AgentOption[]>();
    for (const a of agents) {
      const list = by.get(a.category) ?? [];
      list.push(a);
      by.set(a.category, list);
    }
    return [...by.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [agents]);

  async function ask(e: React.FormEvent) {
    e.preventDefault();
    if (!message.trim() || loading) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent, message: message.trim(), repo: repo.trim() || undefined }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data?.error ?? `request failed (${res.status})`);
      } else {
        setResult(data as AskResult);
      }
    } catch {
      setError('the dashboard could not reach its own API route');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <PageHeader
        icon="brain"
        title="Ask"
        summary={askSummary(agents.length, agent, repo, loading, error, result)}
        subtitle="Specialist agents · answered on the budget tier (DeepSeek)"
      />

      <form onSubmit={ask} className="mt-6 space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <label className="flex-1 min-w-0">
            <span className="block text-label text-[rgb(var(--text-muted))] mb-1">Agent</span>
            <select
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className="w-full bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg px-3 py-2.5 text-sm text-[rgb(var(--text-primary))] focus:outline-none focus:border-teal-500/60 focus-visible:ring-2 focus-visible:ring-teal-500/50"
            >
              {grouped.length === 0 ? (
                <option value={agent}>{agent}</option>
              ) : (
                grouped.map(([category, list]) => (
                  <optgroup key={category} label={category}>
                    {list.map((a) => (
                      <option key={a.name} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                  </optgroup>
                ))
              )}
            </select>
          </label>

          <label className="flex-1 min-w-0">
            <span className="block text-label text-[rgb(var(--text-muted))] mb-1">
              Ground in repo (optional)
            </span>
            <input
              type="text"
              value={repo}
              onChange={(e) => setRepo(e.target.value)}
              placeholder="e.g. ai_management"
              className="w-full bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg px-3 py-2.5 text-sm text-[rgb(var(--text-primary))] placeholder-zinc-600 focus:outline-none focus:border-teal-500/60 focus-visible:ring-2 focus-visible:ring-teal-500/50"
            />
          </label>
        </div>

        <label className="block">
          <span className="block text-label text-[rgb(var(--text-muted))] mb-1">Question</span>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter submits — the expected reflex in a box this shape.
              if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') ask(e as unknown as React.FormEvent);
            }}
            rows={5}
            autoFocus
            placeholder="Ask anything — architecture calls, a security read on a change, why a run failed…"
            className="w-full bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg px-4 py-3 text-sm text-[rgb(var(--text-primary))] placeholder-zinc-600 focus:outline-none focus:border-teal-500/60 focus-visible:ring-2 focus-visible:ring-teal-500/50 resize-y"
          />
        </label>

        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={loading || !message.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-teal-500/15 text-teal-300 border border-teal-500/40 hover:bg-teal-500/25 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {loading ? 'Asking…' : 'Ask'}
          </button>
          <span className="text-meta text-[rgb(var(--text-secondary))]">
            ⌘↵ to send · billed per question, outside the subscription bucket
          </span>
        </div>
      </form>

      <Card className="mt-6">
        {loading ? (
          <EmptyState>Waiting on {agent}…</EmptyState>
        ) : error ? (
          <EmptyState>{error}</EmptyState>
        ) : !result ? (
          <EmptyState>Your answer appears here.</EmptyState>
        ) : (
          <div className="p-4">
            <div className="flex flex-wrap items-center gap-2 pb-3 mb-3 border-b border-[rgb(var(--border-subtle))]/60">
              <span className="text-label px-1.5 py-0.5 rounded bg-teal-500/10 text-teal-300">
                {result.agent}
              </span>
              <span className="text-xs text-[rgb(var(--text-muted))]">
                {result.provider} · {result.model}
              </span>
              <span className="text-xs text-[rgb(var(--text-muted))]">
                {result.inputTokens} in · {result.outputTokens} out
              </span>
              {result.memoryContextIncluded && (
                <span className="text-label px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-300">
                  grounded
                </span>
              )}
            </div>
            <div className="text-sm text-[rgb(var(--text-primary))] whitespace-pre-wrap leading-relaxed">
              {result.content}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
