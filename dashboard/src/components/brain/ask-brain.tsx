'use client';

// The primary /brain view's search box — plain language in, plain language
// out. Hits the same gateway-backed endpoint the Advanced tab's raw search
// uses (/api/brain/search), but the result cards drop every store-internal
// label (kind, score, path) so this stays readable to someone who has never
// heard of the underlying store.

import { useState, FormEvent } from 'react';

interface AskHit {
  repo?: string;
  snippet: string;
}

export default function AskBrain() {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<AskHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/brain/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: q, k: 8 }),
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      setHits((data.hits ?? []).map((h: { repo?: string; snippet: string }) => ({ repo: h.repo, snippet: h.snippet })));
    } catch {
      setError("Couldn't reach what I know right now — try again in a moment.");
      setHits(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      <form onSubmit={onSubmit} className="relative">
        <span aria-hidden="true" className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[rgb(var(--text-muted))]">⌕</span>
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Ask your brain anything…"
          aria-label="Ask your brain anything"
          className="w-full rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] py-3 pl-10 pr-16 text-sm text-[rgb(var(--text-primary))] placeholder:text-[rgb(var(--text-muted))] focus:outline-none focus:border-teal-500/50 focus:ring-1 focus:ring-teal-500/30"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg px-3 py-1.5 text-xs font-medium text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] disabled:opacity-40"
        >
          {loading ? '…' : 'Ask'}
        </button>
      </form>

      {error && <p role="alert" className="mt-2 text-xs text-red-400">{error}</p>}

      {hits && (
        <div className="mt-3 overflow-hidden rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/70 text-left">
          {hits.length === 0 ? (
            <p className="p-4 text-sm text-[rgb(var(--text-muted))]">Nothing in what I know matches that yet.</p>
          ) : (
            <ul className="divide-y divide-[rgb(var(--border-subtle))]/50">
              {hits.map((h, i) => (
                <li key={i} className="px-4 py-3">
                  <p className="text-sm leading-relaxed text-[rgb(var(--text-primary))]">{h.snippet}</p>
                  {h.repo && <p className="mt-1 text-xs text-[rgb(var(--text-muted))]">{h.repo}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
