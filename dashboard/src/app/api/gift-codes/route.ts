// /api/gift-codes — operator-only proxy to the gateway's admin REST routes
// (GET/POST /api/gift-codes, requireAdmin/x-admin-token in
// runtime/src/core/server.ts). Mint/list a platform-wide gift/redeemable
// subscription code — no redeeming tenant in scope, so this is a
// cross-tenant admin action, not the dashboard's "active tenant" cookie.
// Goes through the gateway using the operator's ADMIN_API_TOKEN (server-only
// env, never sent to the browser) — the same pattern as
// /api/tenants/[id]/mcp-tools.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminHeaders(): Record<string, string> | null {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return null;
  return { 'Content-Type': 'application/json', 'x-admin-token': token };
}

async function proxy(method: 'GET' | 'POST', body?: unknown) {
  const headers = adminHeaders();
  if (!headers) {
    return NextResponse.json({ error: 'admin_disabled', code: 'ADMIN_DISABLED' }, { status: 503 });
  }
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/gift-codes`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error(`[gift-codes] ${method} failed:`, err);
    return NextResponse.json({ error: 'failed to reach gateway' }, { status: 500 });
  }
}

export async function GET() {
  return proxy('GET');
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  return proxy('POST', body);
}
