// Per-repo delivery-velocity report — tasks shipped/week, cycle time, trend.
//
// Pure, no I/O (same discipline as analytics/revenue.ts). Fed rows the Task
// collection returns from `buildVelocityPipeline` (a minimal $match+$project
// aggregation, so only {repo, createdAt, completedAt} of done tasks in the
// window ever leave Mongo); all bucketing/median/trend math happens here so
// the dashboard page and any gateway/MCP surface compute identical numbers
// from identical inputs.
//
// This is the operator/tenant view of AUTONOMOUS OUTPUT — distinct from the
// revenue dashboard (money) and the launch-metrics funnel (signups): how many
// tasks each repo actually ships per week, how long a task takes from queued
// to done (createdAt → completedAt), and whether throughput is trending up
// or down.
//
// The dashboard mirrors this in dashboard/src/lib/delivery-velocity.ts (same
// pattern as revenue.ts ↔ dashboard/src/lib/revenue.ts).

/** One shipped task, projected to just what velocity math needs. */
export interface VelocityTaskRow {
  repo: string;
  /** Queued-at — Task.createdAt (mongoose timestamps). */
  createdAt: Date | string;
  /** Done-at — Task.completedAt, stamped when status flips to 'done'. */
  completedAt: Date | string;
}

export type TrendDirection = 'up' | 'down' | 'flat';

/** Throughput trend: recent half of the window vs the half before it. */
export interface VelocityTrend {
  /** Tasks shipped in the recent half-window. */
  recent: number;
  /** Tasks shipped in the prior half-window. */
  prior: number;
  /** (recent − prior) / prior; null when prior is 0 (no baseline). */
  deltaPct: number | null;
  direction: TrendDirection;
}

export interface RepoVelocity {
  repo: string;
  /** Shipped count per week, aligned index-for-index with `weekStarts`. */
  shippedByWeek: number[];
  totalShipped: number;
  /** Median queued→done cycle time (ms); null when nothing shipped. */
  medianCycleMs: number | null;
  /** 90th-percentile cycle time (ms) — the tail an operator feels. */
  p90CycleMs: number | null;
  trend: VelocityTrend;
  /** ISO timestamp of the most recent ship; null when nothing shipped. */
  lastShippedAt: string | null;
}

export interface DeliveryVelocityReport {
  /** UTC Monday week-start keys (YYYY-MM-DD), oldest → newest. */
  weekStarts: string[];
  /** Per-repo rows, sorted by totalShipped desc then repo asc. */
  repos: RepoVelocity[];
  /** Fleet-wide rollup across every repo in the window. */
  fleet: {
    totalShipped: number;
    medianCycleMs: number | null;
    p90CycleMs: number | null;
    shippedByWeek: number[];
    trend: VelocityTrend;
  };
}

/** Direction is 'flat' while |deltaPct| stays under this threshold. */
export const TREND_FLAT_THRESHOLD = 0.1;

/** Default report window, in ISO weeks (current week included). */
export const DEFAULT_VELOCITY_WEEKS = 8;

// ── Week bucketing (UTC, Monday-start) ─────────────────────────

/** Monday 00:00:00 UTC of the week containing `d`. */
export function utcWeekStart(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sunday … 6 = Saturday
  const daysSinceMonday = (day + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday));
}

/** Week bucket key — the YYYY-MM-DD of the containing week's UTC Monday. */
export function weekKey(d: Date): string {
  return utcWeekStart(d).toISOString().slice(0, 10);
}

/** Start of the report window: the UTC Monday `weeks − 1` weeks before now's. */
export function velocityWindowStart(now: Date, weeks: number = DEFAULT_VELOCITY_WEEKS): Date {
  const currentWeek = utcWeekStart(now);
  return new Date(currentWeek.getTime() - (weeks - 1) * 7 * 86_400_000);
}

// ── Statistics ─────────────────────────────────────────────────

/** Median of a list; null when empty. Even-length lists average the middle pair. */
export function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Nearest-rank percentile (p in 0..1); null when empty. */
export function percentile(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[rank];
}

/**
 * Trend from a weekly series: last ⌊n/2⌋ weeks vs the ⌊n/2⌋ weeks before them
 * (an odd window's oldest week is excluded so the halves compare like-for-like).
 * With no prior baseline, any recent shipping reads as 'up'.
 */
export function computeTrend(shippedByWeek: number[], flatThreshold: number = TREND_FLAT_THRESHOLD): VelocityTrend {
  const n = shippedByWeek.length;
  const h = Math.floor(n / 2);
  const recent = shippedByWeek.slice(n - h).reduce((a, b) => a + b, 0);
  const prior = shippedByWeek.slice(n - 2 * h, n - h).reduce((a, b) => a + b, 0);
  if (prior === 0) {
    return { recent, prior, deltaPct: null, direction: recent > 0 ? 'up' : 'flat' };
  }
  const deltaPct = (recent - prior) / prior;
  const direction: TrendDirection = deltaPct >= flatThreshold ? 'up' : deltaPct <= -flatThreshold ? 'down' : 'flat';
  return { recent, prior, deltaPct, direction };
}

// ── Aggregation pipeline (what the store runs against Task) ───

/**
 * The Mongo aggregation the report is fed from: done tasks completed since
 * `since`, projected down to the three fields the math needs. `scope` is the
 * caller's tenant filter (dashboard: tenantFilter(tenantId); gateway: the
 * scoped-query pin) spread INTO the $match so the index
 * {tenantId, status, …} still serves it.
 */
export function buildVelocityPipeline(
  since: Date,
  scope: Record<string, unknown> = {},
): Record<string, unknown>[] {
  return [
    { $match: { ...scope, status: 'done', completedAt: { $gte: since } } },
    { $project: { _id: 0, repo: 1, createdAt: 1, completedAt: 1 } },
  ];
}

// ── Report ─────────────────────────────────────────────────────

function asDate(v: Date | string): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Fold pipeline rows into the per-repo velocity report. Rows outside the
 * window, missing a repo, or carrying unparseable dates are skipped (the
 * pipeline already filters, this just makes the fold total). Cycle times are
 * clamped at 0 so a clock-skewed completedAt < createdAt can't go negative.
 */
export function computeDeliveryVelocity(
  rows: VelocityTaskRow[],
  opts: { weeks?: number; now?: Date } = {},
): DeliveryVelocityReport {
  const weeks = Math.max(1, opts.weeks ?? DEFAULT_VELOCITY_WEEKS);
  const now = opts.now ?? new Date();
  const windowStart = velocityWindowStart(now, weeks);

  const weekStarts: string[] = [];
  const weekIndex = new Map<string, number>();
  for (let i = 0; i < weeks; i++) {
    const key = new Date(windowStart.getTime() + i * 7 * 86_400_000).toISOString().slice(0, 10);
    weekIndex.set(key, i);
    weekStarts.push(key);
  }

  interface Acc { shippedByWeek: number[]; cycles: number[]; last: number }
  const byRepo = new Map<string, Acc>();
  const fleetWeeks = new Array<number>(weeks).fill(0);
  const fleetCycles: number[] = [];

  for (const row of rows) {
    if (!row.repo) continue;
    const done = asDate(row.completedAt);
    const queued = asDate(row.createdAt);
    if (!done || !queued) continue;
    const idx = weekIndex.get(weekKey(done));
    if (idx === undefined) continue; // outside the window (incl. future weeks)

    let acc = byRepo.get(row.repo);
    if (!acc) {
      acc = { shippedByWeek: new Array<number>(weeks).fill(0), cycles: [], last: 0 };
      byRepo.set(row.repo, acc);
    }
    const cycleMs = Math.max(0, done.getTime() - queued.getTime());
    acc.shippedByWeek[idx]++;
    acc.cycles.push(cycleMs);
    acc.last = Math.max(acc.last, done.getTime());
    fleetWeeks[idx]++;
    fleetCycles.push(cycleMs);
  }

  const repos: RepoVelocity[] = [...byRepo.entries()]
    .map(([repo, acc]) => ({
      repo,
      shippedByWeek: acc.shippedByWeek,
      totalShipped: acc.cycles.length,
      medianCycleMs: median(acc.cycles),
      p90CycleMs: percentile(acc.cycles, 0.9),
      trend: computeTrend(acc.shippedByWeek),
      lastShippedAt: acc.last > 0 ? new Date(acc.last).toISOString() : null,
    }))
    .sort((a, b) => b.totalShipped - a.totalShipped || a.repo.localeCompare(b.repo));

  return {
    weekStarts,
    repos,
    fleet: {
      totalShipped: fleetCycles.length,
      medianCycleMs: median(fleetCycles),
      p90CycleMs: percentile(fleetCycles, 0.9),
      shippedByWeek: fleetWeeks,
      trend: computeTrend(fleetWeeks),
    },
  };
}

/** Human cycle-time label: <90m → minutes, <48h → hours, else days. */
export function fmtCycleMs(ms: number | null): string {
  if (ms === null) return '—';
  const minutes = ms / 60_000;
  if (minutes < 90) return `${Math.round(minutes)}m`;
  const hours = minutes / 60;
  if (hours < 48) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}
