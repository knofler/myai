// Execution-lane filter chips (server component) — the lane dimension for
// /work's Needs Review tab (task-47098709). Mirrors repo-chips.tsx: the active
// lane lives in ?lane=, sits alongside ?tab= and ?repo=, and is deep-linkable.
// Counts are per-lane totals among review-status tasks the runner stamped a
// lane on (LaneBadge, task-b1776200) — pending/working tasks carry no lane yet.

import Link from 'next/link';

export interface LaneChip {
  lane: 'claude' | 'agentic-fallback';
  count: number;
}

const LANE_LABEL: Record<string, string> = { claude: 'Claude', 'agentic-fallback': 'Fallback' };

/** Build a /work href preserving tab + repo (and any extra filter params,
 *  e.g. ?priority=/?agent=) and setting (or clearing) the lane. */
export function laneChipHref(base: string, tab: string | undefined, repo: string | undefined, lane?: string, extra?: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  if (tab && tab !== 'queue') params.set('tab', tab);
  if (repo) params.set('repo', repo);
  if (lane) params.set('lane', lane);
  for (const [k, v] of Object.entries(extra ?? {})) if (v) params.set(k, v);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function LaneChips({
  lanes,
  active,
  tab,
  repo,
  base = '/work',
  extra,
}: {
  lanes: LaneChip[];
  active?: string;
  tab?: string;
  repo?: string;
  base?: string;
  extra?: Record<string, string | undefined>;
}) {
  if (lanes.length === 0) return null;
  const total = lanes.reduce((sum, l) => sum + l.count, 0);
  const allActive = !active;

  return (
    <div className="mt-2 flex items-center gap-1.5 overflow-x-auto md:flex-wrap md:overflow-visible" role="group" aria-label="Filter by execution lane">
      <span className="mr-1 shrink-0 text-label text-[rgb(var(--text-muted))]">Lane</span>
      <Link
        href={laneChipHref(base, tab, repo, undefined, extra)}
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
      {lanes.map((l) => {
        const isActive = l.lane === active;
        return (
          <Link
            key={l.lane}
            href={laneChipHref(base, tab, repo, l.lane, extra)}
            aria-current={isActive ? 'true' : undefined}
            className={`tap-press inline-flex shrink-0 items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-[color,border-color,transform] ${
              isActive
                ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 font-medium'
                : 'bg-[rgb(var(--bg-surface))]/60 border-[rgb(var(--border-subtle))] text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))] hover:border-zinc-700 active:border-teal-500/40'
            }`}
          >
            {LANE_LABEL[l.lane] ?? l.lane}
            <span className={`text-label px-1.5 py-0.5 rounded-full ${isActive ? 'bg-teal-500/20 text-teal-200' : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]'}`}>
              {l.count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
