// POST /api/auth/signup — PRIMARY self-serve signup: org + email + password
// (MVP M2 graft, PR #239+). Proxies to the gateway, which atomically provisions
// a tenant + owner user (bcrypt password) + the first API key, and returns a
// JWT. We set the JWT as an httpOnly `myai_token` cookie and return the
// show-once raw API key (for connecting a tool/CLI later). New tenants start on
// the free plan; upgrades happen via billing (M5).
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { setSessionCookie } from '@/lib/session-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const JWT_MAX_AGE = Number(process.env.JWT_EXPIRES_SECONDS) || 86400;

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  const password = typeof body.password === 'string' ? body.password : '';
  // Team tier: an invite token switches signup to join-existing-tenant mode —
  // no org name needed (the tenant already exists) and no API key comes back.
  const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken.trim() : '';

  if (!name && !inviteToken) return NextResponse.json({ error: 'organisation name is required' }, { status: 400 });
  if (name.length > 120) return NextResponse.json({ error: 'name too long' }, { status: 400 });
  if (!email) return NextResponse.json({ error: 'email is required' }, { status: 400 });
  if (password.length < 8) {
    return NextResponse.json({ error: 'password must be at least 8 characters' }, { status: 400 });
  }

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/signup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
      },
      body: JSON.stringify({
        email,
        password,
        tenantName: name || undefined,
        displayName: email.split('@')[0],
        inviteToken: inviteToken || undefined,
      }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    if (!gwRes.ok) {
      return NextResponse.json({ error: gw?.error || 'signup failed' }, { status: gwRes.status || 500 });
    }

    const res = NextResponse.json({
      tenant: { tenantId: gw.tenantId, name: gw.tenantName || name, plan: gw.plan || 'free' },
      role: gw.role,
      apiKey: gw.apiKey, // show-once, for connecting a tool/CLI (absent on invite joins)
    });
    setSessionCookie(res, gw.token, JWT_MAX_AGE);
    return res;
  } catch (err) {
    console.error('[auth/signup] failed:', err);
    return NextResponse.json({ error: 'signup failed' }, { status: 500 });
  }
}
