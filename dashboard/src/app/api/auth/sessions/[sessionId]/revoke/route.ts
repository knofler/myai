// POST /api/auth/sessions/:sessionId/revoke — kill one active session/device.
// Proxies to the gateway with the session JWT forwarded. When the caller
// revoked their OWN current session (gw.currentRevoked), also clear the
// dashboard's own cookie — the gateway only clears its own, and the dashboard
// forwards the JWT as a Bearer token rather than terminating it itself.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';
import { clearSessionCookie } from '@/lib/session-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request, { params }: { params: Promise<{ sessionId: string }> }) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  const { sessionId } = await params;

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/sessions/${encodeURIComponent(sessionId)}/revoke`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    const res = NextResponse.json(gw, { status: gwRes.status });
    if (gw?.currentRevoked) clearSessionCookie(res);
    return res;
  } catch (err) {
    console.error('[auth/sessions/revoke] failed:', err);
    return NextResponse.json({ error: 'failed to revoke session' }, { status: 500 });
  }
}
