// POST /api/brain/host/rotate — ADR-023 Slice P1a. Mints a fresh hosted-brain
// access token for THIS tenant (leak response / reissue), invalidating the
// old one, by proxying to the gateway's existing `brain_host_rotate` MCP
// tool with the caller's own tenant API key forwarded. Returns the remote URL
// + the new one-time token; the client shows it exactly once.
import { NextResponse } from 'next/server';
import { callGatewayAsTenant } from '@/lib/gateway';
import type { HostedBrainProvisionResult } from '@/lib/hosted-brain';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const authHeader = req.headers.get('authorization');
  if (!authHeader) {
    return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  }

  const result = await callGatewayAsTenant<HostedBrainProvisionResult>('brain_host_rotate', authHeader);
  if (!result.ok) {
    // Order matters: the plan-not-entitled message ("plan 'x' HAS NO hosted
    // brain — upgrade...") also contains "no hosted brain", so the more
    // specific entitlement check must run before the generic not-provisioned
    // one or a downgraded tenant would get a misleading 404 instead of 403.
    const err = result.error ?? '';
    const status = /has no hosted brain/i.test(err) ? 403 : /no hosted brain/i.test(err) ? 404 : 502;
    return NextResponse.json({ error: result.error ?? 'could not rotate the hosted brain token' }, { status });
  }
  return NextResponse.json(result.data);
}
