// POST /api/auth/login — PRIMARY login: email + password (MVP M2 graft, PR #239+).
// Proxies to the gateway's password-auth endpoint (the single auth authority:
// bcrypt verify + HS256 JWT), then sets the JWT as an httpOnly `myai_token`
// cookie on the dashboard domain and returns the tenant identity. The tenant's
// name/plan are looked up from Mongo (the gateway login response carries only
// ids + role). The per-tenant API key is NOT involved here — that is the
// secondary "connect a tool" path (/api/auth/connect).
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

  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!email || !password) {
    return NextResponse.json({ error: 'email and password are required' }, { status: 400 });
  }

  try {
    // 1. Authenticate against the gateway (bcrypt + JWT live there).
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/login`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
      },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    if (!gwRes.ok) {
      // Forward the gateway's status (401 invalid creds, etc.) without leaking detail.
      return NextResponse.json({ error: gw?.error || 'login failed' }, { status: gwRes.status || 401 });
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
    console.error('[auth/login] failed:', err);
    return NextResponse.json({ error: 'login failed' }, { status: 500 });
  }
}
