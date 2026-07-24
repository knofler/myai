// /api/auth/members
//   GET   → list this tenant's members (any signed-in member). Powers the
//           tenant switcher's member list.
//   PATCH → change a member's role (owner/admin only — ADR-013 §4 RBAC v1
//           slice 3). Body { userId, role }. Proxies to the gateway's static
//           POST /api/auth/members/role; the gateway enforces the matrix rules
//           (no owner touch, admin-can't-grant-admin, last-owner protection).
// Both forward the session JWT (httpOnly cookie) to the gateway as a Bearer.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/members`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/members] failed:', err);
    return NextResponse.json({ error: 'failed to list members' }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const userId = typeof body.userId === 'string' ? body.userId : '';
  const role = typeof body.role === 'string' ? body.role : '';
  if (!userId || !role) {
    return NextResponse.json({ error: 'userId and role are required' }, { status: 400 });
  }

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/members/role`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      body: JSON.stringify({ userId, role }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/members] role change failed:', err);
    return NextResponse.json({ error: 'failed to change role' }, { status: 500 });
  }
}
