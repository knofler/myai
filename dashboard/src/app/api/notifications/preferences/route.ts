// /api/notifications/preferences — proxy to the gateway's preference store.
//
// GET returns the tenant's merged preferences (+ pushConfigured flag and the
// current push-subscription count); PUT forwards a sanitized patch. The
// gateway (runtime/src/notifications/preferences.ts) owns validation and
// persistence — this route only bridges the browser to the Docker network.
//
// REALTIME_NOTIFICATIONS plan, Phase 7.
import { NextResponse } from 'next/server';
import { GATEWAY_HTTP_URL, gatewayHeaders } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PREFS_URL = `${GATEWAY_HTTP_URL}/api/notifications/preferences`;

export async function GET() {
  try {
    const res = await fetch(PREFS_URL, {
      headers: gatewayHeaders(),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json();
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error('[api/notifications/preferences] GET failed:', err);
    return NextResponse.json({ ok: false, error: 'gateway unreachable' }, { status: 502 });
  }
}

export async function PUT(req: Request) {
  try {
    const patch = await req.json();
    const res = await fetch(PREFS_URL, {
      method: 'PUT',
      headers: gatewayHeaders(),
      body: JSON.stringify(patch),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json();
    return NextResponse.json(body, { status: res.status });
  } catch (err) {
    console.error('[api/notifications/preferences] PUT failed:', err);
    return NextResponse.json({ ok: false, error: 'gateway unreachable' }, { status: 502 });
  }
}
