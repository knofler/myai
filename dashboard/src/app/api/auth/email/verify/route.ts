// POST /api/auth/email/verify — consume an email-verification token (the
// `?verify=` link from the signup email). Public proxy to the gateway: the
// token itself is the credential, same posture as password reset / account
// unlock. Does not mint or touch the session cookie — verifying an address
// is independent of being signed in.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const token = typeof body.token === 'string' ? body.token.trim() : '';
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/email/verify`, {
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
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/email/verify] failed:', err);
    return NextResponse.json({ error: 'email verification failed' }, { status: 500 });
  }
}
