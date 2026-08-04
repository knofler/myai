// Reader for the subscription-pool capacity artifact.
//
// scripts/pool_capacity_snapshot.sh (host-side) bridges config/runner_budget.conf
// + the runner's pacing ledger (~/.ai-cli-runner, not mounted) into
// state/pool-capacity.json inside the repo — same pattern as lib/runner-health.ts.
// The dashboard reads it off the AI_ROOT mount for the /schedule capacity panel:
// the claude-tech weekly token pool, plus the metered API-credit RESERVE pool
// (task-874364a3 — the operator's personal Claude-API credit, drawn only when
// every free pool is session-capped; hard lifetime USD cap).

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';

/**
 * Per-provider outcome-quality rollup (task-80ba3a74) — the same rolling
 * pass-rate agentic_quality_pass_rate/agentic_quality_rollup in
 * scripts/lib/agentic_fallback.sh compute for logs/claude_log.md session-close
 * lines, now embedded in the agentic-fallback pool entry so the dashboard can
 * render it alongside the $ spend instead of an operator having to grep log text.
 */
export interface PoolCapacityQuality {
  provider: string;
  /** null when the provider has recorded outcomes but pass-rate is undefined (never happens today, kept for parity with the shell helper's empty-string case). */
  passRate: number | null;
  /** Outcomes counted in this rate (<= window). */
  n: number;
  /** Rolling window size (AGENTIC_QUALITY_WINDOW). */
  window: number;
  /** Oldest → newest 1/0 (pass/fail) for the outcomes counted, for a sparkline. */
  recent: number[];
}

export interface PoolCapacityPool {
  pool: string;
  /** "usd-reserve" marks the metered API-credit pool, "usd-daily" the agentic-fallback lane; absent = weekly token pool. */
  kind?: string;
  /** "lifetime" | "daily" | "weekly" — which reset cadence a USD-denominated pool declares. */
  period?: string;
  enabled?: boolean;
  weeklyBudgetTokens?: number;
  weeklySpentTokens?: number;
  weeklyRemainingTokens?: number;
  pctUsedWeekly?: number;
  hardCapUsd?: number;
  /** Cap for period-based USD pools (e.g. agentic-fallback's daily cap) — parallel to hardCapUsd on the lifetime reserve. */
  capUsd?: number;
  spentUsd?: number;
  remainingUsd?: number;
  pctUsedUsd?: number;
  /** agentic-fallback only: per-provider (deepseek/kimi) pass-rate rollup. */
  qualityByProvider?: PoolCapacityQuality[];
}

export interface PoolCapacity {
  available: boolean;
  generatedAt: string | null;
  week: string | null;
  pools: PoolCapacityPool[];
}

const EMPTY: PoolCapacity = { available: false, generatedAt: null, week: null, pools: [] };

export async function readPoolCapacity(): Promise<PoolCapacity> {
  try {
    const raw = await fs.readFile(path.join(AI_ROOT, 'state', 'pool-capacity.json'), 'utf8');
    const parsed = JSON.parse(raw) as { generatedAt?: string; week?: string; pools?: PoolCapacityPool[] };
    if (!Array.isArray(parsed.pools)) return EMPTY;
    return {
      available: true,
      generatedAt: typeof parsed.generatedAt === 'string' ? parsed.generatedAt : null,
      week: typeof parsed.week === 'string' ? parsed.week : null,
      pools: parsed.pools.filter((p) => p && typeof p.pool === 'string'),
    };
  } catch {
    return EMPTY; // artifact absent/unreadable → panel simply doesn't render
  }
}
