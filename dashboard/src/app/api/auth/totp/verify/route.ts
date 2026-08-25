// POST /api/auth/totp/verify — the second half of login for a TOTP-enabled
// account. Mirrors /api/auth/login: authenticate against the gateway (which
// checks the code/recovery-code against the pendingToken's user and mints a
// session JWT), resolve the tenant's display fields, then set the JWT as an
// httpOnly `myai_token` cookie on the dashboard domain. Public — authenticated
// by the short-lived pendingToken, not a session cookie (there is no session yet).
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

  const pendingToken = typeof body.pendingToken === 'string' ? body.pendingToken : '';
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!pendingToken || !code) {
    return NextResponse.json({ error: 'pendingToken and code are required' }, { status: 400 });
  }

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/totp/verify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
      },
      body: JSON.stringify({ pendingToken, code }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    if (!gwRes.ok) {
      // Forwards 401 (invalid code), 429 (rate limited), etc. without leaking detail.
      return NextResponse.json({ error: gw?.error || 'verification failed' }, { status: gwRes.status || 401 });
    }

    await connectDB();
    const tenant = await Tenant.findOne({ tenantId: gw.tenantId })
      .lean<TenantRow | null>()
      .exec();
    if (!tenant || tenant.status !== 'active') {
      return NextResponse.json({ error: 'tenant not active' }, { status: 403 });
    }

    const res = NextResponse.json({
      tenant: { tenantId: tenant.tenantId, name: tenant.name, plan: tenant.plan },
      user: { role: gw.role, displayName: gw.displayName },
      recoveryCodeUsed: !!gw.recoveryCodeUsed,
    });
    setSessionCookie(res, gw.token, JWT_MAX_AGE);
    return res;
  } catch (err) {
    console.error('[auth/totp/verify] failed:', err);
    return NextResponse.json({ error: 'verification failed' }, { status: 500 });
  }
}
