'use client';

// Linear-style issue list (task-da118c3d) — the dense, priority-led row used
// by /work's Up Next / Running / Needs You tabs instead of a bordered table.
// One row = priority chip + title + repo/age meta + category tags, no cell
// borders, no column headers. Search still filters client-side (same
// zero-extra-fetch contract as DataTable) so the existing filter behaviour
// (repo/priority/agent/lane chips upstream + this box) is preserved.

import { useMemo, useState } from 'react';
import { SearchInput } from '@/components/search-input';
import { PriorityBadge } from '@/components/ui/badge';

export interface IssueRow {
  id: string;
  search: string;              // lowercase haystack for the search box
  priority?: 'P0' | 'P1' | 'P2' | 'P3';
  title: React.ReactNode;
  href?: string;                // wraps title in a link when present
  meta: React.ReactNode;        // repo · age line
  tags?: React.ReactNode[];     // category chips (agent, work-type, lane…)
  note?: React.ReactNode;       // optional truncated secondary line (e.g. result summary)
  trailing?: React.ReactNode;   // right-aligned actions/badges
}

/** Small muted pill for a category tag — quieter than a status Badge. */
export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs leading-none bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))] whitespace-nowrap">
      {children}
    </span>
  );
}

function Row({ row }: { row: IssueRow }) {
  const titleEl = row.href ? (
    <a href={row.href} target="_blank" rel="noreferrer" className="line-clamp-2 md:line-clamp-1 hover:text-emerald-400 underline decoration-zinc-700">
      {row.title}
    </a>
  ) : (
    <span className="line-clamp-2 md:line-clamp-1">{row.title}</span>
  );
  return (
    // Phone (operator, 2026-09-18: "too tiny … need less info, more easily
    // readable"): body-size title allowed two lines, meta-size repo/age, and
    // only the first two tags — the Operate mockup shows exactly that. Desktop
    // keeps the dense Linear-style row.
    <div role="listitem" className="flex items-start gap-3 px-3 py-3 md:py-2.5 hover:bg-[rgb(var(--bg-hover))]/30 transition-colors">
      <span className="shrink-0 mt-0.5">{row.priority ? <PriorityBadge priority={row.priority} /> : <span className="inline-block w-8" />}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2 text-body md:text-sm text-[rgb(var(--text-primary))] font-medium">{titleEl}</div>
        <div className="mt-0.5 text-meta md:text-xs text-[rgb(var(--text-muted))] truncate">{row.meta}</div>
        {row.tags && row.tags.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1 [&>*:nth-child(n+3)]:hidden md:[&>*:nth-child(n+3)]:inline">
            {row.tags.map((t, i) => <span key={i}>{t}</span>)}
          </div>
        )}
        {row.note && <div className="mt-1 hidden text-xs text-[rgb(var(--text-secondary))] truncate md:block">{row.note}</div>}
      </div>
      {row.trailing && <div className="shrink-0 flex items-center gap-2 text-xs">{row.trailing}</div>}
    </div>
  );
}

export function IssueList({
  title,
  meta,
  rows,
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing here.',
  searchable = true,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  rows: IssueRow[];
  searchPlaceholder?: string;
  emptyText?: React.ReactNode;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter((r) => r.search.includes(q)) : rows;
  }, [rows, query]);

  return (
    <section className="gel-surface bg-[rgb(var(--bg-surface))]/70 border border-[rgb(var(--border-subtle))] rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-[rgb(var(--border-subtle))]/80 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-[rgb(var(--text-primary))]">{title}</h2>
        {searchable && (
          <div className="flex-1 min-w-[160px] max-w-md">
            <SearchInput value={query} onChange={setQuery} placeholder={searchPlaceholder} />
          </div>
        )}
        <span className="ml-auto text-xs text-[rgb(var(--text-muted))]">
          {meta ?? `${visible.length}${query ? ` of ${rows.length}` : ''}`}
        </span>
      </div>
      {visible.length === 0 ? (
        <div className="p-8 text-center text-sm text-zinc-600">
          {query ? 'No rows match your search.' : emptyText}
        </div>
      ) : (
        <div role="list" aria-label={typeof title === 'string' ? title : undefined} className="divide-y divide-[rgb(var(--border-subtle))]/50">
          {visible.map((r) => <Row key={r.id} row={r} />)}
        </div>
      )}
    </section>
  );
}
