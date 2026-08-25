/**
 * Central plan-entitlement service — ONE snapshot the dashboard
 * (`GET /api/entitlements`) and the runner (MCP tool `entitlements_status`)
 * both consult for Solo/Team/Scale feature gating + repo/quota limits,
 * instead of each side re-deriving its own copy of the plan table or the
 * dimension caps (the "scattered Stripe-flag checks" this replaces).
 *
 * Composes the two existing gate primitives rather than duplicating them:
 *   - core/billing.ts       → subscription-active verdict + the PlanLimits table
 *   - core/entitlements.ts  → repos/seats/offHoursMinutes/generationCredits
 *                              dimension verdicts (with live usage)
 *
 * `buildEntitlementSnapshot` is pure (usage supplied by the caller) so it's
 * fully unit-testable without Mongo; `loadEntitlementSnapshot` is the I/O
 * wrapper used by the route/tool handlers.
 */
import { isConnected, TenantModel, type TenantPlan, type SubscriptionStatus } from '../shared/db.js';
import { isEntitled, entitlementReason, planLimits, type PlanLimits } from './billing.js';
import {
  type EntitlementDimension,
  type EntitlementVerdict,
  verdictFor,
  currentRepoCount,
  currentSeatCount,
  currentOffHoursMinutes,
  currentGenerationCredits,
} from './entitlements.js';

/** Every dimension the snapshot reports — kept in one place so a new
 *  dimension added to entitlements.ts only needs to be added here too. */
export const ENTITLEMENT_DIMENSIONS: readonly EntitlementDimension[] = [
  'repos', 'seats', 'offHoursMinutes', 'generationCredits',
];

export interface EntitlementSnapshot {
  tenantId: string;
  plan: TenantPlan;
  subscriptionStatus: SubscriptionStatus;
  /** True for the local single-operator default tenant — never gated. */
  local: boolean;
  /** May this tenant use paid/autonomous features at all (billing.isEntitled)? */
  entitled: boolean;
  reason: string | null;
  /** The full per-plan limits table (brain atoms, seats, requests, etc). */
  limits: PlanLimits;
  /** Per-dimension cap + current usage + upgrade CTA. */
  dimensions: Record<EntitlementDimension, EntitlementVerdict>;
}

export interface EntitlementSnapshotInput {
  tenantId: string;
  plan: TenantPlan;
  subscriptionStatus?: SubscriptionStatus;
  local?: boolean;
}

/**
 * Pure snapshot builder — no I/O. `usage` is the current count per dimension
 * (defaults to 0, i.e. "not yet used" — callers gating a specific action
 * should pass the post-action count, same convention as `checkEntitlement`).
 */
export function buildEntitlementSnapshot(
  input: EntitlementSnapshotInput,
  usage: Partial<Record<EntitlementDimension, number>> = {},
): EntitlementSnapshot {
  const plan = input.plan;
  const state = { plan, subscriptionStatus: input.subscriptionStatus, local: input.local };
  const dimensions = {} as Record<EntitlementDimension, EntitlementVerdict>;
  for (const dim of ENTITLEMENT_DIMENSIONS) {
    dimensions[dim] = verdictFor(dim, plan, usage[dim] ?? 0);
  }
  return {
    tenantId: input.tenantId,
    plan,
    subscriptionStatus: input.subscriptionStatus ?? 'none',
    local: Boolean(input.local),
    entitled: isEntitled(state),
    reason: entitlementReason(state),
    limits: planLimits(plan),
    dimensions,
  };
}

/**
 * I/O wrapper — resolves plan/subscriptionStatus from the tenant row when not
 * already known, reads live usage for every dimension, and builds the
 * snapshot. The local/loopback tenant skips DB lookups entirely (never
 * gated — same posture as `billing.isEntitled` / `entitlements.requireEntitlement`).
 */
export async function loadEntitlementSnapshot(
  tenantId: string,
  opts: { plan?: TenantPlan; subscriptionStatus?: SubscriptionStatus; local?: boolean; now?: Date } = {},
): Promise<EntitlementSnapshot> {
  let plan = opts.plan;
  let subscriptionStatus = opts.subscriptionStatus;
  if ((!plan || !subscriptionStatus) && !opts.local && isConnected() && TenantModel) {
    const row = await TenantModel.findOne({ tenantId }).lean<{ plan?: TenantPlan; subscriptionStatus?: SubscriptionStatus } | null>();
    plan = plan ?? row?.plan ?? 'free';
    subscriptionStatus = subscriptionStatus ?? row?.subscriptionStatus;
  }
  plan = plan ?? 'free';

  const usage: Partial<Record<EntitlementDimension, number>> = opts.local
    ? {}
    : {
      repos: await currentRepoCount(tenantId),
      seats: await currentSeatCount(tenantId),
      offHoursMinutes: await currentOffHoursMinutes(tenantId, opts.now),
      generationCredits: await currentGenerationCredits(tenantId, opts.now),
    };

  return buildEntitlementSnapshot({ tenantId, plan, subscriptionStatus, local: opts.local }, usage);
}
