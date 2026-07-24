// GET /api/auth/me — the current session user (id, email, role, tenant).
// Proxies the gateway's JWT-authenticated /api/auth/me with the httpOnly
// `myai_token` cookie forwarded as a Bearer. The tenant switcher reads `role`
// from here to gate owner-only controls (member role management — ADR-013 §4).
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/me`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/me] failed:', err);
    return NextResponse.json({ error: 'failed to load session' }, { status: 500 });
  }
}
