// /api/auth/audit/verify
//   GET → recompute this tenant's audit-trail hash chain from the on-disk
//         trail and report any gap/mutation (ADR-013 §5 tamper-evidence).
//         owner/admin only — the gateway enforces the `members` capability.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/audit/verify`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/audit/verify] failed:', err);
    return NextResponse.json({ error: 'audit chain verification failed' }, { status: 500 });
  }
}
