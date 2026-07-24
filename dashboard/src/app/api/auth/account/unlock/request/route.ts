// POST /api/auth/account/unlock/request — resend the self-serve account-unlock
// email (the auto-unlock-after-lockout email already fires on lockout itself;
// this is just the resend path if it didn't arrive in time). Public proxy to
// the gateway, which rate-limits per email and always answers { ok: true } so
// this surface never confirms whether an address has an account or is locked.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/account/unlock/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
      },
      body: JSON.stringify({ email }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/account/unlock/request] failed:', err);
    return NextResponse.json({ error: 'unlock request failed' }, { status: 500 });
  }
}
