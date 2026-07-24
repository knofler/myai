// GET /api/auth/account/unlock/lookup?token=… — public unlock-token preflight
// for the /login?unlock=… landing page (mirrors password/lookup). No auth:
// validity is proven by the token itself.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const token = new URL(req.url).searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'token is required' }, { status: 400 });

  try {
    const gwRes = await fetch(
      `${GATEWAY_HTTP_URL}/api/auth/account/unlock/lookup?token=${encodeURIComponent(token)}`,
      {
        headers: {
          ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
        },
        cache: 'no-store',
        signal: AbortSignal.timeout(8000),
      },
    );
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/account/unlock/lookup] failed:', err);
    return NextResponse.json({ error: 'lookup failed' }, { status: 500 });
  }
}
