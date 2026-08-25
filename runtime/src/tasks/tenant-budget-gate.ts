/**
 * Runner budget-aware execution gate (task-7fed6488).
 *
 * Closes the loop between metering and execution: before the runner claims a
 * task for a tenant, this gate checks the tenant's remaining budget and — if
 * exhausted — the claim is DEFERRED (the task stays `pending`, untouched) until
 * the next window, not failed. `claimTaskImpl` (task-store.ts) calls
 * `getTenantBudgetGateStatus` and simply returns `null` (nothing claimable)
 * when it reports `blocked: true`; the task is retried automatically on the
 * runner's next poll and succeeds on its own once the window rolls over —
 * there's no retry-count bump, no dead-lettering, no lease churn.
 *
 * Distinct from two adjacent mechanisms that sound similar:
 *   - `llm/budget-guard.ts` — cost-aware ROUTING. Runs per LLM call, mid-task,
 *     and downgrades/blocks the *model choice* (e.g. opus → sonnet) once a
 *     tenant's $ spend crosses a threshold. This gate runs once, before a task
 *     is even claimed, and blocks *starting the task at all*.
 *   - `tasks/member-budget-guard.ts` — per-MEMBER budget scoping (allocation).
 *     Excludes one over-budget member's tasks from the claimable set while the
 *     tenant keeps working. This gate operates one level up: the whole TENANT's
 *     budget, independent of which member requested any given task.
 *
 * Two independent axes, both read from the existing metering stores:
 *   - $ spend (BudgetUsageModel, same source as budget-guard.ts) against the
 *     tenant's effective monthly/daily $ caps — only checked when
 *     `config.budgets.enabled`, mirroring budget-guard.ts's own off switch.
 *   - off-hours runner minutes (UsageEventModel 'offhours.minutes', the ADR-014
 *     product meter) against a tenant-wide `BudgetCapOverride.offHoursMinutesCapPerMonth`
 *     — only checked when that field is actually set on the tenant's override
 *     document (the common case, no document at all, is always uncapped here).
 *
 * Same fail-open posture as every other budget guard in this codebase: a Mongo
 * hiccup or disconnected DB means "not blocked" — this paces autonomous spend,
 * it is not a hard security boundary, and availability wins.
 */
import type { Connection } from 'mongoose';
import {
  BudgetCapOverrideModel,
  BudgetUsageModel,
  UsageEventModel,
  TenantBudgetGateAlertStateModel,
  isConnected,
} from '../shared/db.js';
import type { IBudgetCapOverride } from '../shared/db.js';
import { getConfig } from '../shared/config.js';
import { tenantScope, resolveScopedModel } from '../shared/scoped-query.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'tenant-budget-gate' });

export type TenantBudgetBlockReason = 'monthly_hard' | 'daily_hard' | 'offhours_minutes';

export interface TenantBudgetCaps {
  monthlyHardCapUsd?: number;
  dailyCapUsd?: number;
  offHoursMinutesCapPerMonth?: number;
}

export interface TenantBudgetUsage {
  mtdSpendUsd: number;
  todaySpendUsd: number;
  offHoursMinutesThisMonth: number;
}

export interface TenantBudgetGateStatus extends TenantBudgetUsage {
  caps: TenantBudgetCaps;
  blocked: boolean;
  reason?: TenantBudgetBlockReason;
  /** UTC instant the window this block applies to rolls over — the next time
   *  a claim attempt can succeed without operator intervention. */
  windowResetAt?: Date;
}

function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfNextMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

function startOfDayUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function startOfNextDayUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

/** 'YYYY-MM-DD' UTC, for the daily-cap dedup window key. Pure. */
function dayKey(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/** 'YYYY-MM' UTC, for the monthly/off-hours dedup window key. Pure. */
function monthKey(now: Date): string {
  return now.toISOString().slice(0, 7);
}

/**
 * Pure verdict — exported for tests. Order mirrors budget-guard.ts /
 * member-budget-guard.ts: monthly $ → daily $ → off-hours minutes, first trip
 * wins. `now` is injectable for deterministic window-reset assertions.
 */
export function tenantBudgetGateVerdict(
  caps: TenantBudgetCaps,
  usage: TenantBudgetUsage,
  now: Date = new Date(),
): { blocked: boolean; reason?: TenantBudgetBlockReason; windowResetAt?: Date } {
  if (typeof caps.monthlyHardCapUsd === 'number' && usage.mtdSpendUsd >= caps.monthlyHardCapUsd) {
    return { blocked: true, reason: 'monthly_hard', windowResetAt: startOfNextMonthUTC(now) };
  }
  if (typeof caps.dailyCapUsd === 'number' && usage.todaySpendUsd >= caps.dailyCapUsd) {
    return { blocked: true, reason: 'daily_hard', windowResetAt: startOfNextDayUTC(now) };
  }
  if (
    typeof caps.offHoursMinutesCapPerMonth === 'number' &&
    usage.offHoursMinutesThisMonth >= caps.offHoursMinutesCapPerMonth
  ) {
    return { blocked: true, reason: 'offhours_minutes', windowResetAt: startOfNextMonthUTC(now) };
  }
  return { blocked: false };
}

async function sumSpend(tenantId: string, since: Date, connection?: Connection): Promise<number> {
  if (!isConnected() || !BudgetUsageModel) return 0;
  try {
    const rows = await resolveScopedModel(BudgetUsageModel, connection).aggregate<{ _id: null; total: number }>([
      { $match: { ...tenantScope(tenantId), createdAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]);
    return rows[0]?.total ?? 0;
  } catch (err) {
    log.warn({ err, tenantId }, 'tenant-budget-gate: spend aggregation failed — assuming 0 spend');
    return 0;
  }
}

async function sumOffHoursMinutes(tenantId: string, since: Date, connection?: Connection): Promise<number> {
  if (!isConnected() || !UsageEventModel) return 0;
  try {
    const rows = await resolveScopedModel(UsageEventModel, connection).aggregate<{ _id: null; total: number }>([
      { $match: { ...tenantScope(tenantId), type: 'offhours.minutes', occurredAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]);
    return rows[0]?.total ?? 0;
  } catch (err) {
    log.warn({ err, tenantId }, 'tenant-budget-gate: off-hours aggregation failed — assuming 0 minutes');
    return 0;
  }
}

async function getOverride(tenantId: string, connection?: Connection): Promise<IBudgetCapOverride | null> {
  if (!isConnected() || !BudgetCapOverrideModel) return null;
  try {
    return await resolveScopedModel(BudgetCapOverrideModel, connection)
      .findOne(tenantScope(tenantId))
      .lean<IBudgetCapOverride | null>();
  } catch (err) {
    log.warn({ err, tenantId }, 'tenant-budget-gate: override lookup failed — assuming no caps');
    return null;
  }
}

/**
 * The claim-time gate. Called from `tasks/task-store.ts` `claimTaskImpl` for
 * every non-explicit claim attempt (same `--task-id` bypass exemption as the
 * member-budget guard and the backoff/off-hours pacing guards it sits next
 * to). Never throws.
 */
export async function getTenantBudgetGateStatus(
  tenantId: string,
  connection?: Connection,
  now: Date = new Date(),
): Promise<TenantBudgetGateStatus> {
  const budgets = getConfig().budgets;
  const override = await getOverride(tenantId, connection);

  const caps: TenantBudgetCaps = {};
  if (budgets?.enabled) {
    caps.monthlyHardCapUsd = typeof override?.monthlyHardCapUsd === 'number' ? override.monthlyHardCapUsd : budgets.monthlyHardCapUsd;
    caps.dailyCapUsd = typeof override?.dailyCapUsd === 'number' ? override.dailyCapUsd : budgets.monthlyDailyCapUsd;
  }
  if (typeof override?.offHoursMinutesCapPerMonth === 'number') {
    caps.offHoursMinutesCapPerMonth = override.offHoursMinutesCapPerMonth;
  }

  // Nothing to check for this tenant — skip the usage aggregations entirely.
  if (
    typeof caps.monthlyHardCapUsd !== 'number' &&
    typeof caps.dailyCapUsd !== 'number' &&
    typeof caps.offHoursMinutesCapPerMonth !== 'number'
  ) {
    return { caps, mtdSpendUsd: 0, todaySpendUsd: 0, offHoursMinutesThisMonth: 0, blocked: false };
  }

  const monthStart = startOfMonthUTC(now);
  const dayStart = startOfDayUTC(now);
  const [mtdSpendUsd, todaySpendUsd, offHoursMinutesThisMonth] = await Promise.all([
    typeof caps.monthlyHardCapUsd === 'number' ? sumSpend(tenantId, monthStart, connection) : Promise.resolve(0),
    typeof caps.dailyCapUsd === 'number' ? sumSpend(tenantId, dayStart, connection) : Promise.resolve(0),
    typeof caps.offHoursMinutesCapPerMonth === 'number' ? sumOffHoursMinutes(tenantId, monthStart, connection) : Promise.resolve(0),
  ]);

  const usage = { mtdSpendUsd, todaySpendUsd, offHoursMinutesThisMonth };
  return { caps, ...usage, ...tenantBudgetGateVerdict(caps, usage, now) };
}

const REASON_LABEL: Record<TenantBudgetBlockReason, string> = {
  monthly_hard: 'monthly $ budget',
  daily_hard: 'daily $ budget',
  offhours_minutes: 'off-hours runner minutes budget',
};

/**
 * Emit the tenant-facing 'runner.budget_exhausted' notification the first
 * time a given (tenant, window, reason) trips — dedup'd via
 * `TenantBudgetGateAlertStateModel` so a tenant parked over budget for hours
 * doesn't get re-alerted on every ~10-minute claim-poll cycle. Never throws.
 */
export async function notifyTenantBudgetExhausted(
  tenantId: string,
  status: TenantBudgetGateStatus,
  connection?: Connection,
): Promise<void> {
  if (!status.blocked || !status.reason) return;
  try {
    const now = new Date();
    const windowKey = status.reason === 'daily_hard' ? `daily:${dayKey(now)}` : `monthly:${monthKey(now)}`;

    if (isConnected() && TenantBudgetGateAlertStateModel) {
      try {
        await resolveScopedModel(TenantBudgetGateAlertStateModel, connection).create({
          ...tenantScope(tenantId),
          windowKey,
          reason: status.reason,
        });
      } catch (err) {
        // Duplicate key = already alerted this window — silent no-op, not an error.
        if (err && typeof err === 'object' && (err as { code?: number }).code === 11000) return;
        log.warn({ err, tenantId }, 'tenant-budget-gate: alert dedup write failed — emitting anyway');
      }
    }

    emitNotifyEvent({
      type: 'runner.budget_exhausted',
      tenantId,
      title: `Runner paused — ${REASON_LABEL[status.reason]} exhausted`,
      message: `Task claiming is deferred for this tenant until the ${status.reason === 'daily_hard' ? 'next day' : 'next month'} ` +
        `(resets ${status.windowResetAt?.toISOString() ?? 'next window'}). Pending tasks are untouched and will resume automatically.`,
      level: 'warning',
      source: 'tenant-budget-gate',
      data: {
        reason: status.reason,
        mtdSpendUsd: status.mtdSpendUsd,
        todaySpendUsd: status.todaySpendUsd,
        offHoursMinutesThisMonth: status.offHoursMinutesThisMonth,
        caps: status.caps,
        windowResetAt: status.windowResetAt?.toISOString(),
      },
    });
  } catch (err) {
    log.warn({ err, tenantId }, 'tenant-budget-gate: notify failed (suppressed)');
  }
}
