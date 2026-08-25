// GET /api/auth/totp/status — whether the signed-in user has TOTP enabled and
// how many recovery codes remain. Proxies to the gateway with the session JWT.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/totp/status`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/totp/status] failed:', err);
    return NextResponse.json({ error: 'failed to load TOTP status' }, { status: 500 });
  }
}
