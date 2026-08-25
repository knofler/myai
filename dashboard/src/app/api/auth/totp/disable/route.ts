// POST /api/auth/totp/disable — turn off TOTP for the signed-in user. Requires
// a live code (you must still hold the factor you're removing). Proxies to
// the gateway with the session JWT.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!code) return NextResponse.json({ error: 'code is required' }, { status: 400 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/totp/disable`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      body: JSON.stringify({ code }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/totp/disable] failed:', err);
    return NextResponse.json({ error: 'failed to disable TOTP' }, { status: 500 });
  }
}
