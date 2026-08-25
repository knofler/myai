/**
 * Team-tier per-member budget scoping (GO-LIVE day-7 gap close, task-82854b12).
 *
 * Extends the per-TENANT cost-aware budget cap (llm/budget-guard.ts) down to
 * a per-MEMBER ceiling nested under the tenant: a Team owner can bound one
 * member's autonomous $ spend (monthly / daily) and off-hours runner minutes
 * without touching the tenant-wide caps. Enforced at task-claim time —
 * claimTaskImpl (tasks/task-store.ts) excludes a capped-out member's pending
 * tasks from the claimable set via `getBlockedMemberIds`. A task with no
 * `requestedByUserId` (system/CLI/scheduler-created work), or a tenant with no
 * MemberBudgetCap documents at all, is never touched by this guard.
 *
 * Same fail-open posture as budget-guard.ts: a Mongo hiccup or disconnected DB
 * means "allow" / "nobody blocked" — this is a spend guard, not a hard
 * security boundary, and availability wins over strict enforcement.
 */
import type { Connection } from 'mongoose';
import { MemberBudgetCapModel, BudgetUsageModel, UsageEventModel, isConnected } from '../shared/db.js';
import type { IMemberBudgetCap } from '../shared/db.js';
import { tenantScope, resolveScopedModel } from '../shared/scoped-query.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'member-budget-guard' });

export type MemberBudgetBlockReason = 'monthly_hard' | 'daily_hard' | 'offhours_minutes';

export type MemberBudgetCapFields = Pick<
  IMemberBudgetCap,
  'monthlyHardCapUsd' | 'dailyCapUsd' | 'offHoursMinutesCapPerMonth'
>;

export interface MemberBudgetUsage {
  mtdSpendUsd: number;
  todaySpendUsd: number;
  offHoursMinutesThisMonth: number;
}

export interface MemberBudgetStatus extends MemberBudgetUsage {
  cap: MemberBudgetCapFields | null;
  exceeded: boolean;
  reason?: MemberBudgetBlockReason;
}

function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfDayUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function pickCapFields(doc: MemberBudgetCapFields): MemberBudgetCapFields {
  const cap: MemberBudgetCapFields = {};
  if (typeof doc.monthlyHardCapUsd === 'number') cap.monthlyHardCapUsd = doc.monthlyHardCapUsd;
  if (typeof doc.dailyCapUsd === 'number') cap.dailyCapUsd = doc.dailyCapUsd;
  if (typeof doc.offHoursMinutesCapPerMonth === 'number') cap.offHoursMinutesCapPerMonth = doc.offHoursMinutesCapPerMonth;
  return cap;
}

async function sumCost(tenantId: string, userId: string, since: Date, connection?: Connection): Promise<number> {
  if (!isConnected() || !BudgetUsageModel) return 0;
  try {
    const rows = await resolveScopedModel(BudgetUsageModel, connection).aggregate<{ _id: null; total: number }>([
      { $match: { ...tenantScope(tenantId), userId, createdAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]);
    return rows[0]?.total ?? 0;
  } catch (err) {
    log.warn({ err, tenantId, userId }, 'member-budget-guard: cost aggregation failed — assuming 0 spend');
    return 0;
  }
}

async function sumOffHoursMinutes(tenantId: string, userId: string, since: Date, connection?: Connection): Promise<number> {
  if (!isConnected() || !UsageEventModel) return 0;
  try {
    const rows = await resolveScopedModel(UsageEventModel, connection).aggregate<{ _id: null; total: number }>([
      { $match: { ...tenantScope(tenantId), userId, type: 'offhours.minutes', occurredAt: { $gte: since } } },
      { $group: { _id: null, total: { $sum: '$quantity' } } },
    ]);
    return rows[0]?.total ?? 0;
  } catch (err) {
    log.warn({ err, tenantId, userId }, 'member-budget-guard: off-hours aggregation failed — assuming 0 minutes');
    return 0;
  }
}

/** Pure verdict — exported for tests. Order: monthly $ → daily $ → off-hours minutes. */
export function memberBudgetVerdict(
  cap: MemberBudgetCapFields | null,
  usage: MemberBudgetUsage,
): { exceeded: boolean; reason?: MemberBudgetBlockReason } {
  if (!cap) return { exceeded: false };
  if (typeof cap.monthlyHardCapUsd === 'number' && usage.mtdSpendUsd >= cap.monthlyHardCapUsd) {
    return { exceeded: true, reason: 'monthly_hard' };
  }
  if (typeof cap.dailyCapUsd === 'number' && usage.todaySpendUsd >= cap.dailyCapUsd) {
    return { exceeded: true, reason: 'daily_hard' };
  }
  if (
    typeof cap.offHoursMinutesCapPerMonth === 'number' &&
    usage.offHoursMinutesThisMonth >= cap.offHoursMinutesCapPerMonth
  ) {
    return { exceeded: true, reason: 'offhours_minutes' };
  }
  return { exceeded: false };
}

/** One member's cap + current-period usage + verdict. Powers the member-list surface. */
export async function getMemberBudgetStatus(
  tenantId: string,
  userId: string,
  connection?: Connection,
): Promise<MemberBudgetStatus> {
  let cap: MemberBudgetCapFields | null = null;
  if (isConnected() && MemberBudgetCapModel) {
    try {
      const doc = await resolveScopedModel(MemberBudgetCapModel, connection)
        .findOne({ ...tenantScope(tenantId), userId })
        .lean<IMemberBudgetCap | null>();
      // Project to only the cap fields — the raw doc also carries tenantId/
      // userId/updatedAt, which don't belong in the public "cap" shape this
      // status feeds into the member-list API response.
      cap = doc ? pickCapFields(doc) : null;
    } catch (err) {
      log.warn({ err, tenantId, userId }, 'member-budget-guard: cap lookup failed — assuming no cap');
    }
  }

  const monthStart = startOfMonthUTC();
  const dayStart = startOfDayUTC();
  const [mtdSpendUsd, todaySpendUsd, offHoursMinutesThisMonth] = await Promise.all([
    sumCost(tenantId, userId, monthStart, connection),
    sumCost(tenantId, userId, dayStart, connection),
    sumOffHoursMinutes(tenantId, userId, monthStart, connection),
  ]);

  const usage = { mtdSpendUsd, todaySpendUsd, offHoursMinutesThisMonth };
  return { cap, ...usage, ...memberBudgetVerdict(cap, usage) };
}

/**
 * Bulk pre-computation for many members at once — used by the member-list
 * route so it doesn't fire N sequential status lookups. Returns a map keyed
 * by userId; members without a MemberBudgetCap document (the common case) are
 * omitted so the caller can treat "absent" as "uncapped".
 */
export async function getMemberBudgetStatusMap(
  tenantId: string,
  userIds: string[],
  connection?: Connection,
): Promise<Map<string, MemberBudgetStatus>> {
  const result = new Map<string, MemberBudgetStatus>();
  if (!userIds.length || !isConnected() || !MemberBudgetCapModel) return result;

  let caps: IMemberBudgetCap[];
  try {
    caps = await resolveScopedModel(MemberBudgetCapModel, connection)
      .find({ ...tenantScope(tenantId), userId: { $in: userIds } })
      .lean<IMemberBudgetCap[]>();
  } catch (err) {
    log.warn({ err, tenantId }, 'member-budget-guard: bulk cap lookup failed — no members scoped');
    return result;
  }
  if (!caps.length) return result;

  await Promise.all(caps.map(async (cap) => {
    result.set(cap.userId, await getMemberBudgetStatus(tenantId, cap.userId, connection));
  }));
  return result;
}

/**
 * The claim-time gate: returns the userIds within `tenantId` whose per-member
 * cap has tripped (monthly $ / daily $ / off-hours minutes). Only members with
 * a MemberBudgetCap document are ever considered — a tenant with none (the
 * common case, and every tenant not on the Team tier) returns `[]` without
 * touching the spend/usage collections at all.
 */
export async function getBlockedMemberIds(tenantId: string, connection?: Connection): Promise<string[]> {
  if (!isConnected() || !MemberBudgetCapModel) return [];

  let caps: IMemberBudgetCap[];
  try {
    caps = await resolveScopedModel(MemberBudgetCapModel, connection)
      .find({ ...tenantScope(tenantId) })
      .lean<IMemberBudgetCap[]>();
  } catch (err) {
    log.warn({ err, tenantId }, 'member-budget-guard: cap list failed — no members blocked');
    return [];
  }
  if (!caps.length) return [];

  const monthStart = startOfMonthUTC();
  const dayStart = startOfDayUTC();
  const blocked: string[] = [];
  await Promise.all(caps.map(async (cap) => {
    const [mtdSpendUsd, todaySpendUsd, offHoursMinutesThisMonth] = await Promise.all([
      sumCost(tenantId, cap.userId, monthStart, connection),
      sumCost(tenantId, cap.userId, dayStart, connection),
      sumOffHoursMinutes(tenantId, cap.userId, monthStart, connection),
    ]);
    if (memberBudgetVerdict(cap, { mtdSpendUsd, todaySpendUsd, offHoursMinutesThisMonth }).exceeded) {
      blocked.push(cap.userId);
    }
  }));
  return blocked;
}
