// POST /api/auth/impersonation/end — end the active support-impersonation
// session. Proxies the gateway's JWT-authenticated
// POST /api/auth/impersonation/end (which revokes the session row and stamps
// `impersonation.end` in the tenant's audit chain) and clears the local
// `myai_token` cookie regardless of body shape — same posture as the session
// revoke proxies.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';
import { clearSessionCookie } from '@/lib/session-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/impersonation/end`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    const res = NextResponse.json(gw, { status: gwRes.status });
    // The impersonation cookie is useless (revoked) once the gateway confirms —
    // clear it so the operator lands back on their own login, not a 401 loop.
    if (gwRes.ok) clearSessionCookie(res);
    return res;
  } catch (err) {
    console.error('[impersonation/end] failed:', err);
    return NextResponse.json({ error: 'failed to reach gateway' }, { status: 500 });
  }
}
