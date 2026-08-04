// /api/gift-codes/revoke — operator-only proxy to the gateway's admin REST
// route (POST /api/gift-codes/revoke, requireAdmin/x-admin-token in
// runtime/src/core/server.ts). Same cross-tenant admin posture as
// /api/gift-codes — see that route for the full rationale.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminHeaders(): Record<string, string> | null {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return null;
  return { 'Content-Type': 'application/json', 'x-admin-token': token };
}

export async function POST(req: Request) {
  const headers = adminHeaders();
  if (!headers) {
    return NextResponse.json({ error: 'admin_disabled', code: 'ADMIN_DISABLED' }, { status: 503 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/gift-codes/revoke`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error('[gift-codes/revoke] POST failed:', err);
    return NextResponse.json({ error: 'failed to reach gateway' }, { status: 500 });
  }
}
