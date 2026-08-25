// POST /api/support/impersonate — operator-only proxy to the gateway's
// support-login-as-tenant route (POST /api/support/impersonate,
// requireAdmin/x-admin-token in runtime/src/core/server.ts). Opens a
// time-boxed, read-only-by-default support session INTO a tenant: on success
// the gateway's impersonation JWT is set as THIS browser's `myai_token`
// session cookie (httpOnly, maxAge = session length) — the operator's
// dashboard becomes the tenant's dashboard until it expires or is ended.
// The raw token is NEVER returned to the browser, only the cookie carries it.
// Goes through the gateway using the operator's ADMIN_API_TOKEN (server-only
// env, never sent to the browser) — the same pattern as /api/gift-codes.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { setSessionCookie } from '@/lib/session-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminHeaders(): Record<string, string> | null {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return null;
  return {
    'Content-Type': 'application/json',
    'x-admin-token': token,
    ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
  };
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const headers = adminHeaders();
  if (!headers) {
    return NextResponse.json({ error: 'admin_disabled', code: 'ADMIN_DISABLED' }, { status: 503 });
  }

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/support/impersonate`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));

    if (!gwRes.ok || !gw.token) {
      return NextResponse.json(gw, { status: gwRes.status });
    }

    // Show-once token → httpOnly cookie only; the browser gets the metadata.
    const res = NextResponse.json(
      { ok: true, expiresAt: gw.expiresAt, readOnly: gw.readOnly, minutes: gw.minutes, user: gw.user, tenantId: gw.tenantId },
      { status: 201 },
    );
    setSessionCookie(res, gw.token, (gw.minutes ?? 30) * 60);
    return res;
  } catch (err) {
    console.error('[support/impersonate] failed:', err);
    return NextResponse.json({ error: 'failed to reach gateway' }, { status: 500 });
  }
}
