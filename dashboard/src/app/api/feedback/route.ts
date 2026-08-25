// POST /api/feedback — the dashboard feedback widget's submit endpoint
// (design-partner program, GRAND_PRODUCT §7.4). Proxies the gateway's
// JWT-authenticated /api/feedback with the httpOnly `myai_token` cookie
// forwarded as a Bearer — same pattern as /api/referrals.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/feedback`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[feedback] failed:', err);
    return NextResponse.json({ error: 'failed to submit feedback' }, { status: 500 });
  }
}
