/**
 * Phase 5b §3.1 — Budget usage daily/weekly rollup.
 *
 * `BudgetUsageModel` is one immutable document per LLM call — the audit log.
 * §3.1 originally deferred pre-aggregation as "premature optimization until
 * volume forces it"; call volume has since grown enough that repeatedly
 * summing the full per-call log for analytics/dashboards is worth caching.
 *
 * This module computes a `BudgetUsageRollupModel` document for one tenant +
 * one period (a UTC day or ISO week) by aggregating `BudgetUsageModel` over
 * that period's range, then upserts it — a rollup is a DERIVED cache, always
 * reproducible from the audit log, never the source of truth. The current
 * (not-yet-closed) day/week is safe to recompute repeatedly; each run simply
 * overwrites the same `periodKey` document with fresher totals.
 *
 * If Mongo is disconnected, computation is skipped (returns `null`) rather
 * than throwing — matches the fail-open convention of `budget-stats.ts`.
 */

import { BudgetUsageModel, BudgetUsageRollupModel, isConnected } from '../shared/db.js';
import type { BudgetRollupPeriod, IBudgetRollupBucket } from '../shared/db.js';
import { tenantScope, scopedFindOneAndUpdate } from '../shared/scoped-query.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'budget-rollup' });

export interface BudgetRollupSummary {
  tenantId: string;
  period: BudgetRollupPeriod;
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: IBudgetRollupBucket[];
  byModel: IBudgetRollupBucket[];
  byChannel: IBudgetRollupBucket[];
}

// ── Period key / range helpers (UTC, pure) ───────────────

/** 'YYYY-MM-DD' in UTC. Pure. */
export function dailyPeriodKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** [start, end) of the UTC day containing `date`. Pure. */
export function dailyPeriodRange(date: Date): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** ISO-8601 week number (UTC), matching the Thursday-anchored ISO-week definition. Pure. */
function isoWeekOf(date: Date): { isoYear: number; isoWeek: number } {
  // Copy, then shift to the Thursday of this ISO week (ISO weeks are Mon-Sun,
  // and the ISO year of a week is the year containing that week's Thursday).
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Mon=1 .. Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - isoDayOfWeek);
  const isoYear = d.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
}

/** 'YYYY-Www' (ISO week, UTC), e.g. '2026-W30'. Pure. */
export function weeklyPeriodKey(date: Date): string {
  const { isoYear, isoWeek } = isoWeekOf(date);
  return `${isoYear}-W${String(isoWeek).padStart(2, '0')}`;
}

/** [start, end) of the Mon-Sun ISO week containing `date`, UTC. Pure. */
export function weeklyPeriodRange(date: Date): { start: Date; end: Date } {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const isoDayOfWeek = d.getUTCDay() === 0 ? 7 : d.getUTCDay(); // Mon=1 .. Sun=7
  const start = new Date(d.getTime() - (isoDayOfWeek - 1) * 86400000);
  const end = new Date(start.getTime() + 7 * 86400000);
  return { start, end };
}

function periodKeyAndRange(period: BudgetRollupPeriod, date: Date): { periodKey: string; start: Date; end: Date } {
  if (period === 'daily') {
    const { start, end } = dailyPeriodRange(date);
    return { periodKey: dailyPeriodKey(date), start, end };
  }
  const { start, end } = weeklyPeriodRange(date);
  return { periodKey: weeklyPeriodKey(date), start, end };
}

// ── Aggregation ──────────────────────────────────────────

interface BucketRow { _id: string | null; costUsd: number; calls: number }

function toBuckets(rows: BucketRow[]): IBudgetRollupBucket[] {
  return rows.map(r => ({ key: r._id ?? 'unattributed', costUsd: r.costUsd, calls: r.calls }));
}

/**
 * Compute and upsert the rollup for one tenant + period covering `date`.
 * Returns the computed summary, or `null` when Mongo is unavailable.
 * Safe to call repeatedly for the same (still-open) period — it recomputes
 * from `BudgetUsageModel` and overwrites the existing document each time.
 */
export async function computeBudgetRollup(
  tenantId: string,
  period: BudgetRollupPeriod,
  date: Date = new Date(),
): Promise<BudgetRollupSummary | null> {
  if (!isConnected() || !BudgetUsageModel || !BudgetUsageRollupModel) {
    log.debug({ tenantId, period }, 'computeBudgetRollup: MongoDB not connected — skipping');
    return null;
  }

  const { periodKey, start, end } = periodKeyAndRange(period, date);
  const match = { ...tenantScope(tenantId), createdAt: { $gte: start, $lt: end } };

  try {
    const [totals, byProviderRows, byModelRows, byChannelRows] = await Promise.all([
      BudgetUsageModel.aggregate<{ _id: null; costUsd: number; calls: number; inputTokens: number; outputTokens: number }>([
        { $match: match },
        { $group: {
          _id: null,
          costUsd: { $sum: '$costUsd' },
          calls: { $sum: 1 },
          inputTokens: { $sum: '$inputTokens' },
          outputTokens: { $sum: '$outputTokens' },
        } },
      ]),
      BudgetUsageModel.aggregate<BucketRow>([
        { $match: match },
        { $group: { _id: '$provider', costUsd: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
        { $sort: { costUsd: -1 } },
      ]),
      BudgetUsageModel.aggregate<BucketRow>([
        { $match: match },
        { $group: { _id: '$model', costUsd: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
        { $sort: { costUsd: -1 } },
      ]),
      BudgetUsageModel.aggregate<BucketRow>([
        { $match: match },
        { $group: { _id: '$channelId', costUsd: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
        { $sort: { costUsd: -1 } },
      ]),
    ]);

    const t = totals[0];
    const summary: BudgetRollupSummary = {
      tenantId,
      period,
      periodKey,
      periodStart: start,
      periodEnd: end,
      totalCostUsd: t?.costUsd ?? 0,
      totalCalls: t?.calls ?? 0,
      totalInputTokens: t?.inputTokens ?? 0,
      totalOutputTokens: t?.outputTokens ?? 0,
      byProvider: toBuckets(byProviderRows),
      byModel: toBuckets(byModelRows),
      byChannel: toBuckets(byChannelRows),
    };

    await scopedFindOneAndUpdate(
      BudgetUsageRollupModel,
      tenantId,
      { period, periodKey },
      {
        $set: {
          periodStart: summary.periodStart,
          periodEnd: summary.periodEnd,
          totalCostUsd: summary.totalCostUsd,
          totalCalls: summary.totalCalls,
          totalInputTokens: summary.totalInputTokens,
          totalOutputTokens: summary.totalOutputTokens,
          byProvider: summary.byProvider,
          byModel: summary.byModel,
          byChannel: summary.byChannel,
          computedAt: new Date(),
        },
      },
      { upsert: true },
    );

    return summary;
  } catch (err) {
    log.warn({ err, tenantId, period }, 'computeBudgetRollup: aggregation/upsert failed — skipping');
    return null;
  }
}

/** Convenience: compute + upsert both the daily and weekly rollup covering `date`. */
export async function computeBudgetRollups(
  tenantId: string,
  date: Date = new Date(),
): Promise<{ daily: BudgetRollupSummary | null; weekly: BudgetRollupSummary | null }> {
  const [daily, weekly] = await Promise.all([
    computeBudgetRollup(tenantId, 'daily', date),
    computeBudgetRollup(tenantId, 'weekly', date),
  ]);
  return { daily, weekly };
}

// ── Read side ────────────────────────────────────────────

export interface BudgetRollupQuery {
  from?: Date;
  to?: Date;
  /** Page size. Default 30, capped at 366. */
  limit?: number;
}

const DEFAULT_ROLLUP_LIMIT = 30;
const MAX_ROLLUP_LIMIT = 366;

/**
 * Fetch stored rollups for a tenant + period, most recent first. Never
 * throws — returns an empty array when Mongo is unavailable or the query
 * fails, matching `budget-stats.ts`'s read-side fail-open convention.
 */
export async function getBudgetRollups(
  tenantId: string,
  period: BudgetRollupPeriod,
  q: BudgetRollupQuery = {},
): Promise<BudgetRollupSummary[]> {
  if (!isConnected() || !BudgetUsageRollupModel) {
    log.debug({ tenantId, period }, 'getBudgetRollups: MongoDB not connected — returning empty');
    return [];
  }

  const limitRaw = typeof q.limit === 'number' && Number.isFinite(q.limit) ? q.limit : DEFAULT_ROLLUP_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), MAX_ROLLUP_LIMIT);

  const match: Record<string, unknown> = { ...tenantScope(tenantId), period };
  const periodStart: Record<string, Date> = {};
  if (q.from) periodStart.$gte = q.from;
  if (q.to) periodStart.$lte = q.to;
  if (Object.keys(periodStart).length > 0) match.periodStart = periodStart;

  try {
    const docs = await BudgetUsageRollupModel.find(match)
      .sort({ periodStart: -1 })
      .limit(limit)
      .lean();

    return docs.map(d => ({
      tenantId: d.tenantId,
      period: d.period,
      periodKey: d.periodKey,
      periodStart: d.periodStart,
      periodEnd: d.periodEnd,
      totalCostUsd: d.totalCostUsd,
      totalCalls: d.totalCalls,
      totalInputTokens: d.totalInputTokens,
      totalOutputTokens: d.totalOutputTokens,
      byProvider: d.byProvider,
      byModel: d.byModel,
      byChannel: d.byChannel,
    }));
  } catch (err) {
    log.warn({ err, tenantId, period }, 'getBudgetRollups: query failed — returning empty');
    return [];
  }
}
