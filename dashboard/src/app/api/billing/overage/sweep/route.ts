// POST /api/billing/overage/sweep — report usage-based overage to Stripe for
// EVERY overage-billed tenant over a completed billing period (ADR-014 add-on
// billing, fleet automation). This is the period-boundary job that makes the
// meter → Stripe push real without per-tenant self-serve calls: the singular
// /api/billing/overage route bills ONE tenant with its own API key; this sweep
// walks all of them. Meant to be invoked monthly by the scheduler/cron or an
// operator, same posture as /api/billing/sla-credit.
//
// OPERATOR-GATED: pushing meter events is a money-moving action, so it requires
// the internal gateway-local token (`x-gateway-local-token`, matching
// GATEWAY_LOCAL_TOKEN) — a per-tenant API key can NOT run the fleet sweep.
//
// The billing period is NEVER client-controlled: always a whole UTC calendar
// month derived server-side. Default is the month PRECEDING now; an operator
// may target a specific past month with an optional `month` ("YYYY-MM")
// selector. Incomplete (in-progress/future) months are rejected — billing a
// partial window would under-count the allowance side.
//
// Idempotent — meter-event identifiers are keyed customer+dimension+period
// (Stripe dedupes), so a re-run of the sweep never double-bills.
import { NextResponse } from 'next/server';
import { sha256Hex, timingSafeEqualHex } from '@/lib/tenant-keys';
import { previousCalendarMonthUTC } from '@/lib/sla-credit';
import { isOverageConfigured, runOverageSweep } from '@/lib/overage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Is this an internal/operator request? True only when GATEWAY_LOCAL_TOKEN is
 *  configured AND the caller presents a matching `x-gateway-local-token`.
 *  Fails closed and compares in constant time (same gate as sla-credit). */
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
  if (!isOverageConfigured()) {
    return NextResponse.json({ error: 'overage billing not configured' }, { status: 503 });
  }

  if (!isOperatorRequest(req)) {
    return NextResponse.json({ error: 'operator credential required' }, { status: 403 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    /* body optional — default period is the previous calendar month */
  }

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

  // Never bill an incomplete (in-progress or future) month.
  if (periodEnd.getTime() > Date.now()) {
    return NextResponse.json({ error: 'month not yet complete' }, { status: 400 });
  }

  try {
    const result = await runOverageSweep({ periodStart, periodEnd });
    return NextResponse.json(result);
  } catch (err) {
    console.error('[billing/overage/sweep] failed:', err);
    return NextResponse.json({ error: 'overage sweep failed' }, { status: 502 });
  }
}
