// GET /api/referrals — the current tenant's referral code + stats (GROWTH).
// Proxies the gateway's JWT-authenticated /api/referrals/me with the httpOnly
// `myai_token` cookie forwarded as a Bearer — same pattern as /api/auth/me.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/referrals/me`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[referrals] failed:', err);
    return NextResponse.json({ error: 'failed to load referral stats' }, { status: 500 });
  }
}
