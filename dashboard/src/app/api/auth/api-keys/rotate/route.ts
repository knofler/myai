// POST /api/auth/api-keys/rotate — rotate a scoped key with a grace overlap
// (owner/admin). Proxies { keyId, graceMinutes? } to the gateway with the
// session JWT forwarded; the response carries the show-once new rawKey.
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
  if (!body.keyId) return NextResponse.json({ error: 'keyId is required' }, { status: 400 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/api-keys/rotate`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      body: JSON.stringify({ keyId: body.keyId, graceMinutes: body.graceMinutes }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/api-keys/rotate] failed:', err);
    return NextResponse.json({ error: 'failed to rotate api key' }, { status: 500 });
  }
}
