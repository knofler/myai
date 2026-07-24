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

/** Build a /work href preserving the current tab and setting (or clearing) the repo. */
export function chipHref(base: string, tab: string | undefined, repo?: string): string {
  const params = new URLSearchParams();
  if (tab && tab !== 'queue') params.set('tab', tab);
  if (repo) params.set('repo', repo);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function RepoChips({
  repos,
  active,
  tab,
  base = '/work',
}: {
  repos: RepoChip[];
  active?: string;
  tab?: string;
  base?: string;
}) {
  if (repos.length === 0) return null;
  const total = repos.reduce((sum, r) => sum + r.count, 0);
  const allActive = !active;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-4" role="group" aria-label="Filter by repo">
      <span className="text-[11px] uppercase tracking-wider text-zinc-600 mr-1">Repo</span>
      <Link
        href={chipHref(base, tab)}
        aria-current={allActive ? 'true' : undefined}
        className={`tap-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-[color,border-color,transform] ${
          allActive
            ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 font-medium'
            : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 active:border-teal-500/40'
        }`}
      >
        All
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${allActive ? 'bg-teal-500/20 text-teal-200' : 'bg-zinc-800 text-zinc-500'}`}>
          {total}
        </span>
      </Link>
      {repos.map((r) => {
        const isActive = r.repo === active;
        return (
          <Link
            key={r.repo}
            href={chipHref(base, tab, r.repo)}
            aria-current={isActive ? 'true' : undefined}
            className={`tap-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-[color,border-color,transform] ${
              isActive
                ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 font-medium'
                : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 active:border-teal-500/40'
            }`}
          >
            <span className="font-mono">{r.repo}</span>
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-teal-500/20 text-teal-200' : 'bg-zinc-800 text-zinc-500'}`}>
              {r.count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
