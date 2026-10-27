// POST /api/swarm/action — the Control Room's write path (dashboard redesign
// phase 3). Body: { verb, ...args } for the gateway's swarm_action tool:
//   tell {to, message} · ack {messageId} · release_claim {key, holder, reason?}
//   handoff {key, holder, reason, confirm:true} · stop_swarm {swarmId, reason?, confirm:true}
//
// Operator auth on EVERY call, checked here and not only in middleware: the
// loopback auto-login lets a local browser read the dashboard without the
// operator cookie, but a write needs a verified operator sign-in (401 → the
// page links to /operator-login). The verified user name rides to the gateway
// as `operator` and lands in the `swarm.action` audit row.
//
// Gateway only — no Atlas fallback: the audit chain lives in the gateway, and
// an unaudited write is not allowed. Merge is not a verb; it links out.
import { NextResponse } from 'next/server';
import { callGatewayAsTenant } from '@/lib/gateway';
import { invalidateSwarmCache } from '@/lib/swarm-cache';
import { operatorFromRequest } from '@/lib/operator-auth';
import { SWARM_ACTION_VERBS, type SwarmActionResult } from '@/lib/swarm-control';

export const dynamic = 'force-dynamic';

const FORWARDED = ['to', 'message', 'messageId', 'key', 'holder', 'swarmId', 'reason', 'confirm'] as const;

const STATUS: Record<string, number> = { INVALID: 400, CONFIRM_REQUIRED: 400, NOT_FOUND: 409, FAILED: 502 };

export async function POST(req: Request) {
  const operator = await operatorFromRequest(req);
  if (!operator) {
    return NextResponse.json({ ok: false, code: 'OPERATOR_REQUIRED', error: 'Sign in as operator to act on the swarm' }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const verb = typeof body?.verb === 'string' ? body.verb : '';
  if (!body || !(SWARM_ACTION_VERBS as readonly string[]).includes(verb)) {
    return NextResponse.json({ ok: false, code: 'INVALID', error: `verb must be one of ${SWARM_ACTION_VERBS.join(', ')}` }, { status: 400 });
  }
  const args: Record<string, unknown> = { verb, operator };
  for (const k of FORWARDED) if (body[k] !== undefined) args[k] = body[k];

  invalidateSwarmCache(); // the page refetches right after — never serve it a pre-action snapshot
  const res = await callGatewayAsTenant('swarm_action', null, args);
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, code: 'GATEWAY', error: `The gateway is unreachable, so nothing was done (actions are audited there): ${res.error ?? 'no response'}` },
      { status: 503 },
    );
  }
  const result = res.data as SwarmActionResult;
  invalidateSwarmCache();
  if (result && result.ok) return NextResponse.json(result);
  return NextResponse.json(result ?? { ok: false, code: 'FAILED', error: 'empty gateway reply' }, { status: STATUS[result?.code ?? 'FAILED'] ?? 502 });
}
