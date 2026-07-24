// Pure, DB-free shaping helpers for the public /proof marketing page
// (GRAND_PRODUCT_ROADMAP §7.4 — "GTM proof asset"). The page itself
// (app/proof/page.tsx) does the Mongo/gateway reads and hands raw counts
// here; keeping the shaping logic DB-free makes it unit-testable, same split
// as lib/nav-groups.ts / lib/theme.ts. Every number here is a cross-tenant
// aggregate (no tenantId filter) — the whole point of "anonymized" is that
// nothing is attributable to a single tenant.

export interface DayBucket {
  _id: string;
  count: number;
}

export interface ProofRawCounts {
  tasksShippedAllTime: number;
  tasksShippedOvernight: number; // completed in the last 24h
  scheduleRunsTotal: number;
  scheduleRunsErrors: number;
  reposTotal: number;
  reposActive7d: number;
}

export interface ProofStats {
  appsGenerated: number;
  activeRepos: number;
  tasksShippedAllTime: string;
  tasksShippedAllTimeRaw: number;
  tasksShippedOvernight: number;
  runnerSuccessRate: number; // 0-100
}

/** Runner success rate — errors as a share of total schedule runs, clamped. Defaults to 100 with no runs yet (nothing has failed). */
export function computeRunnerSuccessRate(total: number, errors: number): number {
  if (total <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round(((total - errors) / total) * 100)));
}

/** Compact k/M formatting for a public headline number. */
export function formatProofCount(n: number): string {
  const v = Math.max(0, n);
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(Math.round(v));
}

export function overnightWindowStart(now: Date): Date {
  return new Date(now.getTime() - 24 * 60 * 60 * 1000);
}

export function sevenDayWindowStart(now: Date): Date {
  return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
}

/** UTC yyyy-mm-dd labels for the last n days, oldest first (today last). */
export function lastNDateLabels(n: number, now: Date): string[] {
  const out: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/** Fills a dense per-day series from sparse Mongo group buckets, zero-filling gaps. */
export function buildDailySeries(dates: string[], buckets: DayBucket[]): { date: string; count: number }[] {
  const byDate = new Map(buckets.map((b) => [b._id, b.count]));
  return dates.map((d) => ({ date: d, count: byDate.get(d) ?? 0 }));
}

export function buildProofStats(raw: ProofRawCounts): ProofStats {
  return {
    appsGenerated: Math.max(0, Math.round(raw.reposTotal)),
    activeRepos: Math.max(0, Math.min(raw.reposTotal, Math.round(raw.reposActive7d))),
    tasksShippedAllTime: formatProofCount(raw.tasksShippedAllTime),
    tasksShippedAllTimeRaw: Math.max(0, Math.round(raw.tasksShippedAllTime)),
    tasksShippedOvernight: Math.max(0, Math.round(raw.tasksShippedOvernight)),
    runnerSuccessRate: computeRunnerSuccessRate(raw.scheduleRunsTotal, raw.scheduleRunsErrors),
  };
}

// ── Continuity savings — the public "the number" proof artifact ─────────────
// GO_LIVE_PLAN.md §5 proof-artifact list, item 2: "myAI saved me N million
// re-teaching tokens". Cross-tenant aggregate (no tenantId — same anonymized
// contract as the rest of this page) of the SAME today-vs-brain comparison
// scripts/brain_token_eval.py runs locally: legacy = the measured file-read
// boot cost (baselineTokens), brain = what the gateway actually served
// (tokens), for every context_boot/brain_delta serve that carried a baseline.
// Distinct from the tenant-scoped, behind-login /analytics continuity meter —
// this is the outward-facing, aggregate GTM number.

export interface ContinuitySavingsRaw {
  /** Sum of measured legacy file-read boot costs across measured boots. */
  legacyTokens: number;
  /** Sum of actual brain-served tokens over the SAME measured boots. */
  brainTokens: number;
  /** Count of boots carrying a measured legacy baseline. */
  measuredBoots: number;
}

export interface ContinuitySavings {
  measuredBoots: number;
  legacyAvgTokens: number;
  brainAvgTokens: number;
  /** 0-100, rounded to a whole percent for headline copy. */
  reductionPct: number;
  /** e.g. "53.5x" — one decimal, matching brain_token_eval.py's own formatting. */
  ratioLabel: string;
}

/**
 * Documented fallback — scripts/brain_token_eval.py's own benchmark
 * comparison (STATE.md+handoff vs the compiled brief) on this repo, used
 * until enough real boots have accumulated a measured baseline. Same role as
 * FALLBACK_STATS above: render something honest and citable, never a zero.
 */
export const FALLBACK_CONTINUITY_SAVINGS: ContinuitySavings = {
  measuredBoots: 0,
  legacyAvgTokens: 8610,
  brainAvgTokens: 161,
  reductionPct: 98,
  ratioLabel: '53.5x',
};

/**
 * Shape raw cross-tenant sums into the public ratio/percent. Falls back to
 * the documented benchmark when there isn't yet a real measured baseline
 * (no boots, non-positive legacy average, or a non-positive brain average —
 * the ratio is undefined without a positive denominator).
 */
export function computeContinuitySavings(raw: ContinuitySavingsRaw): ContinuitySavings {
  const measuredBoots = Number.isFinite(raw.measuredBoots) ? Math.max(0, Math.round(raw.measuredBoots)) : 0;
  const legacyTokens = Number.isFinite(raw.legacyTokens) ? Math.max(0, raw.legacyTokens) : 0;
  const brainTokens = Number.isFinite(raw.brainTokens) ? Math.max(0, raw.brainTokens) : 0;

  if (measuredBoots <= 0 || legacyTokens <= 0) return { ...FALLBACK_CONTINUITY_SAVINGS };

  const legacyAvg = legacyTokens / measuredBoots;
  const brainAvg = brainTokens / measuredBoots;
  if (!(legacyAvg > 0) || !(brainAvg > 0)) return { ...FALLBACK_CONTINUITY_SAVINGS };

  const reductionPct = Math.max(0, Math.min(100, Math.round(100 * (1 - brainAvg / legacyAvg))));
  const ratioLabel = `${(legacyAvg / brainAvg).toFixed(1)}x`;

  return {
    measuredBoots,
    legacyAvgTokens: Math.round(legacyAvg),
    brainAvgTokens: Math.round(brainAvg),
    reductionPct,
    ratioLabel,
  };
}
