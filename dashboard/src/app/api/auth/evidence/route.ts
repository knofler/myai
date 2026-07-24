// /api/auth/evidence
//   GET → download the tenant's SOC2 evidence-export report (ADR-013 §5): the
//         access review + audit-trail coverage in one auditor-ready JSON bundle.
//         owner/admin only. Streams the gateway's JSON download through
//         unchanged, preserving Content-Type + Content-Disposition. Query:
//         ?since / ?until (audit period), ?staleAfterDays (review window).
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  const qs = new URL(req.url).searchParams.toString();
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/evidence${qs ? `?${qs}` : ''}`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!gwRes.ok) {
      const gw = await gwRes.json().catch(() => ({ error: 'evidence export failed' }));
      return NextResponse.json(gw, { status: gwRes.status });
    }
    const body = await gwRes.text();
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': gwRes.headers.get('content-type') ?? 'application/json; charset=utf-8',
        'Content-Disposition': gwRes.headers.get('content-disposition') ?? 'attachment; filename="soc2-evidence.json"',
      },
    });
  } catch (err) {
    console.error('[auth/evidence] failed:', err);
    return NextResponse.json({ error: 'evidence export failed' }, { status: 500 });
  }
}
