// POST /api/auth/email/resend — resend the verification email to the CALLER's
// own address. JWT-authenticated (the httpOnly `myai_token` cookie forwarded
// as a Bearer), so unlike password/forgot this never takes an email in the
// body — there is nothing to enumerate. Powers the dashboard's unverified-
// email banner.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/email/resend`, {
      method: 'POST',
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/email/resend] failed:', err);
    return NextResponse.json({ error: 'failed to resend verification email' }, { status: 500 });
  }
}
