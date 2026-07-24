// /api/auth/access-review
//   GET → this tenant's quarterly SOC2 access review (ADR-013 §5): members with
//         role, last-active, and stale/never-active flags. owner/admin only —
//         the gateway enforces the `members` capability. Forwards query filters
//         (staleAfterDays, format=csv) and the session JWT to the gateway.
//         format=csv streams the download through unchanged.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  const url = new URL(req.url);
  const qs = url.searchParams.toString();
  const isCsv = url.searchParams.get('format') === 'csv';
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/access-review${qs ? `?${qs}` : ''}`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (isCsv && gwRes.ok) {
      const body = await gwRes.text();
      return new NextResponse(body, {
        status: 200,
        headers: {
          'Content-Type': gwRes.headers.get('content-type') ?? 'text/csv; charset=utf-8',
          'Content-Disposition': gwRes.headers.get('content-disposition') ?? 'attachment; filename="access-review.csv"',
        },
      });
    }
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[auth/access-review] failed:', err);
    return NextResponse.json({ error: 'failed to build access review' }, { status: 500 });
  }
}
