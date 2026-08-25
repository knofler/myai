// POST /api/auth/tenant/2fa-policy — owner/admin toggle for the tenant's
// "require 2FA" enforcement policy (every member without TOTP enabled is
// forced to enrol on next login — see totpEnrollmentRequired in /auth/login).
// Proxies to the gateway with the session JWT; the gateway itself gates this
// to owner/admin (members capability) and audit-logs the change.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/tenant/2fa-policy`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/tenant/2fa-policy] lookup failed:', err);
    return NextResponse.json({ error: 'failed to load 2FA policy' }, { status: 500 });
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

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/tenant/2fa-policy`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      body: JSON.stringify({ enabled: !!body.enabled }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/tenant/2fa-policy] failed:', err);
    return NextResponse.json({ error: 'failed to update 2FA policy' }, { status: 500 });
  }
}
