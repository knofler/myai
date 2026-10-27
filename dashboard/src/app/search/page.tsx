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
import { plural, joinClauses, cap } from '@/lib/summary';
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
  session: 'text-[rgb(var(--text-primary))] bg-zinc-500/10',
};

const EMPTY_GROUPS: Record<SearchHitKind, SearchHit[]> = { task: [], plan: [], repo: [], atom: [], session: [] };

/** The one-line answer (DESIGN_LANGUAGE §5.1) — what this query found and where
 *  it found it, from the response already in state. Before a query is typed it
 *  says what the page is for, since there is nothing loaded to count. */
function searchSummary(
  query: string,
  total: number,
  groups: Record<SearchHitKind, SearchHit[]>,
  loading: boolean,
  error: string | null,
): string {
  const q = query.trim();
  if (!q) return 'Search everything your AI knows: tasks, plans, repos, brain atoms and past sessions, in one ranked list.';
  if (loading) return `Searching for ${q}...`;
  if (error) return `That search did not run. ${error}`;
  if (total === 0) return `Nothing matches ${q}. Try a shorter word or a repo name.`;
  const where = joinClauses([
    groups.task.length > 0 && plural(groups.task.length, 'task'),
    groups.plan.length > 0 && plural(groups.plan.length, 'plan'),
    groups.repo.length > 0 && plural(groups.repo.length, 'repo'),
    groups.atom.length > 0 && plural(groups.atom.length, 'brain atom'),
    groups.session.length > 0 && plural(groups.session.length, 'session'),
  ]);
  const head = `${cap(plural(total, 'result'))} for ${q}.`;
  return where ? `${head} ${cap(where)}.` : head;
}

function ResultRow({ hit }: { hit: SearchHit }) {
  return (
    <Link
      href={hit.href}
      className="block px-4 py-3 border-b border-[rgb(var(--border-subtle))]/60 last:border-b-0 hover:bg-[rgb(var(--bg-hover))]/40 transition-colors"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <span className={`text-label px-1.5 py-0.5 rounded ${KIND_ACCENT[hit.kind]}`}>
          {KIND_LABEL[hit.kind]}
        </span>
        {hit.repo && <span className="text-xs text-[rgb(var(--text-muted))]">{hit.repo}</span>}
      </div>
      <div className="text-sm text-[rgb(var(--text-primary))] mt-1">{hit.title}</div>
      {hit.snippet && <div className="text-xs text-[rgb(var(--text-muted))] mt-0.5 line-clamp-2">{hit.snippet}</div>}
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
      <PageHeader
        icon="search"
        title="Search"
        summary={searchSummary(query, data?.results.length ?? 0, groups, loading, error)}
        subtitle="Tasks · plans · repos · brain atoms · sessions"
      />

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
          aria-label="Search tasks, plans, repos, brain atoms"
          autoFocus
          className="w-full bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg px-4 py-2.5 text-sm text-[rgb(var(--text-primary))] placeholder-zinc-600 focus:outline-none focus:border-teal-500/60 focus-visible:ring-2 focus-visible:ring-teal-500/50"
        />
      </form>

      {query.trim() && (
        <div className="flex flex-wrap gap-1 mb-4 border-b border-[rgb(var(--border-subtle))] -mb-px">
          {tabs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-3 py-2 text-sm border-b-2 transition-colors ${
                tab === t.id ? 'border-teal-400 text-[rgb(var(--text-primary))] font-medium' : 'border-transparent text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]'
              }`}
            >
              {t.label}
              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${tab === t.id ? 'bg-teal-500/15 text-teal-300' : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]'}`}>
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
