'use client';

// THE shared DataTable — generalized from /schedule's pending-queue.
// Server components build the cells (badges and all) and pass them in with a
// pre-computed search string + sort values; filtering and sorting happen
// client-side with zero extra fetches.

import { useMemo, useState } from 'react';
import { SearchInput } from '@/components/search-input';

export interface DataColumn {
  label: string;
  sortKey?: string;          // present → column header is click-to-sort
  align?: 'left' | 'right' | 'center';
  className?: string;
  // Mobile card role (below md). Defaults are inferred when omitted:
  // index 0 → 'badge', index 1 → 'title', the rest → 'detail'.
  //  badge  — shown inline at the top of the card (no label)
  //  title  — the card's primary line (no label, emphasised)
  //  meta   — always-visible labelled line
  //  detail — hidden until the card is tapped open
  mobile?: 'badge' | 'title' | 'meta' | 'detail';
}

// Exported for unit tests — the mobile card layout hinges on this inference.
export function mobileRole(col: DataColumn | undefined, i: number): 'badge' | 'title' | 'meta' | 'detail' {
  if (col?.mobile) return col.mobile;
  if (i === 0) return 'badge';
  if (i === 1) return 'title';
  return 'detail';
}

export interface DataRow {
  id: string;
  search: string;            // lowercase haystack for the search box
  sort?: Record<string, number | string>;
  cells: React.ReactNode[];
}

export function DataTable({
  title,
  meta,
  columns,
  rows,
  defaultSort,
  defaultDesc = false,
  searchPlaceholder = 'Search…',
  emptyText = 'Nothing here.',
  searchable = true,
}: {
  title: React.ReactNode;
  meta?: React.ReactNode;
  columns: DataColumn[];
  rows: DataRow[];
  defaultSort?: string;
  defaultDesc?: boolean;
  searchPlaceholder?: string;
  emptyText?: React.ReactNode;
  searchable?: boolean;
}) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | undefined>(defaultSort);
  const [desc, setDesc] = useState(defaultDesc);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? rows.filter((r) => r.search.includes(q)) : [...rows];
    if (sortKey) {
      filtered.sort((a, b) => {
        const av = a.sort?.[sortKey] ?? '';
        const bv = b.sort?.[sortKey] ?? '';
        const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv));
        return desc ? -cmp : cmp;
      });
    }
    return filtered;
  }, [rows, query, sortKey, desc]);

  const onSort = (key?: string) => {
    if (!key) return;
    if (sortKey === key) setDesc(!desc);
    else { setSortKey(key); setDesc(false); }
  };

  return (
    <section className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800/80 flex flex-wrap items-center gap-3">
        <h2 className="text-sm font-semibold text-zinc-200">{title}</h2>
        {searchable && (
          <div className="flex-1 min-w-[200px] max-w-md">
            <SearchInput value={query} onChange={setQuery} placeholder={searchPlaceholder} />
          </div>
        )}
        <span className="ml-auto text-xs text-zinc-500">
          {meta ?? `${visible.length}${query ? ` of ${rows.length}` : ''} rows`}
        </span>
      </div>
      {visible.length === 0 ? (
        <div className="p-8 text-center text-sm text-zinc-600">
          {query ? 'No rows match your search.' : emptyText}
        </div>
      ) : (
        <>
        {/* Mobile (below md): one tappable card per row, key fields up top,
            secondary fields revealed on tap. Zero horizontal scroll. */}
        <div className="md:hidden divide-y divide-zinc-800/50">
          {visible.map((r) => {
            const badges = r.cells.map((c, i) => ({ c, role: mobileRole(columns[i], i), col: columns[i] })).filter((x) => x.role === 'badge');
            const title = r.cells.map((c, i) => ({ c, role: mobileRole(columns[i], i) })).find((x) => x.role === 'title');
            const metas = r.cells.map((c, i) => ({ c, role: mobileRole(columns[i], i), col: columns[i] })).filter((x) => x.role === 'meta');
            const details = r.cells.map((c, i) => ({ c, role: mobileRole(columns[i], i), col: columns[i] })).filter((x) => x.role === 'detail');
            return (
              <details key={r.id} className="group px-4 py-3">
                <summary className="tap-press flex items-start gap-2 cursor-pointer list-none min-h-[44px] [&::-webkit-details-marker]:hidden">
                  <div className="flex flex-wrap items-center gap-1.5 shrink-0">{badges.map((b, i) => <span key={i}>{b.c}</span>)}</div>
                  <div className="min-w-0 flex-1 text-sm text-zinc-100">
                    {title?.c}
                    {metas.length > 0 && (
                      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                        {metas.map((m, i) => <span key={i} className="inline-flex items-center gap-1">{m.c}</span>)}
                      </div>
                    )}
                  </div>
                  {details.length > 0 && (
                    <span className="shrink-0 text-zinc-600 text-xs mt-0.5 transition-transform group-open:rotate-90">▸</span>
                  )}
                </summary>
                {details.length > 0 && (
                  <div className="mt-2.5 pl-1 space-y-1.5 border-t border-zinc-800/60 pt-2.5">
                    {details.map((d, i) => (
                      <div key={i} className="flex items-baseline justify-between gap-3 text-xs">
                        <span className="text-[10px] uppercase tracking-wider text-zinc-600 shrink-0">{d.col?.label}</span>
                        <span className="text-right text-zinc-300 min-w-0">{d.c}</span>
                      </div>
                    ))}
                  </div>
                )}
              </details>
            );
          })}
        </div>
        {/* Desktop (md+): the full table. */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                {columns.map((c) => (
                  <th
                    key={c.label}
                    onClick={() => onSort(c.sortKey)}
                    onKeyDown={c.sortKey ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSort(c.sortKey); }
                    } : undefined}
                    tabIndex={c.sortKey ? 0 : undefined}
                    role={c.sortKey ? 'button' : undefined}
                    aria-sort={c.sortKey && sortKey === c.sortKey ? (desc ? 'descending' : 'ascending') : undefined}
                    className={`px-4 py-2.5 font-medium select-none ${c.sortKey ? 'cursor-pointer hover:text-zinc-300 focus:outline-none focus:text-teal-300' : ''} ${
                      c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''
                    } ${c.className ?? ''}`}
                  >
                    {c.label}
                    {c.sortKey && sortKey === c.sortKey && <span className="ml-1 text-teal-400">{desc ? '↓' : '↑'}</span>}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {visible.map((r) => (
                <tr key={r.id} className="hover:bg-zinc-800/30 transition-colors">
                  {r.cells.map((cell, i) => (
                    <td
                      key={i}
                      className={`px-4 py-2.5 ${columns[i]?.align === 'right' ? 'text-right' : columns[i]?.align === 'center' ? 'text-center' : ''}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
    </section>
  );
}
