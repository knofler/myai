// /api/flags — operator-only proxy to the gateway's admin feature-flag REST
// routes (GET /api/flags list, PUT /api/flags/:key upsert — requireAdmin/
// x-admin-token in runtime/src/core/server.ts). Flags are platform-wide
// state, so this goes through the operator's ADMIN_API_TOKEN (server-only
// env, never sent to the browser) — same pattern as /api/gift-codes.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminHeaders(): Record<string, string> | null {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return null;
  return { 'Content-Type': 'application/json', 'x-admin-token': token };
}

async function proxy(method: 'GET' | 'PUT', path: string, body?: unknown) {
  const headers = adminHeaders();
  if (!headers) {
    return NextResponse.json({ error: 'admin_disabled', code: 'ADMIN_DISABLED' }, { status: 503 });
  }
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error(`[flags] ${method} ${path} failed:`, err);
    return NextResponse.json({ error: 'failed to reach gateway' }, { status: 500 });
  }
}

export async function GET() {
  return proxy('GET', '/api/flags');
}

// Upsert — body carries the key: { key, description?, state?, rolloutPercent? }.
export async function POST(req: Request) {
  let body: { key?: string } & Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!key) return NextResponse.json({ error: 'key required' }, { status: 400 });
  const { key: _key, ...rest } = body;
  return proxy('PUT', `/api/flags/${encodeURIComponent(key)}`, rest);
}
