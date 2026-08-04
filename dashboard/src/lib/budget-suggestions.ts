// Adaptive budget-cap suggestions (Phase 5b §8 follow-up) — dashboard read
// side. The runtime's read-only budget-advisor (runtime/src/llm/budget-advisor.ts)
// learns per-tenant/per-channel spend and SUGGESTS adjusted caps via
// GET /api/budgets/suggestions + the `budgets_suggestions` MCP tool, but until
// now nothing in the dashboard rendered it. Dashboard and runtime are separate
// npm packages with no shared import path (see dashboard/tsconfig.json — no
// path alias into ../runtime), so the pure decision logic is ported here
// rather than imported. Keep `recommendCapAdjustment` in sync with the
// runtime copy if the thresholds ever change.
//
// Write path: "Apply suggestion" (components/budget-suggestions-panel.tsx)
// PATCHes /api/budget-caps, which persists a per-tenant BudgetCapOverride
// (src/lib/db.ts) that views/budgets.tsx reads back in preference to the
// env var. `buildApplyPayload` below is the pure piece of that flow — it
// turns a suggestion row into the API payload without touching the network.

import { BudgetUsage } from './db';
import { tenantFilter } from './tenant';

export const DEFAULT_LOOKBACK_DAYS = 30;
export const MIN_OBSERVED_DAYS = 7;
export const SAFETY_MARGIN_MULTIPLIER = 1.25;
const INCREASE_RATIO = 1.15;
const DECREASE_RATIO = 0.7;

export type CapRecommendation = 'increase' | 'decrease' | 'keep' | 'insufficient_data';

export interface CapSuggestion {
  currentCapUsd: number;
  observedDays: number;
  avgDailyUsd: number;
  p95DailyUsd: number;
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
  perChannel: ChannelCapSuggestion[];
}

export interface CurrentCaps {
  monthlyHardCapUsd: number;
  monthlyDailyCapUsd: number;
  perChannelMonthlyCapUsd: number;
}

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
 * from the suggested/current ratio and how much history backs it. Mirrors
 * runtime/src/llm/budget-advisor.ts `recommendCapAdjustment` exactly.
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

function sum(values: number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}

interface DailyTotalRow { _id: string; total: number }
interface ChannelDailyRow { _id: { channelId: string; day: string }; total: number }

/**
 * Tenant-scoped read side of the runtime's `getBudgetCapSuggestions`.
 * Queries the dashboard's own `BudgetUsage` mirror directly — same pattern
 * views/budgets.tsx already uses for the spend-audit panels above this one —
 * rather than round-tripping through the gateway's admin-only HTTP/MCP surface.
 */
export async function getBudgetCapSuggestions(
  tenantId: string,
  caps: CurrentCaps,
  opts: { lookbackDays?: number; enabled?: boolean } = {},
): Promise<BudgetCapSuggestions> {
  const lookbackDays = opts.lookbackDays && opts.lookbackDays > 0 ? Math.floor(opts.lookbackDays) : DEFAULT_LOOKBACK_DAYS;
  const now = new Date();
  const lookbackStart = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const tf = tenantFilter(tenantId);

  const [dailyTotals, channelDailyRows] = await Promise.all([
    BudgetUsage.aggregate<DailyTotalRow>([
      { $match: { ...tf, createdAt: { $gte: lookbackStart } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, total: { $sum: '$costUsd' } } },
    ]),
    BudgetUsage.aggregate<ChannelDailyRow>([
      { $match: { ...tf, createdAt: { $gte: lookbackStart }, channelId: { $ne: null } } },
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
    currentCapUsd: caps.monthlyHardCapUsd,
    observedDays,
    avgDailyUsd,
    p95DailyUsd,
    rawSuggestedCapUsd: avgDailyUsd * 30 * SAFETY_MARGIN_MULTIPLIER,
  });

  const dailyCap = buildCapSuggestion({
    currentCapUsd: caps.monthlyDailyCapUsd,
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

  const perChannel: ChannelCapSuggestion[] = [...byChannel.entries()]
    .map(([channelId, values]): ChannelCapSuggestion => {
      const chObservedDays = values.length;
      const chAvg = chObservedDays > 0 ? sum(values) / chObservedDays : 0;
      const chP95 = percentile(values, 0.95);
      return {
        channelId,
        ...buildCapSuggestion({
          currentCapUsd: caps.perChannelMonthlyCapUsd,
          observedDays: chObservedDays,
          avgDailyUsd: chAvg,
          p95DailyUsd: chP95,
          rawSuggestedCapUsd: chAvg * 30 * SAFETY_MARGIN_MULTIPLIER,
        }),
      };
    })
    .sort((a, b) => b.avgDailyUsd - a.avgDailyUsd);

  return {
    enabled: !!opts.enabled,
    lookbackDays,
    generatedAt: now.toISOString(),
    monthlyHardCap,
    dailyCap,
    perChannel,
  };
}

/** View-model the panel renders from — the pure formatting layer the component test covers. */
export interface SuggestionSummary {
  deltaUsd: number;
  deltaPct: number;
  badgeLabel: string;
}

export function summarizeSuggestion(s: CapSuggestion): SuggestionSummary {
  const deltaUsd = round2(s.suggestedCapUsd - s.currentCapUsd);
  const deltaPct = s.currentCapUsd > 0 ? round2((deltaUsd / s.currentCapUsd) * 100) : 0;
  const badgeLabel = s.recommendation === 'insufficient_data' ? 'insufficient data' : s.recommendation;
  return { deltaUsd, deltaPct, badgeLabel };
}

/** The three cap fields a BudgetCapOverride document (src/lib/db.ts) can hold. */
export type CapOverrideField = 'monthlyHardCapUsd' | 'dailyCapUsd' | 'perChannelCapUsd';

export type ApplySource = 'adaptive-suggested' | 'manual';

export interface ApplySuggestionPayload {
  field: CapOverrideField;
  valueUsd: number;
  source: ApplySource;
}

/**
 * Only 'increase'/'decrease' represent an actual change worth a write —
 * 'keep' and 'insufficient_data' both pin suggestedCapUsd to currentCapUsd
 * (see buildCapSuggestion above), so applying either would be a no-op PATCH.
 */
export function canApplySuggestion(recommendation: CapRecommendation): boolean {
  return recommendation === 'increase' || recommendation === 'decrease';
}

/** Builds the /api/budget-caps PATCH body for a given suggestion row. */
export function buildApplyPayload(field: CapOverrideField, s: CapSuggestion): ApplySuggestionPayload {
  return { field, valueUsd: s.suggestedCapUsd, source: 'adaptive-suggested' };
}
