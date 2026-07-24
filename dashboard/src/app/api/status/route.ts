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
  return NextResponse.json(status, { status: httpStatus });
}
