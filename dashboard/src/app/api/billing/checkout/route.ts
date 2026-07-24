// POST /api/billing/checkout — start a Stripe Checkout for a subscription tier
// (ADR-010 M5 / §7.2 Day 7). Authenticates the tenant by its per-tenant API key
// (Authorization: Bearer … or { apiKey } in the body), creates a subscription
// Checkout Session for the requested `tier` (default Solo) tied to that tenant,
// and returns the hosted-checkout `url`. The webhook flips the tenant to the
// purchased plan / subscriptionStatus=active on payment — this route never
// grants entitlement itself.
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import {
  createCheckoutSession,
  isStripeConfigured,
  asPaidPlan,
  asBillingInterval,
  priceIdForPlan,
  purchasablePlans,
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
    /* body optional — key may come from the Authorization header */
  }

  // Tier selection — `tier` or `plan` in the body; default Solo. Reject an
  // unknown tier or one without a configured Stripe price (not purchasable).
  const requested = (typeof body.tier === 'string' && body.tier)
    || (typeof body.plan === 'string' && body.plan)
    || 'solo';
  const plan = asPaidPlan(requested);
  if (!plan) {
    return NextResponse.json(
      { error: `unknown tier "${requested}"`, purchasable: purchasablePlans() },
      { status: 400 },
    );
  }
  // Billing cadence — 'month' (default) or 'year'. Reject annual if that plan has
  // no annual price configured on this deployment.
  const interval = asBillingInterval(
    (typeof body.interval === 'string' && body.interval) || undefined,
  );
  if (!priceIdForPlan(plan, interval)) {
    return NextResponse.json(
      {
        error: `tier "${plan}" (${interval}) is not available on this deployment`,
        purchasable: purchasablePlans(),
      },
      { status: 400 },
    );
  }
  // Optional operator-supplied discount ids (env-gated inside the lib; ignored
  // when promo codes are disabled). A customer-typed code is handled by Stripe.
  const couponId = typeof body.couponId === 'string' ? body.couponId : undefined;
  const promotionCodeId = typeof body.promotionCodeId === 'string' ? body.promotionCodeId : undefined;

  const apiKey = keyFromRequest(req) || (typeof body.apiKey === 'string' ? body.apiKey : '');
  const auth = await authenticateTenant(apiKey);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    const session = await createCheckoutSession({
      tenantId: auth.tenant.tenantId,
      plan,
      interval,
      ownerEmail: auth.tenant.ownerEmail,
      stripeCustomerId: auth.tenant.stripeCustomerId,
      couponId,
      promotionCodeId,
    });
    return NextResponse.json({ url: session.url, sessionId: session.id, plan, interval });
  } catch (err) {
    console.error('[billing/checkout] failed:', err);
    return NextResponse.json({ error: 'could not start checkout' }, { status: 502 });
  }
}
