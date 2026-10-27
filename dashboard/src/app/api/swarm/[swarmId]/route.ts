// POST /api/swarm/[swarmId] — operator actions on one swarm from /swarm:
//   { "action": "approve" }  → swarm_approve (paused/stopped → active; children claimable)
//   { "action": "stop", "reason"?: string } → swarm_action stop_swarm (kill switch;
//     mails participants; operator sign-in required and audited in the gateway)
// Through the local gateway when reachable. Without it (Vercel), approve runs
// straight on Atlas with the same rules (lib/swarm-atlas.ts); stop is refused
// with 503, because a stop must leave an audit row and the trail is the gateway's.
// Operator-session only (middleware.ts). The refusal reason is returned as-is
// so the page can say WHY.
import { NextResponse } from 'next/server';
import { callGatewayAsTenant } from '@/lib/gateway';
import { getActiveTenant } from '@/lib/tenant';
import { invalidateSwarmCache } from '@/lib/swarm-cache';
import { approveSwarmAtlas, SwarmActionError } from '@/lib/swarm-atlas';
import { operatorFromRequest } from '@/lib/operator-auth';

export const dynamic = 'force-dynamic';

const BY = 'operator (dashboard /swarm)';

function unreachable(error?: string) {
  return !error || /HTTP 5\d\d|fetch failed|unreachable|ECONNREFUSED|ENOTFOUND|timeout|aborted/i.test(error);
}

export async function POST(req: Request, { params }: { params: Promise<{ swarmId: string }> }) {
  invalidateSwarmCache(); // the console refreshes right after this — never serve it a pre-action snapshot
  const { swarmId } = await params;
  if (!/^swarm-[0-9a-f-]{8,}$/.test(swarmId)) {
    return NextResponse.json({ error: 'invalid swarmId' }, { status: 400 });
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string; reason?: string };
  if (body.action !== 'approve' && body.action !== 'stop') {
    return NextResponse.json({ error: 'action must be "approve" or "stop"' }, { status: 400 });
  }
  const reason = typeof body.reason === 'string' && body.reason.trim() ? body.reason.trim().slice(0, 500) : 'Stopped from the /swarm dashboard';

  let operator: string | null = null;
  if (body.action === 'stop') {
    operator = await operatorFromRequest(req);
    if (!operator) return NextResponse.json({ error: 'Sign in as operator to stop a swarm' }, { status: 401 });
  }
  const result = body.action === 'approve'
    ? await callGatewayAsTenant('swarm_approve', null, { swarmId, approvedBy: BY })
    : await callGatewayAsTenant('swarm_action', null, { verb: 'stop_swarm', swarmId, reason, confirm: true, operator });
  if (result.ok) {
    const data = result.data as { ok?: boolean; error?: string; code?: string; result?: unknown } | undefined;
    if (body.action === 'stop' && data?.ok !== true) {
      const status = data?.code === 'NOT_FOUND' ? 404 : data?.code === 'INVALID' || data?.code === 'CONFIRM_REQUIRED' ? 400 : 502;
      return NextResponse.json({ error: data?.error ?? 'stop failed' }, { status });
    }
    invalidateSwarmCache();
    return NextResponse.json(body.action === 'stop' ? data?.result : result.data);
  }
  if (!unreachable(result.error)) return NextResponse.json({ error: result.error }, { status: 502 });

  // No gateway: a stop is refused, never written to Atlas behind the audit
  // trail's back (the trail lives in the gateway — phase 3 rule).
  if (body.action === 'stop') {
    return NextResponse.json(
      { error: 'The gateway is unreachable, so the swarm was not stopped (stops are audited there).' },
      { status: 503 },
    );
  }

  // No gateway (Vercel): approve on Atlas directly with swarm-store's rules.
  try {
    const tenantId = await getActiveTenant();
    const done = await approveSwarmAtlas(tenantId, swarmId, `${BY} · cloud`);
    if (!done) return NextResponse.json({ error: `swarm ${swarmId} not found` }, { status: 404 });
    invalidateSwarmCache();
    return NextResponse.json(done);
  } catch (err) {
    const status = err instanceof SwarmActionError ? 409 : 502;
    return NextResponse.json({ error: err instanceof Error ? err.message : 'action failed' }, { status });
  }
}
