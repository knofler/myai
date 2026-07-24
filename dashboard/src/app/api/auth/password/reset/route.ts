// POST /api/auth/password/reset — set a new password with a reset token
// (Team tier). Public proxy: validity is proven by the single-use, expiring
// token from the reset email; the gateway rate-limits and does the bcrypt work.
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
  const password = typeof body.password === 'string' ? body.password : '';
  if (!token || !password) {
    return NextResponse.json({ error: 'token and password are required' }, { status: 400 });
  }

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/password/reset`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
      },
      body: JSON.stringify({ token, password }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/password/reset] failed:', err);
    return NextResponse.json({ error: 'password reset failed' }, { status: 500 });
  }
}
