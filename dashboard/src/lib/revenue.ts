// Operator revenue analytics — MRR / ARR / NRR / logo churn / blended LTV.
//
// Mirror of runtime/src/analytics/revenue.ts (same discipline as billing.ts ↔
// runtime/src/core/billing.ts) so the dashboard and the gateway compute
// identical numbers from identical inputs. Pure math — no I/O. The /revenue
// page reads the Tenant collection (read-only mirror in db.ts) and feeds these.
//
// CROSS-TENANT by design: this is the operator/board view (aggregated, no tenant
// content), feeding the GTM metrics in plan/GRAND_PRODUCT_ROADMAP §5.

import { ACTIVE_SUBSCRIPTION_STATUSES, isPaidPlan, type TenantPlan, type SubscriptionStatus } from './billing';

export type BillingInterval = 'month' | 'year';

// Defaults from GRAND_PRODUCT_ROADMAP §5 (wedge points of the published bands).
// Overridable via env so a price change never needs a code change.
export const PLAN_MONTHLY_USD: Readonly<Record<TenantPlan, number>> = {
  free: 0,
  solo: Number(process.env.MYAI_PRICE_SOLO_MONTHLY) || 49,
  team: Number(process.env.MYAI_PRICE_TEAM_MONTHLY) || 299,
  scale: Number(process.env.MYAI_PRICE_SCALE_MONTHLY) || 2000,
};

export const PLAN_ANNUAL_USD: Readonly<Record<TenantPlan, number>> = {
  free: 0,
  solo: Number(process.env.MYAI_PRICE_SOLO_ANNUAL) || PLAN_MONTHLY_USD.solo * 10,
  team: Number(process.env.MYAI_PRICE_TEAM_ANNUAL) || PLAN_MONTHLY_USD.team * 10,
  scale: Number(process.env.MYAI_PRICE_SCALE_ANNUAL) || PLAN_MONTHLY_USD.scale * 10,
};

export interface PlanPricing {
  monthly: Readonly<Record<TenantPlan, number>>;
  annual: Readonly<Record<TenantPlan, number>>;
}

export const DEFAULT_PRICING: PlanPricing = { monthly: PLAN_MONTHLY_USD, annual: PLAN_ANNUAL_USD };

export interface TenantBillingSnapshot {
  tenantId: string;
  plan: TenantPlan;
  subscriptionStatus?: SubscriptionStatus;
  billingInterval?: BillingInterval;
}

/** A paid plan with an entitling (active/trialing) status. `past_due` excluded. */
export function isRevenueActive(t: Pick<TenantBillingSnapshot, 'plan' | 'subscriptionStatus'>): boolean {
  return isPaidPlan(t.plan) && ACTIVE_SUBSCRIPTION_STATUSES.includes(t.subscriptionStatus ?? 'none');
}

/** MRR contribution of a single tenant (annual → annual ÷ 12; 0 when inactive). */
export function mrrForSnapshot(t: TenantBillingSnapshot, pricing: PlanPricing = DEFAULT_PRICING): number {
  if (!isRevenueActive(t)) return 0;
  if (t.billingInterval === 'year') return (pricing.annual[t.plan] ?? 0) / 12;
  return pricing.monthly[t.plan] ?? 0;
}

export interface PlanRevenue { plan: TenantPlan; logos: number; mrr: number }

export interface MrrSummary {
  mrr: number;
  arr: number;
  activeLogos: number;
  arpa: number;
  byPlan: PlanRevenue[];
}

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
  return { mrr, arr: mrr * 12, activeLogos, arpa: activeLogos > 0 ? mrr / activeLogos : 0, byPlan };
}

export interface RetentionInput {
  startingActive: ReadonlyArray<{ tenantId: string; mrr: number }>;
  currentMrrById: Readonly<Record<string, number>>;
}

export interface RetentionSummary {
  startingLogos: number;
  startingMrr: number;
  retainedLogos: number;
  churnedLogos: number;
  logoChurnRate: number;
  retainedMrr: number;
  churnedMrr: number;
  grossRevenueChurnRate: number;
  netRevenueRetention: number;
}

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
    if (now < a.mrr) churnedMrr += a.mrr - now;
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

/** Blended LTV = ARPA × margin ÷ monthly churn. null when churn 0 (unbounded). */
export function blendedLtv(arpa: number, monthlyChurnRate: number, grossMargin = 1): number | null {
  if (monthlyChurnRate <= 0) return null;
  return (arpa * grossMargin) / monthlyChurnRate;
}

/** Average expected customer lifetime in months (1 ÷ churn), null when churn 0. */
export function avgLifetimeMonths(monthlyChurnRate: number): number | null {
  if (monthlyChurnRate <= 0) return null;
  return 1 / monthlyChurnRate;
}
