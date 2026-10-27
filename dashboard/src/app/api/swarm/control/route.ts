// GET /api/swarm/control — the Swarm Control Room snapshot: the gateway's
// `swarm_live` aggregate (coordinator, lanes, claims, mail, PR snapshots,
// today's events) for the active tenant. Dashboard redesign phase 2.
//
// Read-only. When the gateway doesn't serve swarm_live (an older gateway, or
// it's unreachable) the response says so — `available: false` with the reason —
// and the page shows that, never invented lanes. There's no Atlas fallback:
// lane presence and claims are gateway leases, which only the gateway can read.
//
// Same 3s per-tenant cache as GET /api/swarm (its own key), cleared by every
// swarm/mail action route. Auth: not in OPERATOR_PUBLIC, so middleware.ts
// requires the operator session.
import { NextResponse } from 'next/server';
import { callGatewayAsTenant } from '@/lib/gateway';
import { getActiveTenant } from '@/lib/tenant';
import { getCachedSnapshot, setCachedSnapshot } from '@/lib/swarm-cache';
import type { SwarmControlResponse, SwarmLive } from '@/lib/swarm-control';

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, max-age=3, stale-while-revalidate=30' };

function reasonFor(error: string | undefined): string {
  if (!error) return 'The gateway returned no swarm data.';
  if (/unknown tool|not found|method not found|-32601/i.test(error)) {
    return 'This gateway doesn’t serve live swarm data yet. It arrives with the swarm_live update.';
  }
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|timeout|aborted|unreachable|HTTP 5\d\d/i.test(error)) {
    return 'The gateway isn’t reachable from the dashboard right now.';
  }
  return `The gateway refused the request: ${error}`;
}

export async function GET(req: Request) {
  const tenantId = await getActiveTenant();
  const key = `${tenantId}:control`;
  const fresh = new URL(req.url).searchParams.has('fresh');
  const hit = fresh ? null : getCachedSnapshot<SwarmControlResponse>(key);
  if (hit) return NextResponse.json(hit, { headers: HEADERS });

  const result = await callGatewayAsTenant<SwarmLive>('swarm_live', null, {});
  const fetchedAt = new Date().toISOString();
  const body: SwarmControlResponse =
    result.ok && result.data && Array.isArray(result.data.lanes)
      ? { available: true, live: result.data, fetchedAt }
      : { available: false, reason: reasonFor(result.error), fetchedAt };

  setCachedSnapshot(key, body);
  return NextResponse.json(body, { headers: HEADERS });
}
