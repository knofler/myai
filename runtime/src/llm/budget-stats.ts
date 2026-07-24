/**
 * Phase 5b — Budget aggregation read-side.
 *
 * This module is the single source of truth for budget *read* queries
 * (status snapshot, breakdown, paginated raw rows). Both MCP tools and
 * REST admin endpoints call into it — no duplication.
 *
 * Unlike `budget-guard.ts`, there is **no caching here**. The guard's
 * 30s cache is appropriate for the hot pre-call path (the only cost of
 * staleness is a tiny over/under-spend window). For dashboards and
 * chat-tool answers, the user is asking "what's the spend right now?"
 * — a 30s lag would be confusing.
 *
 * If Mongo is disconnected (or `BudgetUsageModel` hasn't been registered
 * because `connectDB()` was never called), the functions return
 * zero-spend defaults rather than throwing. Read-only endpoints should
 * be available regardless of DB state — the dashboard shows "no data"
 * instead of an error page.
 *
 * All time math is UTC, matching `budget-guard.ts`'s month/day boundaries.
 */

import { BudgetUsageModel, isConnected } from '../shared/db.js';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'budget-stats' });

// ── Public types ─────────────────────────────────────────

export interface BudgetStatus {
  /** Whether budget guards are enabled in config (BUDGETS_ENABLED). */
  enabled: boolean;
  /** Month-to-date spend in USD. Sum of `costUsd` since UTC start-of-month. */
  mtd: number;
  /** Today's spend in USD. Sum of `costUsd` since UTC start-of-day. */
  today: number;
  /** Configured global monthly hard cap. */
  monthlyHardCapUsd: number;
  /** Configured global daily hard cap. (Field name matches BudgetConfig.) */
  monthlyDailyCapUsd: number;
  /** Optional per-channel monthly cap. */
  perChannelMonthlyCapUsd?: number;
  /** Soft thresholds (fractions of monthlyHardCapUsd). */
  warnThreshold: number;
  downgradeOpusThreshold: number;
  downgradeSonnetThreshold: number;
  /** ISO timestamp of the start of the current UTC month. */
  monthStart: string;
  /** ISO timestamp of the start of the current UTC day. */
  dayStart: string;
  /** Per-channel MTD breakdown. Only populated when `perChannelMonthlyCapUsd` is set. */
  perChannel?: Array<{ channelId: string; mtd: number }>;
}

export interface BudgetBreakdown {
  /** ISO timestamp covering the start of the queried window. Defaults to UTC start-of-month. */
  monthStart: string;
  byProvider: Array<{ provider: string; cost: number; calls: number }>;
  byModel: Array<{ model: string; cost: number; calls: number }>;
  byChannel: Array<{ channelId: string | null; cost: number; calls: number }>;
  /** M2 Team tier — per-member spend inside the tenant. `userId: null` groups
   *  unattributed traffic (system/agent calls and pre-M2 rows). */
  byUser: Array<{ userId: string | null; cost: number; calls: number }>;
}

export interface BudgetUsageRow {
  callId: string;
  channelId?: string;
  channelType?: string;
  agentName?: string;
  userId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** ISO timestamp. */
  createdAt: string;
}

export interface BudgetUsageQuery {
  from?: Date;
  to?: Date;
  channelId?: string;
  provider?: string;
  /** Filter to one tenant member's calls (BudgetUsage.userId). */
  userId?: string;
  /** Page size. Default 50, capped at 500. */
  limit?: number;
  /** ISO timestamp of the last `createdAt` from the previous page. */
  cursor?: string;
}

// ── Time helpers (UTC) ───────────────────────────────────

function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfDayUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

// ── Default snapshots (used when DB unavailable) ─────────

function emptyStatus(): BudgetStatus {
  const config = getConfig();
  const budgets = config.budgets;
  const monthStart = startOfMonthUTC();
  const dayStart = startOfDayUTC();
  return {
    enabled: !!budgets?.enabled,
    mtd: 0,
    today: 0,
    monthlyHardCapUsd: budgets?.monthlyHardCapUsd ?? 0,
    monthlyDailyCapUsd: budgets?.monthlyDailyCapUsd ?? 0,
    perChannelMonthlyCapUsd: budgets?.perChannelMonthlyCapUsd,
    warnThreshold: budgets?.warnThreshold ?? 0,
    downgradeOpusThreshold: budgets?.downgradeOpusThreshold ?? 0,
    downgradeSonnetThreshold: budgets?.downgradeSonnetThreshold ?? 0,
    monthStart: monthStart.toISOString(),
    dayStart: dayStart.toISOString(),
    perChannel: typeof budgets?.perChannelMonthlyCapUsd === 'number' ? [] : undefined,
  };
}

function emptyBreakdown(from: Date): BudgetBreakdown {
  return {
    monthStart: from.toISOString(),
    byProvider: [],
    byModel: [],
    byChannel: [],
    byUser: [],
  };
}

// ── getBudgetStatus ──────────────────────────────────────

export async function getBudgetStatus(tenantId: string): Promise<BudgetStatus> {
  const base = emptyStatus();

  if (!isConnected() || !BudgetUsageModel) {
    log.debug('getBudgetStatus: MongoDB not connected — returning zero snapshot');
    return base;
  }

  // Every $match is scoped to the tenant (ADR-010 §3.5): the spend meter is
  // per-tenant. A missing tenant throws via `tenantScope` (fail-closed).
  const t = tenantScope(tenantId);
  const monthStart = new Date(base.monthStart);
  const dayStart = new Date(base.dayStart);

  try {
    const [mtdResult, todayResult] = await Promise.all([
      BudgetUsageModel.aggregate<{ _id: null; total: number }>([
        { $match: { ...t, createdAt: { $gte: monthStart } } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ]),
      BudgetUsageModel.aggregate<{ _id: null; total: number }>([
        { $match: { ...t, createdAt: { $gte: dayStart } } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ]),
    ]);

    base.mtd = mtdResult[0]?.total ?? 0;
    base.today = todayResult[0]?.total ?? 0;

    if (typeof base.perChannelMonthlyCapUsd === 'number') {
      const perChannelResult = await BudgetUsageModel.aggregate<{ _id: string | null; total: number }>([
        { $match: { ...t, createdAt: { $gte: monthStart }, channelId: { $ne: null } } },
        { $group: { _id: '$channelId', total: { $sum: '$costUsd' } } },
        { $sort: { total: -1 } },
      ]);
      base.perChannel = perChannelResult
        .filter(r => r._id !== null)
        .map(r => ({ channelId: String(r._id), mtd: r.total }));
    }

    return base;
  } catch (err) {
    log.warn({ err }, 'getBudgetStatus: aggregation failed — returning zero snapshot');
    return base;
  }
}

// ── getBudgetBreakdown ───────────────────────────────────

export async function getBudgetBreakdown(tenantId: string, opts: { from?: Date; to?: Date } = {}): Promise<BudgetBreakdown> {
  const from = opts.from ?? startOfMonthUTC();
  const to = opts.to;

  if (!isConnected() || !BudgetUsageModel) {
    log.debug('getBudgetBreakdown: MongoDB not connected — returning empty breakdown');
    return emptyBreakdown(from);
  }

  const match: Record<string, unknown> = { ...tenantScope(tenantId), createdAt: { $gte: from } };
  if (to) {
    (match.createdAt as Record<string, Date>).$lte = to;
  }

  try {
    const [byProvider, byModel, byChannel, byUser] = await Promise.all([
      BudgetUsageModel.aggregate<{ _id: string | null; cost: number; calls: number }>([
        { $match: match },
        { $group: { _id: '$provider', cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
        { $sort: { cost: -1 } },
      ]),
      BudgetUsageModel.aggregate<{ _id: string | null; cost: number; calls: number }>([
        { $match: match },
        { $group: { _id: '$model', cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
        { $sort: { cost: -1 } },
      ]),
      BudgetUsageModel.aggregate<{ _id: string | null; cost: number; calls: number }>([
        { $match: match },
        { $group: { _id: '$channelId', cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
        { $sort: { cost: -1 } },
      ]),
      BudgetUsageModel.aggregate<{ _id: string | null; cost: number; calls: number }>([
        { $match: match },
        { $group: { _id: '$userId', cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
        { $sort: { cost: -1 } },
      ]),
    ]);

    return {
      monthStart: from.toISOString(),
      byProvider: byProvider.map(r => ({ provider: r._id ?? 'unknown', cost: r.cost, calls: r.calls })),
      byModel: byModel.map(r => ({ model: r._id ?? 'unknown', cost: r.cost, calls: r.calls })),
      byChannel: byChannel.map(r => ({ channelId: r._id, cost: r.cost, calls: r.calls })),
      byUser: byUser.map(r => ({ userId: r._id, cost: r.cost, calls: r.calls })),
    };
  } catch (err) {
    log.warn({ err }, 'getBudgetBreakdown: aggregation failed — returning empty breakdown');
    return emptyBreakdown(from);
  }
}

// ── getBudgetUsage (paginated raw rows) ──────────────────

const DEFAULT_USAGE_LIMIT = 50;
const MAX_USAGE_LIMIT = 500;

export async function getBudgetUsage(
  tenantId: string,
  q: BudgetUsageQuery = {},
): Promise<{ rows: BudgetUsageRow[]; nextCursor?: string }> {
  const limitRaw = typeof q.limit === 'number' && Number.isFinite(q.limit) ? q.limit : DEFAULT_USAGE_LIMIT;
  const limit = Math.min(Math.max(1, Math.floor(limitRaw)), MAX_USAGE_LIMIT);

  if (!isConnected() || !BudgetUsageModel) {
    log.debug('getBudgetUsage: MongoDB not connected — returning empty rows');
    return { rows: [] };
  }

  const match: Record<string, unknown> = { ...tenantScope(tenantId) };
  const createdAt: Record<string, Date> = {};
  if (q.from) createdAt.$gte = q.from;
  if (q.to) createdAt.$lte = q.to;

  // Cursor pagination: rows are sorted createdAt desc, so the cursor is
  // the createdAt of the last row from the previous page. Use $lt to
  // skip past it on the next page.
  if (q.cursor) {
    const cursorDate = new Date(q.cursor);
    if (!Number.isNaN(cursorDate.getTime())) {
      createdAt.$lt = cursorDate;
    }
  }
  if (Object.keys(createdAt).length > 0) match.createdAt = createdAt;
  if (q.channelId) match.channelId = q.channelId;
  if (q.provider) match.provider = q.provider;
  if (q.userId) match.userId = q.userId;

  try {
    const docs = await BudgetUsageModel.find(match)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const rows: BudgetUsageRow[] = docs.map(d => ({
      callId: d.callId,
      channelId: d.channelId,
      channelType: d.channelType,
      agentName: d.agentName,
      userId: d.userId,
      provider: d.provider,
      model: d.model,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      costUsd: d.costUsd,
      createdAt: d.createdAt instanceof Date ? d.createdAt.toISOString() : new Date(d.createdAt).toISOString(),
    }));

    // Only emit a cursor when the page filled — otherwise we know we're at the end.
    const nextCursor = rows.length === limit ? rows[rows.length - 1]?.createdAt : undefined;

    return { rows, nextCursor };
  } catch (err) {
    log.warn({ err }, 'getBudgetUsage: query failed — returning empty rows');
    return { rows: [] };
  }
}
