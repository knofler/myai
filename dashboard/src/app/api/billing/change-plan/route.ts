// POST /api/billing/change-plan — upgrade/downgrade a tenant's tier (or switch
// billing interval) in place on an EXISTING Stripe subscription, with correct
// proration (ADR-010 billing follow-up). Upgrades charge the prorated difference
// immediately (`always_invoice`); downgrades credit unused time forward
// (`create_prorations`). See lib/billing.prorationBehaviorForChange.
//
// A tenant with NO active subscription yet is told to use /api/billing/checkout
// instead — this route only mutates a running subscription. The webhook remains
// the single writer of the tenant's plan/status; this route just asks Stripe to
// change the subscription and returns, letting customer.subscription.updated sync
// the tenant row.
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import {
  isStripeConfigured,
  asPaidPlan,
  asBillingInterval,
  priceIdForPlan,
  purchasablePlans,
  getSubscription,
  firstItemId,
  changeSubscriptionPlan,
  prorationBehaviorForChange,
  type TenantPlan,
} from '@/lib/billing';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isStripeConfigured()) {
    return NextResponse.json({ error: 'billing not configured' }, { status: 503 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* key may come from the Authorization header */
  }

  const requested = (typeof body.tier === 'string' && body.tier)
    || (typeof body.plan === 'string' && body.plan)
    || '';
  const plan = asPaidPlan(requested);
  if (!plan) {
    return NextResponse.json(
      { error: `unknown tier "${requested}"`, purchasable: purchasablePlans() },
      { status: 400 },
    );
  }
  const interval = asBillingInterval(
    (typeof body.interval === 'string' && body.interval) || undefined,
  );
  if (!priceIdForPlan(plan, interval)) {
    return NextResponse.json(
      { error: `tier "${plan}" (${interval}) is not available on this deployment`, purchasable: purchasablePlans() },
      { status: 400 },
    );
  }

  const apiKey = keyFromRequest(req) || (typeof body.apiKey === 'string' ? body.apiKey : '');
  const auth = await authenticateTenant(apiKey);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const subId = auth.tenant.stripeSubscriptionId;
  if (!subId) {
    // No running subscription to prorate — the caller should start a checkout.
    return NextResponse.json(
      { error: 'no active subscription — use checkout to start one', useCheckout: true },
      { status: 409 },
    );
  }

  const currentPlan = (auth.tenant.plan as TenantPlan) || 'free';

  try {
    const sub = await getSubscription(subId);
    const itemId = firstItemId(sub);
    if (!itemId) {
      return NextResponse.json({ error: 'subscription has no line item to change' }, { status: 502 });
    }
    const updated = await changeSubscriptionPlan({
      subscriptionId: subId,
      itemId,
      currentPlan,
      plan,
      interval,
    });
    return NextResponse.json({
      ok: true,
      plan,
      interval,
      from: currentPlan,
      proration: prorationBehaviorForChange(currentPlan, plan),
      subscriptionStatus: updated.status,
    });
  } catch (err) {
    console.error('[billing/change-plan] failed:', err);
    return NextResponse.json({ error: 'could not change plan' }, { status: 502 });
  }
}
