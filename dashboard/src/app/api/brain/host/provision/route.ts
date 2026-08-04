// POST /api/brain/host/provision — ADR-023 Slice P1a. Provisions (or adopts)
// THIS tenant's hosted brain remote (ADR-017) by proxying to the gateway's
// existing `brain_host_provision` MCP tool, forwarding the caller's own
// tenant API key so the gateway resolves the paying tenant, not the
// dashboard's shared default/local context. Returns the remote URL + a
// one-time access token — the gateway never persists the plaintext, so this
// response is the only chance to see it (the client shows it exactly once).
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

  const result = await callGatewayAsTenant<HostedBrainProvisionResult>('brain_host_provision', authHeader);
  if (!result.ok) {
    const status = /has no hosted brain/i.test(result.error ?? '') ? 403 : 502;
    return NextResponse.json({ error: result.error ?? 'could not provision the hosted brain' }, { status });
  }
  return NextResponse.json(result.data);
}
