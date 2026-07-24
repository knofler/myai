/**
 * Usage-event store — the product meter (ADR-014, S2 slice 1).
 *
 * `BudgetUsage` meters the *resource* (tokens/$ per LLM call); this meters the
 * *product*: the billable business units the pricing page sells (a runner task
 * executed, off-hours minutes, an app generated, an agent invoked). Two-meter
 * architecture — no joins at write time; invoicing (the deferred add-on-billing
 * follow-up) reads both.
 *
 * Write path (this file) is deliberately DEFENSIVE:
 *  - fire-and-forget: a meter failure must NEVER fail the metered operation, so
 *    `recordUsage` swallows every error (logged at warn) and returns a result
 *    object rather than throwing.
 *  - idempotent: `eventId` is unique in Mongo; a re-emitted event (runner retry,
 *    lease-reclaim replay — ADR-011) is a silent no-op. Idempotency is by KEY,
 *    not by caller discipline.
 *  - tenant-scoped: mandatory leading `tenantId` param, `scoped-query.ts`
 *    helpers on read (ADR-010 §1.5).
 *  - sampling guard: `config.metering` gates all emission (`enabled`) and can
 *    load-shed via `sampleRate` (< 1) in non-billing environments.
 */
import type { PipelineStage } from 'mongoose';
import { UsageEventModel, isConnected } from './db.js';
import type { IUsageEvent, UsageEventType, UsageEventSource } from './db.js';
import { getConfig } from './config.js';
import { createChildLogger } from './logger.js';
import { scopedAggregate, tenantScope } from './scoped-query.js';

const log = createChildLogger({ module: 'usage-store' });

/** Ingest can't trust runner-supplied `occurredAt` blindly — clamp to ±24h of now. */
const OCCURRED_AT_SKEW_MS = 24 * 60 * 60 * 1000;

/** The event a chokepoint emits. `tenantId` is passed separately (scoped param). */
export interface UsageEventInput {
  eventId: string;
  type: UsageEventType;
  quantity?: number;                    // default 1
  unit?: 'count' | 'minutes';           // default 'count'
  repo?: string;
  taskId?: string;
  userId?: string;
  source: UsageEventSource;
  occurredAt?: Date;                    // default now; ±24h clamped
  metadata?: Record<string, unknown>;
}

export type RecordUsageResult =
  | { recorded: true }
  | { recorded: false; reason: 'disabled' | 'sampled-out' | 'duplicate' | 'not-connected' | 'error' };

/**
 * Deterministic `eventId` for events where re-emission is expected (double
 * transition, runner retry). The unique index makes the second insert a no-op.
 * Keep the shape stable — it is the idempotency contract, not just a label.
 */
export function usageEventId(type: UsageEventType, taskId: string): string {
  if (type === 'task.executed') return `usage-task-${taskId}-executed`;
  if (type === 'offhours.minutes') return `usage-task-${taskId}-minutes`;
  return `usage-${type}-${taskId}`;
}

/** Mongo duplicate-key error (unique `eventId` → idempotent no-op). */
function isDuplicateKeyError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: number }).code === 11000;
}

/** Clamp a possibly-skewed client `occurredAt` into ±24h of ingest time. */
function clampOccurredAt(occurredAt: Date | undefined, now: Date): Date {
  if (!occurredAt) return now;
  const t = occurredAt.getTime();
  if (!Number.isFinite(t)) return now;
  const lo = now.getTime() - OCCURRED_AT_SKEW_MS;
  const hi = now.getTime() + OCCURRED_AT_SKEW_MS;
  if (t < lo) return new Date(lo);
  if (t > hi) return new Date(hi);
  return occurredAt;
}

/**
 * Record one product-usage event. Fire-and-forget: NEVER throws — callers wrap
 * their chokepoint in this and carry on regardless of the outcome. Returns a
 * small result object for tests/telemetry.
 */
export async function recordUsage(tenantId: string, evt: UsageEventInput): Promise<RecordUsageResult> {
  const metering = getConfig().metering;

  // Sampling guard #1 — master switch.
  if (!metering?.enabled) return { recorded: false, reason: 'disabled' };

  // Sampling guard #2 — probabilistic load-shed (billable meters default to 1).
  const rate = metering.sampleRate ?? 1;
  if (rate < 1 && Math.random() >= rate) return { recorded: false, reason: 'sampled-out' };

  if (!isConnected() || !UsageEventModel) {
    log.warn({ type: evt.type }, 'usage-store: MongoDB not connected — usage event dropped');
    return { recorded: false, reason: 'not-connected' };
  }

  const now = new Date();
  try {
    await UsageEventModel.create({
      ...tenantScope(tenantId),
      eventId: evt.eventId,
      type: evt.type,
      quantity: evt.quantity ?? 1,
      unit: evt.unit ?? 'count',
      repo: evt.repo,
      taskId: evt.taskId,
      userId: evt.userId,
      source: evt.source,
      occurredAt: clampOccurredAt(evt.occurredAt, now),
      metadata: evt.metadata,
    });
    return { recorded: true };
  } catch (err) {
    // Idempotency: a duplicate eventId (retry / lease-reclaim replay) is a
    // deliberate no-op, NOT an error — do not log it as a failure.
    if (isDuplicateKeyError(err)) return { recorded: false, reason: 'duplicate' };
    // Any other failure is suppressed — a meter write must never fail the op.
    log.warn({ err, type: evt.type }, 'usage-store: recordUsage failed (suppressed)');
    return { recorded: false, reason: 'error' };
  }
}

export interface SummarizeOptions {
  from?: Date;
  to?: Date;
  groupBy?: 'type' | 'day' | 'repo';
}

export interface UsageSummary {
  totals: Partial<Record<string, number>>;    // summed quantity per group key
  from?: string;
  to?: string;
  groupBy: 'type' | 'day' | 'repo';
}

/**
 * Aggregate usage for a tenant over an `occurredAt`-bounded window. This is the
 * exact-count read the invoicing follow-up codes against ("units per type for
 * tenant T in Stripe billing period [start, to)"). Read surface (MCP tool /
 * dashboard panel) is slice 2 — this store method is defined now so both the
 * meter and its export contract land together.
 */
export async function summarizeUsage(tenantId: string, opts: SummarizeOptions = {}): Promise<UsageSummary> {
  const groupBy = opts.groupBy ?? 'type';
  const empty: UsageSummary = { totals: {}, groupBy, from: opts.from?.toISOString(), to: opts.to?.toISOString() };

  if (!isConnected() || !UsageEventModel) return empty;

  // occurredAt window (half-open [from, to) mirrors billing-period semantics).
  const occurredAt: Record<string, Date> = {};
  if (opts.from) occurredAt.$gte = opts.from;
  if (opts.to) occurredAt.$lt = opts.to;
  const windowStages = Object.keys(occurredAt).length ? [{ $match: { occurredAt } }] : [];

  const groupKey =
    groupBy === 'day'
      ? { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt' } }
      : groupBy === 'repo'
        ? '$repo'
        : '$type';

  try {
    const rows = await scopedAggregate<IUsageEvent>(UsageEventModel, tenantId, [
      ...windowStages,
      { $group: { _id: groupKey, total: { $sum: '$quantity' } } },
    ]).exec() as Array<{ _id: string | null; total: number }>;

    const totals: Record<string, number> = {};
    for (const r of rows) totals[r._id ?? 'unknown'] = r.total;
    return { ...empty, totals };
  } catch (err) {
    log.warn({ err, tenantId }, 'usage-store: summarizeUsage failed');
    return empty;
  }
}

// ── getUsageBreakdown (multi-dimension rollup — slice 2) ─────────────
//
// The rollup read the dashboard `/system → Usage` tab renders and the REST
// `/api/usage/breakdown` endpoint returns. Mirrors `budget-stats.ts`'s
// `getBudgetBreakdown` shape (parallel tenant-scoped aggregations, zero-default
// on a disconnected DB) but over the PRODUCT meter: sums `quantity` (not
// `costUsd`) and slices by **tool** (`type`), **member** (`userId`), **repo**,
// and **day** buckets. Every $match is tenant-scoped via `scopedAggregate`
// (ADR-010 §1.5) — one tenant never sees another's units.

/** Raw `$group` row shape returned by the breakdown aggregations. */
interface GroupRow { _id: string | null; quantity: number; events: number }

export interface UsageBreakdownGroup {
  key: string | null;   // type / userId / repo value ('unknown' → null upstream)
  quantity: number;     // summed quantity
  events: number;       // event count (rows)
}

export interface UsageDayBucket {
  day: string;          // YYYY-MM-DD (UTC)
  quantity: number;
  events: number;
}

export interface UsageBreakdown {
  from: string;         // ISO — window start actually queried
  to?: string;          // ISO — window end (exclusive) when bounded
  byType: UsageBreakdownGroup[];   // "tool" dimension
  byUser: UsageBreakdownGroup[];   // "member" dimension
  byRepo: UsageBreakdownGroup[];
  byDay: UsageDayBucket[];         // day buckets, ascending
}

/** UTC start-of-month — the default window, matching budget-stats semantics. */
function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function emptyBreakdown(from: Date, to?: Date): UsageBreakdown {
  return { from: from.toISOString(), to: to?.toISOString(), byType: [], byUser: [], byRepo: [], byDay: [] };
}

export async function getUsageBreakdown(
  tenantId: string,
  opts: { from?: Date; to?: Date } = {},
): Promise<UsageBreakdown> {
  const from = opts.from ?? startOfMonthUTC();
  const to = opts.to;

  if (!isConnected() || !UsageEventModel) return emptyBreakdown(from, to);

  // Half-open [from, to) — mirrors billing-period semantics (see summarizeUsage).
  const occurredAt: Record<string, Date> = { $gte: from };
  if (to) occurredAt.$lt = to;
  const windowMatch: PipelineStage = { $match: { occurredAt } };

  const grouped = (keyExpr: string): PipelineStage[] => [
    windowMatch,
    { $group: { _id: keyExpr, quantity: { $sum: '$quantity' }, events: { $sum: 1 } } },
    { $sort: { quantity: -1 } },
  ];

  try {
    const [byTypeRows, byUserRows, byRepoRows, byDayRows] = await Promise.all([
      scopedAggregate<IUsageEvent>(UsageEventModel, tenantId, grouped('$type')).exec() as Promise<GroupRow[]>,
      scopedAggregate<IUsageEvent>(UsageEventModel, tenantId, grouped('$userId')).exec() as Promise<GroupRow[]>,
      scopedAggregate<IUsageEvent>(UsageEventModel, tenantId, grouped('$repo')).exec() as Promise<GroupRow[]>,
      scopedAggregate<IUsageEvent>(UsageEventModel, tenantId, [
        windowMatch,
        {
          $group: {
            _id: { $dateToString: { format: '%Y-%m-%d', date: '$occurredAt', timezone: 'UTC' } },
            quantity: { $sum: '$quantity' },
            events: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },   // day buckets ascending
      ]).exec() as Promise<GroupRow[]>,
    ]);

    const toGroups = (rows: GroupRow[]): UsageBreakdownGroup[] =>
      rows.map(r => ({ key: r._id, quantity: r.quantity, events: r.events }));

    return {
      from: from.toISOString(),
      to: to?.toISOString(),
      byType: toGroups(byTypeRows),
      byUser: toGroups(byUserRows),
      byRepo: toGroups(byRepoRows),
      byDay: byDayRows.map(r => ({ day: r._id ?? 'unknown', quantity: r.quantity, events: r.events })),
    };
  } catch (err) {
    log.warn({ err, tenantId }, 'usage-store: getUsageBreakdown failed');
    return emptyBreakdown(from, to);
  }
}
