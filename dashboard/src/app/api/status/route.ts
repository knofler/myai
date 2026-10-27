// Public status API — the machine-readable feed behind the /status page and
// the target for external uptime probes.
//
// Intentionally UNAUTHENTICATED: a status page must be reachable when the
// product is degraded and by anyone. It exposes only up/down + latency, no
// tenant data. Added to PUBLIC_PREFIXES in middleware.ts. All aggregation
// lives in lib/status.ts so the page and this route never drift.

import { NextResponse } from 'next/server';
import { getPublicStatus } from '@/lib/status';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await getPublicStatus();
  // Map overall status to an HTTP code so a probe can alert on non-200.
  const httpStatus = status.status === 'down' ? 503 : 200;
  // CDN cache (web-perceived-performance playbook, layer "safe read route"):
  // this is public, un-tenanted, and changes slowly, so Vercel's edge can
  // answer most hits without touching the gateway. 'down' is deliberately
  // excluded — never let the CDN serve a cached outage past its TTL; an
  // operational/degraded read is safe to go briefly stale while refreshing
  // behind it.
  const headers: Record<string, string> =
    httpStatus === 200 ? { 'cache-control': 'public, s-maxage=15, stale-while-revalidate=45' } : {};
  return NextResponse.json(status, { status: httpStatus, headers });
}
