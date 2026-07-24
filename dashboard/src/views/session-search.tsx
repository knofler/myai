'use client';

import { SourceBadge } from '@/components/ui/badge';

import { useState, FormEvent } from 'react';

interface VectorResult {
  _id: string;
  repo: string;
  source: string;
  content: string;
  tags: string[];
  sessionId: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export default function SessionSearch({ sources }: { sources: string[] }) {
  const [query, setQuery] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [results, setResults] = useState<VectorResult[]>([]);
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
      const res = await fetch('/api/sessions/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: query.trim(),
          limit: 20,
          source: sourceFilter,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error || `HTTP ${res.status}`);
      }

      const data = await res.json();
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setResults([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div>
      {/* Search form */}
      <form onSubmit={handleSearch} className="flex gap-3 mb-4">
        <input
          type="text"
          placeholder="Search RAG corpus (regex-capable)..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="flex-1 px-4 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-500/50 focus:ring-1 focus:ring-emerald-500/30"
        />
        <select
          value={sourceFilter}
          onChange={(e) => setSourceFilter(e.target.value)}
          className="px-3 py-2 bg-zinc-950 border border-zinc-700 rounded-lg text-sm text-zinc-300 focus:outline-none focus:border-emerald-500/50"
        >
          <option value="all">All sources</option>
          {sources.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={loading || !query.trim()}
          className="gel-brand px-5 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-zinc-700 disabled:text-zinc-500 disabled:bg-none text-white text-sm font-medium rounded-lg transition-colors"
        >
          {loading ? 'Searching...' : 'Search'}
        </button>
      </form>

      {/* Error */}
      {error && (
        <div className="mb-4 px-4 py-2 bg-red-500/10 border border-red-500/20 rounded-lg text-sm text-red-400">
          {error}
        </div>
      )}

      {/* Results */}
      {searched && !loading && (
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
          {results.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">
              No vectors matched &quot;{query}&quot;
              {sourceFilter !== 'all' && ` in source "${sourceFilter}"`}
            </div>
          ) : (
            <>
              <div className="px-4 py-3 border-b border-zinc-800 text-xs text-zinc-500">
                {results.length} result{results.length !== 1 ? 's' : ''} for &quot;{query}&quot;
                {sourceFilter !== 'all' && ` in ${sourceFilter}`}
              </div>
              <div className="divide-y divide-zinc-800/50">
                {results.map((v) => (
                  <div key={v._id} className="px-4 py-3 hover:bg-zinc-800/30 transition-colors">
                    <div className="flex items-center gap-2 mb-1.5">
                      <SourceBadge source={v.source} />
                      {v.repo && (
                        <span className="text-[10px] font-mono text-zinc-600">
                          {v.repo}
                        </span>
                      )}
                      {v.sessionId && (
                        <span className="text-[10px] font-mono text-zinc-600">
                          session:{v.sessionId.slice(0, 8)}
                        </span>
                      )}
                      {v.createdAt && (
                        <span className="text-[10px] text-zinc-600 ml-auto">
                          {new Date(v.createdAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                    <p className="text-sm text-zinc-300 leading-relaxed line-clamp-3 whitespace-pre-wrap">
                      {v.content}
                    </p>
                    {v.tags && v.tags.length > 0 && (
                      <div className="flex gap-1.5 mt-1.5">
                        {v.tags.map((t) => (
                          <span
                            key={t}
                            className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-800 text-zinc-500 rounded"
                          >
                            {t}
                          </span>
                        ))}
                      </div>
                    )}
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
