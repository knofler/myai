// POST /api/billing/sla-credit — compute a tenant's measured uptime for a
// billing period from the incident log and, on an SLA breach, automatically
// issue a Stripe account credit + notify the tenant (lib/sla-credit.ts).
// Distinct from /api/billing/overage (usage-based invoicing — charges the
// tenant) and the dunning webhook (payment recovery) — this is proactive
// SLA-credit ISSUANCE, an enterprise-contract requirement.
//
// Meant to be called once per tenant at a calendar-month boundary (by the
// scheduler/job or an operator). Idempotent — issuance is skipped with
// `already-issued` when a credit for this tenant + period was already found
// on the Stripe customer (lib/sla-credit.ts `hasExistingSlaCredit`).
//
// OPERATOR-GATED: issuing a credit is a money-moving action, so it requires the
// internal gateway-local token (`x-gateway-local-token`, matching
// GATEWAY_LOCAL_TOKEN) — the same internal credential host scripts use to reach
// the gateway. A tenant's own per-tenant API key still identifies WHICH tenant
// to credit (plan/customer/metadata), but on its own it can NOT issue a credit.
//
// The measurement period is NEVER client-controlled: it is always a whole UTC
// calendar month derived server-side. Default is the month PRECEDING now; an
// operator may target a specific past month with an optional `month` ("YYYY-MM")
// selector, which the server expands to that full calendar month. This closes
// the self-credit hole where a tenant supplied a short window around an incident
// to inflate the shortfall and claim a large % of the monthly fee.
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import { sha256Hex, timingSafeEqualHex } from '@/lib/tenant-keys';
import { priceIdForPlan } from '@/lib/billing';
import {
  isSlaCreditConfigured,
  hasSlaContract,
  previousCalendarMonthUTC,
  runSlaCreditForTenant,
} from '@/lib/sla-credit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Is this an internal/operator request? True only when GATEWAY_LOCAL_TOKEN is
 *  configured AND the caller presents a matching `x-gateway-local-token`.
 *  Fails closed (no configured token → not an operator) and compares in
 *  constant time via sha256 digests so neither value/length leaks. */
function isOperatorRequest(req: Request): boolean {
  const expected = process.env.GATEWAY_LOCAL_TOKEN || '';
  const provided = req.headers.get('x-gateway-local-token') || '';
  if (!expected || !provided) return false;
  return timingSafeEqualHex(sha256Hex(provided), sha256Hex(expected));
}

/** Expand a strict `YYYY-MM` key to its full UTC calendar-month `[start, end)`.
 *  Returns null for a malformed / out-of-range key. */
function calendarMonthUTC(key: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)) return null;
  const [y, m] = key.split('-').map(Number);
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export async function POST(req: Request) {
  if (!isSlaCreditConfigured()) {
    return NextResponse.json({ error: 'SLA credit automation not configured' }, { status: 503 });
  }

  // Money-moving action → operator/internal credential required. A tenant's own
  // API key alone can never issue a credit.
  if (!isOperatorRequest(req)) {
    return NextResponse.json({ error: 'operator credential required' }, { status: 403 });
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
  if (!hasSlaContract(plan)) {
    return NextResponse.json(
      { issued: false, reason: 'no-sla-contract', plan },
      { status: 200 },
    );
  }

  // Server-derived, whole-calendar-month window ONLY — client `from`/`to` are
  // ignored. Optional `month` ("YYYY-MM") lets an operator target a past month.
  let periodStart: Date;
  let periodEnd: Date;
  if (typeof body.month === 'string' && body.month.length > 0) {
    const m = calendarMonthUTC(body.month);
    if (!m) {
      return NextResponse.json({ error: 'invalid month (expected YYYY-MM)' }, { status: 400 });
    }
    periodStart = m.start;
    periodEnd = m.end;
  } else {
    const defaultPeriod = previousCalendarMonthUTC(new Date());
    periodStart = defaultPeriod.start;
    periodEnd = defaultPeriod.end;
  }

  // Never credit an incomplete (in-progress or future) month — a partial window
  // would understate uptime the same way a hand-picked window did.
  if (periodEnd.getTime() > Date.now()) {
    return NextResponse.json({ error: 'month not yet complete' }, { status: 400 });
  }

  try {
    const result = await runSlaCreditForTenant({
      plan,
      stripeCustomerId: auth.tenant.stripeCustomerId,
      priceId: priceIdForPlan(plan, auth.tenant.billingInterval),
      ownerEmail: auth.tenant.ownerEmail,
      tenantName: auth.tenant.name,
      metadata: auth.tenant.metadata,
      periodStart,
      periodEnd,
    });
    return NextResponse.json({ tenantId: auth.tenant.tenantId, plan, ...result });
  } catch (err) {
    console.error('[billing/sla-credit] failed:', err);
    return NextResponse.json({ error: 'could not process SLA credit' }, { status: 502 });
  }
}
