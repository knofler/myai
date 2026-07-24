// POST /api/auth/magic-link/consume — complete a passwordless sign-in with a
// single-use link token (PRIMARY auth path alongside password sign-in).
// Mirrors /api/auth/login: authenticate against the gateway (which burns the
// token and mints a session JWT), resolve the tenant's display fields, then
// set the JWT as an httpOnly `myai_token` cookie on the dashboard domain.
import { NextResponse } from 'next/server';
import { connectDB, Tenant } from '@/lib/db';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { setSessionCookie } from '@/lib/session-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JWT_MAX_AGE = Number(process.env.JWT_EXPIRES_SECONDS) || 86400;

interface TenantRow {
  tenantId: string;
  name: string;
  plan: string;
  status: string;
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const token = typeof body.token === 'string' ? body.token : '';
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 });

  try {
    // 1. Authenticate against the gateway (burns the token, mints the JWT).
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/magic-link/consume`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
      },
      body: JSON.stringify({ token }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    if (!gwRes.ok) {
      return NextResponse.json({ error: gw?.error || 'sign-in failed' }, { status: gwRes.status || 400 });
    }

    // 2. Resolve the tenant's display fields for the session/switcher UI.
    await connectDB();
    const tenant = await Tenant.findOne({ tenantId: gw.tenantId })
      .lean<TenantRow | null>()
      .exec();
    if (!tenant || tenant.status !== 'active') {
      return NextResponse.json({ error: 'tenant not active' }, { status: 403 });
    }

    // 3. Set the JWT session cookie on the dashboard domain + return identity.
    const res = NextResponse.json({
      tenant: { tenantId: tenant.tenantId, name: tenant.name, plan: tenant.plan },
      user: { role: gw.role, displayName: gw.displayName },
    });
    setSessionCookie(res, gw.token, JWT_MAX_AGE);
    return res;
  } catch (err) {
    console.error('[auth/magic-link/consume] failed:', err);
    return NextResponse.json({ error: 'sign-in failed' }, { status: 500 });
  }
}
