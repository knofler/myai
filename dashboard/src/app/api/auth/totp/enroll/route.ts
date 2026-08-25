// POST /api/auth/totp/enroll — start TOTP enrolment for the signed-in user
// (step 1: generate a pending secret + otpauth:// URI, not yet active).
// Proxies to the gateway with the session JWT forwarded as a Bearer token.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/totp/enroll`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/totp/enroll] failed:', err);
    return NextResponse.json({ error: 'failed to start TOTP enrolment' }, { status: 500 });
  }
}
