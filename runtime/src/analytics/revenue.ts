// Operator revenue analytics — MRR / ARR / NRR / logo churn / blended LTV.
//
// Pure, no I/O (same discipline as core/billing.ts). Fed snapshots of tenant
// billing state; the store (dashboard reads the Tenant collection directly, the
// gateway could expose an MCP tool) supplies them from the Stripe-synced
// subscription fields on each tenant. This is the operator/board view — it is
// intentionally CROSS-TENANT (aggregated, no tenant content), feeding the GTM
// metrics in plan/GRAND_PRODUCT_ROADMAP §5 ($10M+ ARR, <2% monthly logo churn).
//
// The dashboard mirrors this in dashboard/src/lib/revenue.ts (same pattern as
// billing.ts ↔ dashboard/src/lib/billing.ts) so the page and any gateway/MCP
// surface compute identical numbers from identical inputs.

import type { TenantPlan, SubscriptionStatus } from '../shared/db.js';
import { ACTIVE_SUBSCRIPTION_STATUSES, isPaidPlan } from '../core/billing.js';

/** Billing cadence a subscription is on (mirrors Tenant.billingInterval). */
export type BillingInterval = 'month' | 'year';

// ── Plan pricing (USD) ─────────────────────────────────────────
// Defaults from GRAND_PRODUCT_ROADMAP §5 (wedge points of the published bands:
// Solo $49–99, Team $299–599, Scale custom $2k–10k+). These are OVERRIDABLE —
// the store injects the real prices (env / Stripe) so a price change never needs
// a code change. Annual defaults to ×10 the monthly (the standard "2 months
// free" incentive); override per-plan when the real annual price differs.
export const PLAN_MONTHLY_USD: Readonly<Record<TenantPlan, number>> = {
  free: 0,
  solo: 49,
  team: 299,
  scale: 2000,
} as const;

export const PLAN_ANNUAL_USD: Readonly<Record<TenantPlan, number>> = {
  free: 0,
  solo: 490,
  team: 2990,
  scale: 20000,
} as const;

export interface PlanPricing {
  monthly: Readonly<Record<TenantPlan, number>>;
  annual: Readonly<Record<TenantPlan, number>>;
}

export const DEFAULT_PRICING: PlanPricing = {
  monthly: PLAN_MONTHLY_USD,
  annual: PLAN_ANNUAL_USD,
};

/** One tenant's billing state, projected to just what revenue math needs. */
export interface TenantBillingSnapshot {
  tenantId: string;
  plan: TenantPlan;
  subscriptionStatus?: SubscriptionStatus;
  billingInterval?: BillingInterval;
}

/**
 * Is this tenant currently generating recurring revenue? — a paid plan AND an
 * entitling Stripe status (active/trialing). `past_due` does NOT count as live
 * revenue (it is a dunning grace state, matching the billing gate).
 */
export function isRevenueActive(t: Pick<TenantBillingSnapshot, 'plan' | 'subscriptionStatus'>): boolean {
  return isPaidPlan(t.plan) && ACTIVE_SUBSCRIPTION_STATUSES.includes(t.subscriptionStatus ?? 'none');
}

/**
 * Monthly recurring revenue contribution of a single tenant (0 when not
 * revenue-active). Annual subscriptions contribute their monthly-equivalent
 * (annual price ÷ 12) so MRR is a true normalized monthly figure.
 */
export function mrrForSnapshot(t: TenantBillingSnapshot, pricing: PlanPricing = DEFAULT_PRICING): number {
  if (!isRevenueActive(t)) return 0;
  if (t.billingInterval === 'year') {
    const annual = pricing.annual[t.plan] ?? 0;
    return annual / 12;
  }
  return pricing.monthly[t.plan] ?? 0;
}

export interface PlanRevenue {
  plan: TenantPlan;
  logos: number;   // revenue-active tenants on this plan
  mrr: number;     // their combined MRR
}

export interface MrrSummary {
  mrr: number;                 // total monthly recurring revenue
  arr: number;                 // mrr × 12
  activeLogos: number;         // count of revenue-active tenants
  arpa: number;                // average revenue per account (mrr ÷ activeLogos)
  byPlan: PlanRevenue[];       // per-tier breakdown, highest-MRR first
}

/** Compute the current MRR/ARR/ARPA snapshot + per-plan breakdown. */
export function computeMrr(
  snapshots: readonly TenantBillingSnapshot[],
  pricing: PlanPricing = DEFAULT_PRICING,
): MrrSummary {
  const byPlanMap = new Map<TenantPlan, PlanRevenue>();
  let mrr = 0;
  let activeLogos = 0;

  for (const t of snapshots) {
    const m = mrrForSnapshot(t, pricing);
    if (m <= 0 || !isRevenueActive(t)) continue;
    mrr += m;
    activeLogos += 1;
    const entry = byPlanMap.get(t.plan) ?? { plan: t.plan, logos: 0, mrr: 0 };
    entry.logos += 1;
    entry.mrr += m;
    byPlanMap.set(t.plan, entry);
  }

  const byPlan = [...byPlanMap.values()].sort((a, b) => b.mrr - a.mrr);
  const arpa = activeLogos > 0 ? mrr / activeLogos : 0;
  return { mrr, arr: mrr * 12, activeLogos, arpa, byPlan };
}

// ── Retention / churn (period-over-period) ─────────────────────
// NRR and churn are cohort metrics — they compare the paying base at the START
// of a period against where those SAME accounts are NOW. The caller supplies the
// starting cohort (each account's MRR then) and a lookup of each account's MRR
// now (0 if it has since churned); the math here is exact and unit-testable.

export interface RetentionInput {
  /** Revenue-active accounts at period start, with the MRR each contributed then. */
  startingActive: ReadonlyArray<{ tenantId: string; mrr: number }>;
  /** Current MRR for an account by id (absent / 0 ⇒ churned or contracted to 0). */
  currentMrrById: Readonly<Record<string, number>>;
}

export interface RetentionSummary {
  startingLogos: number;
  startingMrr: number;
  retainedLogos: number;        // starting accounts still paying > 0 now
  churnedLogos: number;         // starting accounts now at 0
  logoChurnRate: number;        // churnedLogos ÷ startingLogos (0..1)
  retainedMrr: number;          // current MRR of the starting cohort (net expansion/contraction)
  churnedMrr: number;           // MRR lost from accounts that dropped to 0
  grossRevenueChurnRate: number;// churnedMrr ÷ startingMrr (0..1)
  netRevenueRetention: number;  // retainedMrr ÷ startingMrr (NRR; >1 = net expansion)
}

/** Compute logo churn, gross revenue churn, and net revenue retention (NRR). */
export function computeRetention(input: RetentionInput): RetentionSummary {
  const startingLogos = input.startingActive.length;
  let startingMrr = 0;
  let retainedLogos = 0;
  let retainedMrr = 0;
  let churnedMrr = 0;

  for (const a of input.startingActive) {
    startingMrr += a.mrr;
    const now = input.currentMrrById[a.tenantId] ?? 0;
    if (now > 0) {
      retainedLogos += 1;
      retainedMrr += now;
    }
    if (now < a.mrr) churnedMrr += a.mrr - now; // contraction + full churn both lose MRR
  }

  const churnedLogos = startingLogos - retainedLogos;
  return {
    startingLogos,
    startingMrr,
    retainedLogos,
    churnedLogos,
    logoChurnRate: startingLogos > 0 ? churnedLogos / startingLogos : 0,
    retainedMrr,
    churnedMrr,
    grossRevenueChurnRate: startingMrr > 0 ? churnedMrr / startingMrr : 0,
    netRevenueRetention: startingMrr > 0 ? retainedMrr / startingMrr : 0,
  };
}

// ── Lifetime value ─────────────────────────────────────────────

/**
 * Blended LTV = ARPA × gross margin ÷ monthly churn rate.
 *
 * The classic subscription LTV: average revenue per account divided by the
 * monthly churn rate gives the expected lifetime revenue per customer. Returns
 * `null` when churn is 0 (LTV is unbounded — the UI shows "—" rather than ∞).
 * `grossMargin` defaults to 1 (revenue LTV); pass e.g. 0.8 for margin-adjusted.
 */
export function blendedLtv(
  arpa: number,
  monthlyChurnRate: number,
  grossMargin = 1,
): number | null {
  if (monthlyChurnRate <= 0) return null;
  return (arpa * grossMargin) / monthlyChurnRate;
}

/** Average expected customer lifetime in months (1 ÷ churn), null when churn 0. */
export function avgLifetimeMonths(monthlyChurnRate: number): number | null {
  if (monthlyChurnRate <= 0) return null;
  return 1 / monthlyChurnRate;
}
