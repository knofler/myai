'use client';

// /search — cross-entity search results: tasks, plans, directory repos, and
// brain atoms/sessions in one ranked list, backed by /api/search (lib/search.ts).
// Distinct from the Cmd-K palette (⌘K): the palette only jumps to nav/repo/
// tenant/action shortcuts, this page searches entity *content* and shows
// full results with snippets.

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState } from '@/components/ui/card';
import type { SearchHit, SearchHitKind } from '@/lib/search';

interface SearchResponse {
  query: string;
  count: number;
  groups: Record<SearchHitKind, SearchHit[]>;
  results: SearchHit[];
  error?: string;
}

type FilterTab = 'all' | SearchHitKind;

const KIND_LABEL: Record<SearchHitKind, string> = {
  task: 'Task',
  plan: 'Plan',
  repo: 'Repo',
  atom: 'Brain atom',
  session: 'Session',
};

const KIND_ACCENT: Record<SearchHitKind, string> = {
  task: 'text-teal-300 bg-teal-500/10',
  plan: 'text-purple-300 bg-purple-500/10',
  repo: 'text-blue-300 bg-blue-500/10',
  atom: 'text-amber-300 bg-amber-500/10',
  session: 'text-zinc-300 bg-zinc-500/10',
};

const EMPTY_GROUPS: Record<SearchHitKind, SearchHit[]> = { task: [], plan: [], repo: [], atom: [], session: [] };

function ResultRow({ hit }: { hit: SearchHit }) {
  return (
    <Link
      href={hit.href}
      className="block px-4 py-3 border-b border-zinc-800/60 last:border-b-0 hover:bg-zinc-800/40 transition-colors"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${KIND_ACCENT[hit.kind]}`}>
          {KIND_LABEL[hit.kind]}
        </span>
        {hit.repo && <span className="text-xs text-zinc-500">{hit.repo}</span>}
      </div>
      <div className="text-sm text-zinc-200 mt-1">{hit.title}</div>
      {hit.snippet && <div className="text-xs text-zinc-500 mt-0.5 line-clamp-2">{hit.snippet}</div>}
    </Link>
  );
}

function SearchPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQ = searchParams.get('q') ?? '';

  const [input, setInput] = useState(initialQ);
  const [query, setQuery] = useState(initialQ);
  const [tab, setTab] = useState<FilterTab>('all');
  const [data, setData] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the URL bookmarkable/shareable without a round-trip per keystroke.
  useEffect(() => {
    const url = query ? `/search?q=${encodeURIComponent(query)}` : '/search';
    router.replace(url);
  }, [query, router]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setData(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/search?q=${encodeURIComponent(q)}`)
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) throw new Error(json?.error || 'search failed');
        return json as SearchResponse;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'search failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [query]);

  const groups = data?.groups ?? EMPTY_GROUPS;

  const tabs: { id: FilterTab; label: string; count: number }[] = useMemo(
    () => [
      { id: 'all', label: 'All', count: data?.results.length ?? 0 },
      { id: 'task', label: 'Tasks', count: groups.task.length },
      { id: 'plan', label: 'Plans', count: groups.plan.length },
      { id: 'repo', label: 'Repos', count: groups.repo.length },
      { id: 'atom', label: 'Brain atoms', count: groups.atom.length },
      { id: 'session', label: 'Sessions', count: groups.session.length },
    ],
    [data, groups],
  );

  const visible: SearchHit[] = tab === 'all' ? (data?.results ?? []) : groups[tab];

  return (
    <div>
      <PageHeader title="Search" subtitle="tasks · plans · repos · brain atoms — cross-entity, tenant-scoped" />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(input);
        }}
        className="mb-4"
      >
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="Search tasks, plans, repos, brain atoms…"
          autoFocus
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-2.5 text-sm text-zinc-100 placeholder-zinc-600 focus:outline-none focus:border-teal-500/60"
        />
      </form>

      {query.trim() && (
        <div className="flex flex-wrap gap-1 mb-4 border-b border-zinc-800 -mb-px">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm border-b-2 transition-colors ${
                tab === t.id ? 'border-teal-400 text-zinc-100 font-medium' : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              {t.label}
              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${tab === t.id ? 'bg-teal-500/15 text-teal-300' : 'bg-zinc-800 text-zinc-500'}`}>
                {t.count}
              </span>
            </button>
          ))}
        </div>
      )}

      <Card className="mt-6">
        {!query.trim() ? (
          <EmptyState>Type a query to search across tasks, plans, repos, and the brain.</EmptyState>
        ) : loading ? (
          <EmptyState>Searching…</EmptyState>
        ) : error ? (
          <EmptyState>Search failed: {error}</EmptyState>
        ) : visible.length === 0 ? (
          <EmptyState>No results for &ldquo;{query}&rdquo;.</EmptyState>
        ) : (
          <div>
            {visible.map((hit) => (
              <ResultRow key={`${hit.kind}-${hit.id}`} hit={hit} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

export default function SearchPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <SearchPageInner />
    </Suspense>
  );
}
