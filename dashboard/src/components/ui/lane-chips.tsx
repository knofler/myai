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

/** Build a /work href preserving tab + repo and setting (or clearing) the lane. */
export function laneChipHref(base: string, tab: string | undefined, repo: string | undefined, lane?: string): string {
  const params = new URLSearchParams();
  if (tab && tab !== 'queue') params.set('tab', tab);
  if (repo) params.set('repo', repo);
  if (lane) params.set('lane', lane);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

export function LaneChips({
  lanes,
  active,
  tab,
  repo,
  base = '/work',
}: {
  lanes: LaneChip[];
  active?: string;
  tab?: string;
  repo?: string;
  base?: string;
}) {
  if (lanes.length === 0) return null;
  const total = lanes.reduce((sum, l) => sum + l.count, 0);
  const allActive = !active;

  return (
    <div className="flex flex-wrap items-center gap-1.5 mt-2" role="group" aria-label="Filter by execution lane">
      <span className="text-[11px] uppercase tracking-wider text-zinc-600 mr-1">Lane</span>
      <Link
        href={laneChipHref(base, tab, repo)}
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
      {lanes.map((l) => {
        const isActive = l.lane === active;
        return (
          <Link
            key={l.lane}
            href={laneChipHref(base, tab, repo, l.lane)}
            aria-current={isActive ? 'true' : undefined}
            className={`tap-press inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs border transition-[color,border-color,transform] ${
              isActive
                ? 'bg-teal-500/15 border-teal-500/40 text-teal-300 font-medium'
                : 'bg-zinc-900/60 border-zinc-800 text-zinc-400 hover:text-zinc-200 hover:border-zinc-700 active:border-teal-500/40'
            }`}
          >
            {LANE_LABEL[l.lane] ?? l.lane}
            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${isActive ? 'bg-teal-500/20 text-teal-200' : 'bg-zinc-800 text-zinc-500'}`}>
              {l.count}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
