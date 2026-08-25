// /api/flags/[key] — operator-only proxy for per-flag actions:
//   DELETE                         → gateway DELETE /api/flags/:key
//   POST { action: 'kill' }        → gateway POST /api/flags/:key/kill
//   POST { action: 'override', tenantId, enabled } → gateway PUT /api/flags/:key/override
// Same ADMIN_API_TOKEN posture as /api/flags (see that route's header).
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminHeaders(): Record<string, string> | null {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return null;
  return { 'Content-Type': 'application/json', 'x-admin-token': token };
}

async function proxy(method: 'PUT' | 'POST' | 'DELETE', path: string, body?: unknown) {
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

export async function DELETE(_req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  return proxy('DELETE', `/api/flags/${encodeURIComponent(key)}`);
}

export async function POST(req: Request, { params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  let body: { action?: string; tenantId?: string; enabled?: boolean | null };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  if (body.action === 'kill') {
    return proxy('POST', `/api/flags/${encodeURIComponent(key)}/kill`, {});
  }
  if (body.action === 'override') {
    return proxy('PUT', `/api/flags/${encodeURIComponent(key)}/override`, {
      tenantId: body.tenantId,
      enabled: body.enabled ?? null,
    });
  }
  return NextResponse.json({ error: "action must be 'kill' or 'override'" }, { status: 400 });
}
