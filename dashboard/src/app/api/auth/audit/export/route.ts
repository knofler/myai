// /api/auth/audit/export
//   GET → download the tenant's audit trail as JSON or CSV (?format=csv|json)
//         for SOC2 evidence (ADR-013 §5). owner/admin only. Streams the
//         gateway's response body through unchanged, preserving the
//         Content-Type + Content-Disposition so the browser saves the file.
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
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/auth/audit/export${qs ? `?${qs}` : ''}`, {
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(15000),
    });
    if (!gwRes.ok) {
      const gw = await gwRes.json().catch(() => ({ error: 'export failed' }));
      return NextResponse.json(gw, { status: gwRes.status });
    }
    const body = await gwRes.text();
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': gwRes.headers.get('content-type') ?? 'application/octet-stream',
        'Content-Disposition': gwRes.headers.get('content-disposition') ?? 'attachment; filename="audit.json"',
      },
    });
  } catch (err) {
    console.error('[auth/audit/export] failed:', err);
    return NextResponse.json({ error: 'audit export failed' }, { status: 500 });
  }
}
