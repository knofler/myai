// Subscription entitlement — the single source of truth for "may this tenant
// use paid/autonomous features?" (ADR-010 M5 / §7.2 Day 7).
//
// Pure, no I/O — fed a tenant's plan + subscription state and returns a verdict.
// The gateway derives `{ plan, subscriptionStatus, local }` from the per-tenant
// API key (core/auth.ts) and the stored tenant row, never from a tool arg. The
// dashboard mirrors `isSubscriptionActive` in `dashboard/src/lib/billing.ts`
// (same pattern as tenant-keys.ts) so checkout/webhook/gate agree 1:1.
//
// Stripe is the writer of `subscriptionStatus`/`plan` via the dashboard webhook;
// this module only reads them.

import type { TenantPlan, SubscriptionStatus } from '../shared/db.js';

/** Plans that unlock the off-hours autonomous runner + scheduling (paid tiers). */
export const PAID_PLANS: readonly TenantPlan[] = ['solo', 'team', 'scale'];

/** Stripe statuses we treat as a live, paid-up subscription. `past_due` is a
 *  dunning grace state — NOT entitling here (kept strict for the MVP gate). */
export const ACTIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing'];

export interface BillingState {
  plan: TenantPlan;
  subscriptionStatus?: SubscriptionStatus;
  /** True for the local single-operator default tenant (loopback / bridge token). */
  local?: boolean;
}

/** Is the tenant's Stripe subscription currently live (active or trialing)? */
export function isSubscriptionActive(state: Pick<BillingState, 'subscriptionStatus'>): boolean {
  return ACTIVE_SUBSCRIPTION_STATUSES.includes(state.subscriptionStatus ?? 'none');
}

/** Is the plan a paid tier (anything above `free`)? */
export function isPaidPlan(plan: TenantPlan): boolean {
  return PAID_PLANS.includes(plan);
}

/**
 * The gate: may this tenant use paid/autonomous features (off-hours runner,
 * scheduling, queueing work)?
 *
 * - The **local single-operator default tenant** (`local: true`) always passes —
 *   the existing operator deployment is never billing-gated.
 * - A **real tenant** must be on a paid plan AND have an active subscription.
 *   Free tier (and lapsed/canceled subscriptions) → blocked from paid features.
 */
export function isEntitled(state: BillingState): boolean {
  if (state.local) return true;
  return isPaidPlan(state.plan) && isSubscriptionActive(state);
}

/** Human-readable reason a tenant is gated, for 402 responses / UI copy. */
export function entitlementReason(state: BillingState): string | null {
  if (isEntitled(state)) return null;
  if (!isPaidPlan(state.plan)) return 'free plan — subscribe to Solo to enable autonomous work';
  return `subscription ${state.subscriptionStatus ?? 'none'} — renew your Solo subscription to continue`;
}

// ── Per-plan entitlement limits (self-serve tier gating) ───────
// The single source of truth for what each tier unlocks. Mirrored verbatim in
// dashboard/src/lib/billing.ts (same discipline as isSubscriptionActive) so the
// gateway gate, the dashboard UI, and the checkout/webhook agree 1:1 on limits.
//
// A limit of -1 means "unlimited". `brainMaxAtoms` bounds the git-versioned
// brain store; `teamSeats` bounds User rows per tenant; `hostedBrain` unlocks
// the managed cross-machine brain remote (Pro/Team).

export interface PlanLimits {
  /** Max brain atoms the tenant may store (-1 = unlimited). */
  brainMaxAtoms: number;
  /** Max member seats (User rows) on the tenant (-1 = unlimited). */
  teamSeats: number;
  /** Managed hosted-brain remote (cross-machine sync) available? */
  hostedBrain: boolean;
  /** Per-tenant burst ceiling: max gateway requests per minute (-1 = unlimited).
   *  Sliding-window abuse/DoS guard at the MCP/REST edge (core/tenant-quota.ts). */
  requestsPerMin: number;
  /** Per-tenant monthly request quota (-1 = unlimited). Counted in Mongo and
   *  reset on the calendar-month (UTC) boundary. */
  monthlyRequests: number;
  /** Dollar allowance of LLM/generation spend included in the plan's flat
   *  price before the tenant-facing spend alert (llm/spend-alert.ts) fires at
   *  80%/100% (-1 = unlimited, never alerts). This is the CUSTOMER-FACING
   *  heads-up threshold — distinct from `budgets.monthlyHardCapUsd` (an
   *  internal, deployment-wide execution cap that throttles/stops calls) and
   *  from the cost-anomaly detector (fraud/runaway spend). */
  includedSpendUsd: number;
}

export const PLAN_LIMITS: Readonly<Record<TenantPlan, PlanLimits>> = {
  free: { brainMaxAtoms: 500, teamSeats: 1, hostedBrain: false, requestsPerMin: 60, monthlyRequests: 10_000, includedSpendUsd: 5 },
  solo: { brainMaxAtoms: 5_000, teamSeats: 1, hostedBrain: true, requestsPerMin: 300, monthlyRequests: 200_000, includedSpendUsd: 50 },
  team: { brainMaxAtoms: 50_000, teamSeats: 10, hostedBrain: true, requestsPerMin: 1_000, monthlyRequests: 2_000_000, includedSpendUsd: 250 },
  scale: { brainMaxAtoms: -1, teamSeats: -1, hostedBrain: true, requestsPerMin: -1, monthlyRequests: -1, includedSpendUsd: -1 },
} as const;

/** Parses an optional numeric env override; `undefined` when unset/blank/NaN
 *  (so a bad value falls through to the next layer instead of zeroing a limit). */
function numEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Layers env overrides over the hardcoded per-tier baseline for the two
 * gateway rate-limit fields (enforced in core/tenant-quota.ts, mounted on both
 * the REST and MCP surfaces — ADR-010 §3.5). Resolution order, highest wins:
 *
 *   1. per-tier override   — `TENANT_RATE_LIMIT_RPM_<TIER>` / `TENANT_MONTHLY_REQUEST_LIMIT_<TIER>`
 *   2. config default      — `TENANT_RATE_LIMIT_RPM` / `TENANT_MONTHLY_REQUEST_LIMIT`
 *   3. hardcoded PLAN_LIMITS baseline
 *
 * Lets ops retune a tenant's ceiling (or the fleet-wide default) via env,
 * without a redeploy — e.g. loosening `free` during a launch promo, or
 * tightening every tier during an incident. `-1` (unlimited) is a valid
 * override value. Only these two fields are env-tunable — the entitlement
 * fields (`brainMaxAtoms`, `teamSeats`, `hostedBrain`, `includedSpendUsd`) stay
 * the hardcoded values mirrored verbatim in dashboard/src/lib/billing.ts.
 */
function rateLimitOverrides(plan: TenantPlan, base: PlanLimits): Pick<PlanLimits, 'requestsPerMin' | 'monthlyRequests'> {
  const tier = plan.toUpperCase();
  return {
    requestsPerMin:
      numEnv(`TENANT_RATE_LIMIT_RPM_${tier}`) ?? numEnv('TENANT_RATE_LIMIT_RPM') ?? base.requestsPerMin,
    monthlyRequests:
      numEnv(`TENANT_MONTHLY_REQUEST_LIMIT_${tier}`) ?? numEnv('TENANT_MONTHLY_REQUEST_LIMIT') ?? base.monthlyRequests,
  };
}

/** Limits for a plan (falls back to the free tier for an unknown value),
 *  with env overrides applied to the rate-limit fields (see {@link rateLimitOverrides}). */
export function planLimits(plan: TenantPlan): PlanLimits {
  const base = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  return { ...base, ...rateLimitOverrides(plan, base) };
}

/** Would `count` brain atoms stay within the plan's cap? (-1 cap = always). */
export function withinBrainLimit(plan: TenantPlan, count: number): boolean {
  const max = planLimits(plan).brainMaxAtoms;
  return max < 0 || count <= max;
}

/** May the tenant add one more member seat given `currentSeats` in use? */
export function canAddSeat(plan: TenantPlan, currentSeats: number): boolean {
  const max = planLimits(plan).teamSeats;
  return max < 0 || currentSeats < max;
}

/** Is the managed hosted-brain remote available on this plan? */
export function hasHostedBrain(plan: TenantPlan): boolean {
  return planLimits(plan).hostedBrain;
}

// ── Stripe price ↔ plan mapping (pure; the map is injected) ────
// The dashboard owns the actual env-sourced price ids; this pure helper lets the
// webhook resolve a Stripe subscription's price id back to a plan without I/O,
// keeping the mapping unit-testable.

/** Resolve a Stripe price id to a plan via an injected price→plan map.
 *  Unknown/absent price ids fall back to `fallback` (default 'solo'). */
export function planForPriceId(
  priceId: string | undefined,
  priceToPlans: Readonly<Record<string, TenantPlan>>,
  fallback: TenantPlan = 'solo',
): TenantPlan {
  if (priceId && priceToPlans[priceId]) return priceToPlans[priceId];
  return fallback;
}

/** Normalize an arbitrary string to a known paid plan, or null if not one. */
export function asPaidPlan(value: string | undefined): TenantPlan | null {
  return value && (PAID_PLANS as readonly string[]).includes(value)
    ? (value as TenantPlan)
    : null;
}

// ── Plan rank (mirrors dashboard/src/lib/billing.ts's PLAN_RANK/planRank) ──
// Lets callers (gift-code grants, proration) tell an upgrade from a downgrade
// without hardcoding tier order themselves. Free ranks 0.
const PLAN_RANK: Record<TenantPlan, number> = { free: 0, solo: 1, team: 2, scale: 3 };

/** Numeric rank of a plan (higher = more expensive tier). */
export function planRank(plan: TenantPlan): number {
  return PLAN_RANK[plan] ?? 0;
}

/** Is moving from → to an upgrade (to a higher-ranked tier)? */
export function isUpgrade(from: TenantPlan, to: TenantPlan): boolean {
  return planRank(to) > planRank(from);
}
