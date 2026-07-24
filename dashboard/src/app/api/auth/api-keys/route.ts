// /api/auth/api-keys — scoped per-tenant API keys (ADR-010 §3.6).
//   GET  → list this tenant's keys (owner/admin) + the scope vocabulary.
//   POST → mint a named, scoped key; the response carries the show-once rawKey.
// Both proxy to the gateway with the session JWT (httpOnly cookie) forwarded as
// a Bearer token — the gateway verifies it and owner/admin-gates.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/api-keys`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/api-keys] list failed:', err);
    return NextResponse.json({ error: 'failed to list api keys' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return NextResponse.json({ error: 'name is required' }, { status: 400 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/api-keys`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      body: JSON.stringify({ name, scopes: body.scopes, env: body.env }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/api-keys] create failed:', err);
    return NextResponse.json({ error: 'failed to create api key' }, { status: 500 });
  }
}
