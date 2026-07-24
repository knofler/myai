// POST /api/billing/overage — report a tenant's usage-based overage to Stripe
// for a billing period (ADR-014 add-on-billing follow-up; consumes the S2 meter).
// Meant to be called at a Stripe billing-period boundary (by the scheduler/job
// or an operator): it reads the product meter for [from, to), subtracts the
// tier's included allowance, and reports the overage to Stripe metered billing.
//
// Env-gated: returns 503 unless STRIPE_OVERAGE_ENABLED is on and a meter is
// configured. Authenticated by the per-tenant API key. Idempotent — the
// meter-event identifier is keyed by customer+dimension+period, so a re-run
// never double-bills. Body (all optional): { from, to } ISO timestamps to bound
// the period exactly (default: calendar-month-to-date, UTC).
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import {
  isOverageConfigured,
  isOverageBilled,
  getOverageUsage,
  invoiceTenantOverage,
} from '@/lib/overage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** UTC start-of-month — the default period start when the caller omits `from`. */
function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function parseDate(v: unknown): Date | undefined {
  if (typeof v !== 'string') return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function POST(req: Request) {
  if (!isOverageConfigured()) {
    return NextResponse.json({ error: 'overage billing not configured' }, { status: 503 });
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

  const plan = auth.tenant.plan;
  if (!isOverageBilled(plan)) {
    return NextResponse.json(
      { reported: false, reason: 'not-billed-plan', plan },
      { status: 200 },
    );
  }

  const from = parseDate(body.from) ?? startOfMonthUTC();
  const to = parseDate(body.to);
  const periodEnd = to ?? new Date();

  try {
    const totals = await getOverageUsage(auth.tenant.tenantId, { from, to });
    const result = await invoiceTenantOverage({
      plan,
      stripeCustomerId: auth.tenant.stripeCustomerId,
      totals,
      periodEnd,
    });
    return NextResponse.json({
      tenantId: auth.tenant.tenantId,
      plan,
      period: { from: from.toISOString(), to: to?.toISOString() },
      usage: totals,
      ...result,
    });
  } catch (err) {
    console.error('[billing/overage] failed:', err);
    return NextResponse.json({ error: 'could not report overage' }, { status: 502 });
  }
}
