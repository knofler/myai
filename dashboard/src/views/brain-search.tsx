'use client';

// Federated brain search — one query box over BOTH the git-brain atoms
// (sessions/handoffs/memory facts, every repo namespace) and the RAG session
// corpus (STATE.md/handoff/archive vectors, every repo), ranked together.
// Data source: /api/brain/search → gateway `brain_search` tool
// (runtime/src/core/brain-search.ts).

import { Badge } from '@/components/ui/badge';
import { useState, FormEvent } from 'react';

interface BrainSearchHit {
  kind: 'atom' | 'session';
  repo: string;
  score: number;
  snippet: string;
  written: string;
  atomKind?: string;
  path?: string;
  source?: string;
  sessionId?: string;
}

const KIND_STYLE: Record<string, string> = {
  atom: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  session: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
};

function HitKindBadge({ kind }: { kind: string }) {
  return <Badge className={KIND_STYLE[kind]}>{kind}</Badge>;
}

export default function BrainSearch() {
  const [query, setQuery] = useState('');
  const [repo, setRepo] = useState('');
  const [hits, setHits] = useState<BrainSearchHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    setSearched(true);

    try {
      const res = await fetch('/api/brain/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), repo: repo.trim() || undefined, k: 20 }),
      });

      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

      setHits(data.hits ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setHits([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      <form onSubmit={handleSearch} className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="Search across every repo-brain (atoms + sessions)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 px-4 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30"
        />
        <input
          type="text"
          placeholder="repo (optional)"
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          className="w-40 px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-zinc-300 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50"
        />
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="gel-brand px-5 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-zinc-700 disabled:text-zinc-500 disabled:bg-none text-white text-sm font-medium rounded-lg transition-colors"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {error && (
        <div className="mb-4 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          {error}
        </div>
      )}

      {searched && !loading && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {hits.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">
              No atoms or sessions matched &quot;{query}&quot;{repo && ` in repo "${repo}"`}
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-zinc-800 text-xs text-zinc-500">
                {hits.length} result{hits.length !== 1 ? 's' : ''} for &quot;{query}&quot; — ranked across every repo-brain
              </div>
              <div className="divide-y divide-zinc-800/50">
                {hits.map((h, i) => (
                  <div key={`${h.kind}-${h.path ?? h.sessionId ?? i}-${i}`} className="px-4 py-3 hover:bg-zinc-800/30 transition-colors">
                    <div className="flex items-center gap-2 mb-1.5">
                      <HitKindBadge kind={h.kind} />
                      {h.atomKind && (
                        <span className="text-[10px] font-mono text-zinc-600">{h.atomKind}</span>
                      )}
                      {h.source && (
                        <span className="text-[10px] font-mono text-zinc-600">{h.source}</span>
                      )}
                      {h.repo && (
                        <span className="text-[10px] font-mono text-zinc-600">{h.repo}</span>
                      )}
                      <span className="text-[10px] font-mono text-zinc-700 ml-auto">
                        score {h.score.toFixed(2)}
                      </span>
                    </div>
                    <p className="text-sm text-zinc-300 leading-relaxed whitespace-pre-wrap">{h.snippet}</p>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
