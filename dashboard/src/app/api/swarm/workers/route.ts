// GET /api/swarm/workers — the /swarm "Workers" panel: connected | down |
// not-configured per execution lane, host + last-check, and 24h/30d
// executions (lib/worker-lanes-atlas.ts WORKER_LANE_DEFS).
//
// Same gateway-then-Atlas shape as /api/swarm: callGatewayAsTenant calls the
// gateway's worker_lane_status MCP tool, which auto-falls-back to Atlas
// (lib/gateway-atlas.ts) when the gateway is unreachable — the Vercel path
// (operator decision 2026-10-02, "Atlas, no tunnel").
//
// Production note (task-496862ee): the hosted deployment carries NO Vercel env
// vars at all, so GATEWAY_MCP_URL *and* MONGODB_URI both sit on their
// Docker-internal defaults — neither the gateway nor the Atlas fallback can
// ever connect from there. `envMissing` flags exactly that case (same
// GATEWAY_URL_IS_DEFAULT precedent as views/brain.tsx) so the panel can show
// the GATEWAY_MCP_URL tunnel/Tailscale fix instead of a bare "fetch failed".
import { NextResponse } from 'next/server';
import { callGatewayAsTenant } from '@/lib/gateway';
import type { WorkerLaneStatus } from '@/lib/worker-lanes-atlas';

export const dynamic = 'force-dynamic';

const HEADERS = { 'Cache-Control': 'private, max-age=10, stale-while-revalidate=60' };

const GATEWAY_URL_IS_DEFAULT = (process.env.GATEWAY_MCP_URL ?? 'http://gateway:3100/mcp') === 'http://gateway:3100/mcp';
const MONGODB_URI_IS_DEFAULT = !process.env.MONGODB_URI;

export async function GET() {
  const result = await callGatewayAsTenant<WorkerLaneStatus>('worker_lane_status', null, {});
  if (result.ok && result.data) {
    return NextResponse.json({ ...result.data, gatewayOk: true }, { headers: HEADERS });
  }
  const envMissing = GATEWAY_URL_IS_DEFAULT && MONGODB_URI_IS_DEFAULT;
  return NextResponse.json(
    {
      lanes: [],
      generatedAt: new Date().toISOString(),
      thresholdMinutes: 25,
      gatewayOk: false,
      envMissing,
      error: result.error ?? 'gateway unreachable',
    },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
