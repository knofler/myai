// POST /api/auth/account/unlock/consume — clear an account lockout with a
// single-use unlock token. Public proxy: validity is proven by the token
// itself; the gateway rate-limits. This only unlocks the account — it does
// NOT log the user in (distinct from magic-link/consume), so no session
// cookie is set here; the user still authenticates with their password.
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
  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/account/unlock/consume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
      },
      body: JSON.stringify({ token }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/account/unlock/consume] failed:', err);
    return NextResponse.json({ error: 'account unlock failed' }, { status: 500 });
  }
}
