// POST /api/billing/portal — open the Stripe Billing Portal for the tenant
// (ADR-010 M5 / §7.2 Day 7). Authenticates the tenant by its per-tenant API key
// and returns a hosted `url` where the customer can manage/cancel their
// subscription and update payment details. Requires an existing Stripe customer
// (set on the tenant by the webhook after the first checkout) — a tenant that
// has never subscribed gets a 409 telling the UI to start checkout instead.
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import { createBillingPortalSession, isStripeConfigured } from '@/lib/billing';

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

  const apiKey = keyFromRequest(req) || (typeof body.apiKey === 'string' ? body.apiKey : '');
  const auth = await authenticateTenant(apiKey);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  if (!auth.tenant.stripeCustomerId) {
    return NextResponse.json(
      { error: 'no subscription yet — start checkout first' },
      { status: 409 },
    );
  }

  try {
    const returnUrl = typeof body.returnUrl === 'string' ? body.returnUrl : undefined;
    const session = await createBillingPortalSession({
      stripeCustomerId: auth.tenant.stripeCustomerId,
      returnUrl,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error('[billing/portal] failed:', err);
    return NextResponse.json({ error: 'could not open billing portal' }, { status: 502 });
  }
}
