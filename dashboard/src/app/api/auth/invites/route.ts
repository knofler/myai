// /api/auth/invites — Team-tier tenant invites (M2 gap close).
//   GET  → list this tenant's invites (owner/admin).
//   POST → create an email-addressed, expiring invite; response carries the
//          show-once token the UI turns into a /login?invite=… link.
// Both proxy to the gateway with the caller's JWT (httpOnly cookie) forwarded
// as a Bearer token — the gateway's invite routes verify it and role-gate.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/invites`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/invites] list failed:', err);
    return NextResponse.json({ error: 'failed to list invites' }, { status: 500 });
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
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/invites`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      body: JSON.stringify({ email, role: body.role, expiresInDays: body.expiresInDays }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/invites] create failed:', err);
    return NextResponse.json({ error: 'failed to create invite' }, { status: 500 });
  }
}
