// /api/tenants/[id]/mcp-tools — operator-only proxy to the gateway's admin
// REST endpoint (GET/PATCH /api/tenants/:id/mcp-tools, requireAdmin in
// runtime/src/core/server.ts). Views/edits ITenant.mcpToolAllowlist /
// .mcpToolDenylist (core/rbac.ts OPERATOR_ONLY_TOOLS override) for an
// ARBITRARY tenant — a cross-tenant admin action, not the dashboard's "active
// tenant" cookie — so unlike /api/routing-policy this never touches Mongo
// directly. It goes through the gateway the same way /api/auth/permissions
// does, using the operator's ADMIN_API_TOKEN (server-only env, never sent to
// the browser).
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function adminHeaders(): Record<string, string> | null {
  const token = process.env.ADMIN_API_TOKEN;
  if (!token) return null;
  return { 'Content-Type': 'application/json', 'x-admin-token': token };
}

async function proxy(method: 'GET' | 'PATCH', id: string, body?: unknown) {
  const headers = adminHeaders();
  if (!headers) {
    return NextResponse.json({ error: 'admin_disabled', code: 'ADMIN_DISABLED' }, { status: 503 });
  }
  try {
    const gwRes = await fetch(`${GATEWAY_HTTP_URL}/api/tenants/${encodeURIComponent(id)}/mcp-tools`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const gw = await gwRes.json().catch(() => ({}));
    return NextResponse.json(gw, { status: gwRes.status });
  } catch (err) {
    console.error(`[tenants/mcp-tools] ${method} failed:`, err);
    return NextResponse.json({ error: 'failed to reach gateway' }, { status: 500 });
  }
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return proxy('GET', id);
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  return proxy('PATCH', id, body);
}
