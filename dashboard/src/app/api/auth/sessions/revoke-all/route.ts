// POST /api/auth/sessions/revoke-all — kill every OTHER active session/device
// (pass { includeCurrent: true } to also end the caller's own). Proxies to
// the gateway with the session JWT forwarded; clears the dashboard's own
// cookie too when the current session was included.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';
import { clearSessionCookie } from '@/lib/session-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    // no body is fine — defaults to "revoke all except current"
  }

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/sessions/revoke-all`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      body: JSON.stringify({ includeCurrent: !!body.includeCurrent }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    const res = NextResponse.json(gw, { status: gwRes.status });
    if (gw?.currentRevoked) clearSessionCookie(res);
    return res;
  } catch (err) {
    console.error('[auth/sessions/revoke-all] failed:', err);
    return NextResponse.json({ error: 'failed to revoke sessions' }, { status: 500 });
  }
}
