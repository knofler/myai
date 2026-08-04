// /api/auth/rbac/shadow-denials
//   GET → this tenant's RBAC shadow-mode denials (ADR-013 §6) — the ring buffer
//         `assertCapability` writes to while RBAC_ENFORCE is off. owner/admin
//         only — the gateway enforces the `members` capability. Forwards query
//         filters (role, capability, action, since, limit) and the session JWT
//         (httpOnly cookie) to the gateway as a Bearer.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  const qs = new URL(req.url).searchParams.toString();
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/rbac/shadow-denials${qs ? `?${qs}` : ''}`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/rbac/shadow-denials] failed:', err);
    return NextResponse.json({ error: 'failed to read rbac shadow denials' }, { status: 500 });
  }
}
