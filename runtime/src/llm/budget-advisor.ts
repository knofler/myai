/**
 * Phase 5b §8 follow-up — adaptive budget-cap suggestions.
 *
 * Today's caps (`BudgetConfig.monthlyHardCapUsd` / `monthlyDailyCapUsd` /
 * `perChannelMonthlyCapUsd`) are static env vars (see `budget-guard.ts`).
 * This module learns from the `BudgetUsage` audit log to SUGGEST adjusted
 * caps — it never mutates config or applies anything. Caps stay env-driven
 * and restart-gated, matching the deliberate "no PUT endpoint" decision in
 * `plan/PHASE_5B_BUDGET_GUARDS.md` §3.5 (a compromised admin token must not
 * be able to loosen guards). Read-only, same posture as `budget-stats.ts`.
 *
 * Method: bucket `costUsd` into UTC daily totals over a lookback window
 * (default 30 days), globally and per-channel. From that distribution:
 *   - suggested monthly cap  = avg-daily-spend * 30 * safety margin
 *   - suggested daily cap    = p95-daily-spend * safety margin
 * The p95 (not max) absorbs one-off spikes without letting a single outlier
 * day drag the daily cap up indefinitely; the margin (25%) leaves headroom
 * so the suggestion isn't a hair-trigger re-trip of the same cap.
 *
 * Below `MIN_OBSERVED_DAYS` of history the suggestion is `insufficient_data`
 * — we deliberately do not extrapolate a cap from a handful of days, since
 * early spend is the least representative of steady-state usage.
 */

import { BudgetUsageModel, isConnected } from '../shared/db.js';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'budget-advisor' });

// ── Tunables ──────────────────────────────────────────────

/** Default lookback window when the caller doesn't specify one. */
export const DEFAULT_LOOKBACK_DAYS = 30;
/** Below this many distinct days of spend history, we don't suggest a change. */
export const MIN_OBSERVED_DAYS = 7;
/** Headroom multiplier applied to observed spend before suggesting a cap. */
export const SAFETY_MARGIN_MULTIPLIER = 1.25;
/** Suggested/current ratio at or above which we recommend raising the cap. */
const INCREASE_RATIO = 1.15;
/** Suggested/current ratio at or below which we recommend lowering the cap. */
const DECREASE_RATIO = 0.7;

// ── Public types ─────────────────────────────────────────

export type CapRecommendation = 'increase' | 'decrease' | 'keep' | 'insufficient_data';

export interface CapSuggestion {
  currentCapUsd: number;
  /** Number of distinct UTC days with at least one recorded call in the lookback window. */
  observedDays: number;
  avgDailyUsd: number;
  p95DailyUsd: number;
  /** Equal to `currentCapUsd` when `recommendation === 'insufficient_data'` (no change proposed). */
  suggestedCapUsd: number;
  recommendation: CapRecommendation;
  rationale: string;
}

export interface ChannelCapSuggestion extends CapSuggestion {
  channelId: string;
}

export interface BudgetCapSuggestions {
  enabled: boolean;
  lookbackDays: number;
  generatedAt: string;
  monthlyHardCap: CapSuggestion;
  dailyCap: CapSuggestion;
  /** Per-channel suggestions, sorted by avgDailyUsd descending. Empty when no channel-tagged spend exists. */
  perChannel: ChannelCapSuggestion[];
}

// ── Pure helpers (exported for unit tests) ───────────────

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Nearest-rank percentile over an unsorted array. Returns 0 for an empty array. */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

/**
 * Decide whether to recommend raising, lowering, or keeping a cap, purely
 * from the suggested/current ratio and how much history backs it. Exported
 * so the decision boundary can be unit-tested without mocking Mongo.
 */
export function recommendCapAdjustment(
  currentCapUsd: number,
  suggestedCapUsd: number,
  observedDays: number,
): { recommendation: CapRecommendation; rationale: string } {
  if (observedDays < MIN_OBSERVED_DAYS) {
    return {
      recommendation: 'insufficient_data',
      rationale: `Only ${observedDays} day(s) of spend history (need ${MIN_OBSERVED_DAYS}+) — keeping the current cap until more data accrues.`,
    };
  }
  if (currentCapUsd <= 0) {
    return suggestedCapUsd > 0
      ? { recommendation: 'increase', rationale: 'No cap currently configured but spend history exists — consider setting one.' }
      : { recommendation: 'keep', rationale: 'No cap configured and no observed spend.' };
  }

  const ratio = suggestedCapUsd / currentCapUsd;
  if (ratio >= INCREASE_RATIO) {
    return {
      recommendation: 'increase',
      rationale: `Observed spend pattern runs ${Math.round((ratio - 1) * 100)}% above the current cap's headroom — raise it to avoid throttling legitimate usage.`,
    };
  }
  if (ratio <= DECREASE_RATIO) {
    return {
      recommendation: 'decrease',
      rationale: `Observed spend uses only ~${Math.round(ratio * 100)}% of the current cap — it could be tightened without risking legitimate throttling.`,
    };
  }
  return {
    recommendation: 'keep',
    rationale: 'Current cap is within a reasonable margin of observed spend patterns.',
  };
}

function buildCapSuggestion(input: {
  currentCapUsd: number;
  observedDays: number;
  avgDailyUsd: number;
  p95DailyUsd: number;
  rawSuggestedCapUsd: number;
}): CapSuggestion {
  const { recommendation, rationale } = recommendCapAdjustment(input.currentCapUsd, input.rawSuggestedCapUsd, input.observedDays);
  return {
    currentCapUsd: round2(input.currentCapUsd),
    observedDays: input.observedDays,
    avgDailyUsd: round2(input.avgDailyUsd),
    p95DailyUsd: round2(input.p95DailyUsd),
    suggestedCapUsd: recommendation === 'insufficient_data' ? round2(input.currentCapUsd) : round2(input.rawSuggestedCapUsd),
    recommendation,
    rationale,
  };
}

function emptyCapSuggestion(currentCapUsd: number): CapSuggestion {
  return buildCapSuggestion({ currentCapUsd, observedDays: 0, avgDailyUsd: 0, p95DailyUsd: 0, rawSuggestedCapUsd: 0 });
}

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

// ── getBudgetCapSuggestions ──────────────────────────────

interface DailyTotalRow { _id: string; total: number; }
interface ChannelDailyRow { _id: { channelId: string; day: string }; total: number; }

export async function getBudgetCapSuggestions(
  tenantId: string,
  opts: { lookbackDays?: number } = {},
): Promise<BudgetCapSuggestions> {
  const config = getConfig();
  const budgets = config.budgets;
  const lookbackDays = opts.lookbackDays && opts.lookbackDays > 0 ? Math.floor(opts.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
  const now = new Date();
  const lookbackStart = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

  const currentMonthlyCap = budgets?.monthlyHardCapUsd ?? 0;
  const currentDailyCap = budgets?.monthlyDailyCapUsd ?? 0;

  const empty = (): BudgetCapSuggestions => ({
    enabled: !!budgets?.enabled,
    lookbackDays,
    generatedAt: now.toISOString(),
    monthlyHardCap: emptyCapSuggestion(currentMonthlyCap),
    dailyCap: emptyCapSuggestion(currentDailyCap),
    perChannel: [],
  });

  if (!isConnected() || !BudgetUsageModel) {
    log.debug('getBudgetCapSuggestions: MongoDB not connected — returning empty suggestions');
    return empty();
  }

  // Every $match is scoped to the tenant (ADR-010 §3.5) — suggestions are a
  // per-tenant learning signal, same posture as the guard's spend meters.
  const t = tenantScope(tenantId);

  try {
    const [dailyTotals, channelDailyRows] = await Promise.all([
      BudgetUsageModel.aggregate<DailyTotalRow>([
        { $match: { ...t, createdAt: { $gte: lookbackStart } } },
        { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, total: { $sum: '$costUsd' } } },
      ]),
      BudgetUsageModel.aggregate<ChannelDailyRow>([
        { $match: { ...t, createdAt: { $gte: lookbackStart }, channelId: { $ne: null } } },
        {
          $group: {
            _id: { channelId: '$channelId', day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } } },
            total: { $sum: '$costUsd' },
          },
        },
      ]),
    ]);

    const dailyValues = dailyTotals.map(d => d.total);
    const observedDays = dailyValues.length;
    const avgDailyUsd = observedDays > 0 ? sum(dailyValues) / observedDays : 0;
    const p95DailyUsd = percentile(dailyValues, 0.95);

    const monthlyHardCap = buildCapSuggestion({
      currentCapUsd: currentMonthlyCap,
      observedDays,
      avgDailyUsd,
      p95DailyUsd,
      rawSuggestedCapUsd: avgDailyUsd * 30 * SAFETY_MARGIN_MULTIPLIER,
    });

    const dailyCap = buildCapSuggestion({
      currentCapUsd: currentDailyCap,
      observedDays,
      avgDailyUsd,
      p95DailyUsd,
      rawSuggestedCapUsd: p95DailyUsd * SAFETY_MARGIN_MULTIPLIER,
    });

    const byChannel = new Map<string, number[]>();
    for (const row of channelDailyRows) {
      const channelId = row._id.channelId;
      const bucket = byChannel.get(channelId);
      if (bucket) bucket.push(row.total);
      else byChannel.set(channelId, [row.total]);
    }

    const currentChannelCap = typeof budgets?.perChannelMonthlyCapUsd === 'number' ? budgets.perChannelMonthlyCapUsd : 0;
    const perChannel: ChannelCapSuggestion[] = [...byChannel.entries()]
      .map(([channelId, values]): ChannelCapSuggestion => {
        const chObservedDays = values.length;
        const chAvg = chObservedDays > 0 ? sum(values) / chObservedDays : 0;
        const chP95 = percentile(values, 0.95);
        return {
          channelId,
          ...buildCapSuggestion({
            currentCapUsd: currentChannelCap,
            observedDays: chObservedDays,
            avgDailyUsd: chAvg,
            p95DailyUsd: chP95,
            rawSuggestedCapUsd: chAvg * 30 * SAFETY_MARGIN_MULTIPLIER,
          }),
        };
      })
      .sort((a, b) => b.avgDailyUsd - a.avgDailyUsd);

    return {
      enabled: !!budgets?.enabled,
      lookbackDays,
      generatedAt: now.toISOString(),
      monthlyHardCap,
      dailyCap,
      perChannel,
    };
  } catch (err) {
    log.warn({ err }, 'getBudgetCapSuggestions: aggregation failed — returning empty suggestions');
    return empty();
  }
}
