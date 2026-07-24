/**
 * Plan-tier entitlement enforcement — hard caps on repos, seats, off-hours
 * runner minutes, and app-generation credits, gated by the tenant's active
 * subscription plan (follow-on to core/billing.ts, which defines the gate
 * PRIMITIVES — `isEntitled`/`canAddSeat`/`withinBrainLimit` — but never wires
 * them into an enforcement path). This module is that enforcement path: it
 * reads current tenant usage and returns a STRUCTURED over-limit verdict the
 * dashboard renders as an upgrade prompt, rather than a bare 4xx.
 *
 * Distinct from `core/tenant-quota.ts` (which throttles REQUEST VOLUME —
 * burst rate + monthly request count, an abuse/DoS guard applied to every
 * request) — this gates BUSINESS ACTIONS (add a repo, invite a seat, run
 * off-hours, generate an app) against the limits a tier actually SELLS.
 *
 * Local single-operator tenant (`ctx.local`) is never gated — same posture as
 * `billing.isEntitled` and `tenant-quota.tenantQuota`.
 */
import type { Request, Response, NextFunction } from 'express';
import { TaskModel, UserModel, isConnected, type TenantPlan } from '../shared/db.js';
import { withTenant } from '../shared/scoped-query.js';
import { summarizeUsage } from '../shared/usage-store.js';
import { planLimits } from './billing.js';
import { AuthError } from './tenant-context.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'entitlements' });

export type EntitlementDimension = 'repos' | 'seats' | 'offHoursMinutes' | 'generationCredits';

/** Per-plan caps for the dimensions NOT already owned by billing.ts's
 *  `PlanLimits` (which already defines `teamSeats` — reused via `limitFor`
 *  below rather than duplicated). A limit of -1 means unlimited. */
export interface EntitlementLimits {
  maxRepos: number;
  offHoursMinutesPerMonth: number;
  generationCreditsPerMonth: number;
}

export const ENTITLEMENT_LIMITS: Readonly<Record<TenantPlan, EntitlementLimits>> = {
  free: { maxRepos: 1, offHoursMinutesPerMonth: 0, generationCreditsPerMonth: 3 },
  solo: { maxRepos: 5, offHoursMinutesPerMonth: 6_000, generationCreditsPerMonth: 30 },
  team: { maxRepos: 25, offHoursMinutesPerMonth: 20_000, generationCreditsPerMonth: 200 },
  scale: { maxRepos: -1, offHoursMinutesPerMonth: -1, generationCreditsPerMonth: -1 },
} as const;

/** Fixed tier order — cheapest-that-would-help is always the NEXT tier up. */
const PLAN_ORDER: readonly TenantPlan[] = ['free', 'solo', 'team', 'scale'];

/** The tier above `plan`, or null when already at the top (scale). */
export function nextPlan(plan: TenantPlan): TenantPlan | null {
  const i = PLAN_ORDER.indexOf(plan);
  return i >= 0 && i < PLAN_ORDER.length - 1 ? PLAN_ORDER[i + 1] : null;
}

/** The numeric cap for one dimension on a plan (-1 = unlimited). Seats defer
 *  to billing.ts's `PlanLimits.teamSeats` — the existing single source of
 *  truth for seat caps — so this module never disagrees with it. */
export function limitFor(dimension: EntitlementDimension, plan: TenantPlan): number {
  if (dimension === 'seats') return planLimits(plan).teamSeats;
  const limits = ENTITLEMENT_LIMITS[plan] ?? ENTITLEMENT_LIMITS.free;
  if (dimension === 'repos') return limits.maxRepos;
  if (dimension === 'offHoursMinutes') return limits.offHoursMinutesPerMonth;
  return limits.generationCreditsPerMonth;
}

const DIMENSION_LABEL: Record<EntitlementDimension, string> = {
  repos: 'connected repos',
  seats: 'team seats',
  offHoursMinutes: 'off-hours runner minutes (this month)',
  generationCredits: 'app-generation credits (this month)',
};

export interface EntitlementVerdict {
  allowed: boolean;
  dimension: EntitlementDimension;
  plan: TenantPlan;
  limit: number; // -1 = unlimited
  used: number;
  upgradeTo: TenantPlan | null;
  message: string;
}

/**
 * Pure verdict — no I/O, fully unit-testable. `used` is the count the action
 * would produce (pass the post-action count, e.g. `currentSeats + 1` for an
 * "may I add one more seat?" check).
 */
export function verdictFor(dimension: EntitlementDimension, plan: TenantPlan, used: number): EntitlementVerdict {
  const limit = limitFor(dimension, plan);
  const allowed = limit < 0 || used <= limit;
  const upgradeTo = allowed ? null : nextPlan(plan);
  const label = DIMENSION_LABEL[dimension];
  const message = allowed
    ? `within plan limit (${used}/${limit < 0 ? 'unlimited' : limit} ${label})`
    : upgradeTo
      ? `plan '${plan}' allows ${limit} ${label} (at ${used}) — upgrade to ${upgradeTo} for more`
      : `plan '${plan}' allows ${limit} ${label} (at ${used})`;
  return { allowed, dimension, plan, limit, used, upgradeTo, message };
}

// ── Usage getters (I/O) — tenant-scoped ─────────────────────────

/** Distinct repos the tenant has ever queued a task against — the "connected
 *  repos" the repo cap bounds. */
export async function tenantRepos(tenantId: string): Promise<string[]> {
  if (!isConnected() || !TaskModel) return [];
  return TaskModel.distinct('repo', withTenant(tenantId, {}));
}

export async function currentRepoCount(tenantId: string): Promise<number> {
  return (await tenantRepos(tenantId)).length;
}

/** Member (User row) count for the tenant — what `teamSeats` bounds. */
export async function currentSeatCount(tenantId: string): Promise<number> {
  if (!isConnected() || !UserModel) return 0;
  return UserModel.countDocuments(withTenant(tenantId, {}));
}

function startOfMonthUTC(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Off-hours runner minutes consumed since the start of the current UTC
 *  calendar month (the product meter, ADR-014 `UsageEvent` type
 *  `offhours.minutes`). */
export async function currentOffHoursMinutes(tenantId: string, now: Date = new Date()): Promise<number> {
  const summary = await summarizeUsage(tenantId, { from: startOfMonthUTC(now), groupBy: 'type' });
  return summary.totals['offhours.minutes'] ?? 0;
}

/** App-generation credits consumed this calendar month (`UsageEvent` type
 *  `app.generated` — the new_app/blueprint pipeline). */
export async function currentGenerationCredits(tenantId: string, now: Date = new Date()): Promise<number> {
  const summary = await summarizeUsage(tenantId, { from: startOfMonthUTC(now), groupBy: 'type' });
  return summary.totals['app.generated'] ?? 0;
}

async function currentUsage(dimension: EntitlementDimension, tenantId: string, now?: Date): Promise<number> {
  switch (dimension) {
    case 'repos': return currentRepoCount(tenantId);
    case 'seats': return currentSeatCount(tenantId);
    case 'offHoursMinutes': return currentOffHoursMinutes(tenantId, now);
    case 'generationCredits': return currentGenerationCredits(tenantId, now);
  }
}

/**
 * The gate: may this tenant perform one more action on `dimension`? Reads
 * CURRENT usage and folds in `opts.extra` (default 0 — the action the caller
 * is about to commit, e.g. `extra: 1` for "one more seat/repo about to be
 * added") before comparing to the plan cap.
 */
export async function checkEntitlement(
  dimension: EntitlementDimension,
  tenantId: string,
  plan: TenantPlan,
  opts: { extra?: number; now?: Date } = {},
): Promise<EntitlementVerdict> {
  const used = (await currentUsage(dimension, tenantId, opts.now)) + (opts.extra ?? 0);
  return verdictFor(dimension, plan, used);
}

// ── Error + Express middleware ──────────────────────────────────

/** Thrown by call sites that prefer throw/catch (mirrors AuthError's
 *  status/code contract) over the Express middleware below. Carries the full
 *  structured verdict so the catching route can surface it verbatim. */
export class EntitlementError extends AuthError {
  readonly verdict: EntitlementVerdict;
  constructor(verdict: EntitlementVerdict) {
    super(verdict.message, 402, 'PLAN_LIMIT_EXCEEDED');
    this.name = 'EntitlementError';
    this.verdict = verdict;
  }
}

/**
 * Express middleware factory — gate a mutating route on a plan dimension.
 * Mount AFTER `authenticate()` (needs `req.tenant`). The local single-operator
 * tenant is never gated. Disable fleet-wide with ENTITLEMENTS_DISABLED=1 (same
 * kill-switch posture as TENANT_QUOTA_DISABLED).
 */
export function requireEntitlement(dimension: EntitlementDimension, opts: { extra?: number } = {}) {
  const disabled = process.env.ENTITLEMENTS_DISABLED === '1';
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = req.tenant;
    if (disabled || !ctx || ctx.local) {
      next();
      return;
    }
    const verdict = await checkEntitlement(dimension, ctx.tenantId, ctx.plan ?? 'free', opts);
    if (!verdict.allowed) {
      log.warn({ tenantId: ctx.tenantId, ...verdict }, 'entitlement limit exceeded');
      res.status(402).json({ error: verdict.message, code: 'PLAN_LIMIT_EXCEEDED', ...verdict });
      return;
    }
    next();
  };
}
