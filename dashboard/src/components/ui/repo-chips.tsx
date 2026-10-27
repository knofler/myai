// Repo filter chips (server component) — the repo dimension for /work.
// ADR-015 slice 1: a scoped repo axis over the existing task queue. The active
// repo lives in ?repo=, sits alongside ?tab=, and is deep-linkable. Counts are
// per-repo pending ("queue") totals sourced from the Task collection — no new
// collection. Clicking a chip narrows every tab to that repo; "All" clears it.

import Link from 'next/link';

export interface RepoChip {
  repo: string;
  count: number; // pending ("queue") task count for this repo
}

/** Build a /work href preserving the current tab (and any extra filter params,
 *  e.g. ?priority=/?agent= from a saved view) and setting (or clearing) the repo. */
export function chipHref(base: string, tab: string | undefined, repo?: string, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  if (tab && tab !== 'queue') params.set('tab', tab);
  if (repo) params.set('repo', repo);
  for (const [k, v] of Object.entries(extra ?? {})) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function RepoChips({
  repos,
  active,
  tab,
  base = '/work',
  extra,
}: {
  repos: RepoChip[];
  active?: string;
  tab?: string;
  base?: string;
  extra?: Record<string, string | undefined>;
}) {
  if (repos.length === 0) return null;
  const total = repos.reduce((sum, r) => sum + r.count, 0);
  const allActive = !active;

  return (
    // Phone: one scrollable row (no wrapping into a wall of chips); desktop wraps as before.
    <div className="mt-4 flex items-center gap-1.5 overflow-x-auto md:flex-wrap md:overflow-visible" role="group" aria-label="Filter by repo">
      <span className="mr-1 shrink-0 text-label text-[rgb(var(--text-muted))]">Repo</span>
      <Link
        href={chipHref(base, tab, undefined, extra)}
        aria-current={allActive ? 'true' : undefined}
        className={`tap-press inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-[color,border-color,transform] ${
          allActive
            ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 font-medium'
            : 'bg-[rgb(var(--bg-surface))]/60 border-[rgb(var(--border-subtle))] text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))] hover:border-zinc-700 active:border-teal-500/40'
        }`}
      >
        All
        <span className={`text-label px-1.5 py-0.5 rounded-full ${allActive ? 'bg-teal-500/20 text-teal-200' : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]'}`}>
          {total}
        </span>
      </Link>
      {repos.map((r) => {
        const isActive = r.repo === active;
        return (
          <Link
            key={r.repo}
            href={chipHref(base, tab, r.repo, extra)}
            aria-current={isActive ? 'true' : undefined}
            className={`tap-press inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-[color,border-color,transform] ${
              isActive
                ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 font-medium'
                : 'bg-[rgb(var(--bg-surface))]/60 border-[rgb(var(--border-subtle))] text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))] hover:border-zinc-700 active:border-teal-500/40'
            }`}
          >
            <span>{r.repo}</span>
            <span className={`text-label px-1.5 py-0.5 rounded-full ${isActive ? 'bg-teal-500/20 text-teal-200' : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]'}`}>
              {r.count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
