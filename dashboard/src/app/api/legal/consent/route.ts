// /api/legal/consent — JWT-authenticated proxy for the gateway's click-wrap
// consent endpoints (core/legal.ts). GET returns the caller's tenant consent
// status (drives the re-consent banner when a legal-document version bumps);
// POST records a fresh acceptance at the current versions.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { jwtFromCookies, gatewayAuthHeaders } from '@/lib/jwt-proxy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function proxy(req: Request, method: 'GET' | 'POST') {
  const jwt = jwtFromCookies(req);
  if (!jwt) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });

  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/legal/consent`, {
      method,
      headers: gatewayAuthHeaders(jwt),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[legal/consent] proxy failed:', err);
    return NextResponse.json({ error: 'consent request failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  return proxy(req, 'GET');
}

export async function POST(req: Request) {
  return proxy(req, 'POST');
}
