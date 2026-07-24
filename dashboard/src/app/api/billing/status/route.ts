// GET /api/billing/status — the entitlement signal the UI (and a tenant's own
// tooling) reads to know whether paid/autonomous features are unlocked
// (ADR-010 M5). Authenticates the tenant by its per-tenant API key and returns
// plan + subscription state + the computed `entitled` verdict + reason.
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import {
  isEntitled,
  entitlementReason,
  isStripeConfigured,
  planLimits,
  purchasablePlans,
  annualAvailableForPlan,
  arePromoCodesEnabled,
  isAutomaticTaxEnabled,
  asBillingInterval,
  PAID_PLANS,
} from '@/lib/billing';
import { isInDunning, dunningMaxAttempts } from '@/lib/dunning';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await authenticateTenant(keyFromRequest(req));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const state = { plan: auth.tenant.plan, subscriptionStatus: auth.tenant.subscriptionStatus };
  return NextResponse.json({
    tenantId: auth.tenant.tenantId,
    plan: auth.tenant.plan,
    subscriptionStatus: auth.tenant.subscriptionStatus ?? 'none',
    entitled: isEntitled(state),
    reason: entitlementReason(state),
    stripeConfigured: isStripeConfigured(),
    // Tier gating signals for the UI.
    limits: planLimits(auth.tenant.plan),
    purchasablePlans: purchasablePlans(),
    // Active billing cadence + discount (reflected on the billing page), plus the
    // set of plans that offer an annual cadence and whether promo codes are on.
    billingInterval: asBillingInterval(auth.tenant.billingInterval),
    discount: auth.tenant.discount ?? null,
    annualPlans: PAID_PLANS.filter((p) => annualAvailableForPlan(p)),
    promoCodesEnabled: arePromoCodesEnabled(),
    // Stripe Tax — checkout collects the billing address + computes sales-tax/
    // VAT/GST for the tenant's region when this deployment has it enabled.
    taxEnabled: isAutomaticTaxEnabled(),
    // Portal is available once the tenant has a Stripe customer (post-first-checkout).
    hasPortal: Boolean(auth.tenant.stripeCustomerId),
    // Dunning / failed-payment recovery signals for the in-app banner.
    dunning: {
      inDunning: isInDunning(auth.tenant.subscriptionStatus),
      failureCount: auth.tenant.paymentFailureCount ?? 0,
      maxAttempts: dunningMaxAttempts(),
      lastFailedAt: auth.tenant.lastPaymentFailedAt ?? null,
    },
  });
}
