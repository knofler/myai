// /api/notifications/push — web-push subscription bridge to the gateway.
//
//   GET    → the VAPID public key ({ key }), 404 when push isn't configured
//   POST   → register this browser's PushManager subscription
//   DELETE → deregister by endpoint
//
// The browser can't reach the gateway container directly, so the dashboard
// server proxies these three calls (same pattern as ./preferences).
//
// REALTIME_NOTIFICATIONS plan, Phase 6.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL, gatewayHeaders } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function proxy(path: string, init: RequestInit): Promise<NextResponse> {
  try {
    const res = await fetch(`${GATEWAY_HTTP_URL}${path}`, {
      ...init,
      headers: gatewayHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json();
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error(`[api/notifications/push] ${init.method ?? 'GET'} failed:`, err);
    return NextResponse.json({ ok: false, error: 'gateway unreachable' }, { status: 502 });
  }
}

export async function GET() {
  return proxy('/api/notifications/vapid-public-key', { method: 'GET' });
}

export async function POST(req: Request) {
  const body = await req.text();
  return proxy('/api/notifications/push-subscriptions', { method: 'POST', body });
}

export async function DELETE(req: Request) {
  const body = await req.text();
  return proxy('/api/notifications/push-subscriptions', { method: 'DELETE', body });
}
