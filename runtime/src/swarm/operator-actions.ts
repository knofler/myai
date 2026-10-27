/**
 * swarm_action — the operator's write path from the dashboard Control Room
 * (dashboard redesign phase 3). One verb per call:
 *
 *   tell          { to, message }              mail a lane (kind live-note — never auto-claimed)
 *   ack           { messageId }                mark one mail read
 *   release_claim { key, holder }              free a file claim (claim:<repo>:<path>)
 *   handoff       { key, holder, reason, confirm:true }
 *                                              step a coordinator down (swarm-coordinator:<host>)
 *   stop_swarm    { swarmId, reason, confirm:true }
 *                                              the swarm_stop kill switch
 *
 * Every call — refused, failed or done — appends ONE `swarm.action` row to the
 * tenant's audit chain. The actor comes from the server-resolved ToolContext
 * (auditActorFromCtx), never from args; `operator` in args is the dashboard's
 * verified sign-in name and is recorded as detail only.
 *
 * Releases are holder-scoped (no force): the dashboard passes the holder it
 * displayed, so if another session took the lease in between, nothing is
 * deleted and the operator is told. The released holder is mailed so the lane
 * learns why its lease vanished. handoff and stop_swarm refuse without
 * `confirm: true` — the page's confirm step, enforced again here.
 *
 * Merge is deliberately absent: it stays a link out to GitHub until it can go
 * through the ship lock (coordinator rule, 2026-10-21).
 */
import { recordAuditEvent, type AuditActor } from '../core/audit-log.js';
import { sendMail, ackMail } from '../notifications/mailbox-store.js';
import { releaseKeyedLease } from '../tasks/keyed-lease-store.js';
import { stopSwarm } from '../tasks/swarm-store.js';

export const SWARM_ACTION_VERBS = ['tell', 'ack', 'release_claim', 'handoff', 'stop_swarm'] as const;
export type SwarmActionVerb = (typeof SWARM_ACTION_VERBS)[number];

/** Who the mail comes from — one fixed address so lanes can tell it apart. */
export const OPERATOR_ADDRESS = 'dashboard/operator';
export const MAX_TELL_CHARS = 2000;

const ADDRESS_RE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAIL_ID_RE = /^mail-[0-9a-f-]{8,}$/;
const SWARM_ID_RE = /^swarm-[0-9a-f-]{8,}$/;
const HOLDER_RE = /^[^/\s]+\/[^/\s]+\/\S+$/;

export interface SwarmActionDeps {
  sendMail: typeof sendMail;
  ackMail: typeof ackMail;
  releaseKeyedLease: typeof releaseKeyedLease;
  stopSwarm: typeof stopSwarm;
  audit: typeof recordAuditEvent;
}

// Resolved per call, not at import: tests that partially mock these stores
// import mcp/tools.ts (and so this module) without every export present.
const realDeps = (): SwarmActionDeps => ({ sendMail, ackMail, releaseKeyedLease, stopSwarm, audit: recordAuditEvent });

export type SwarmActionResult =
  | { ok: true; verb: SwarmActionVerb; target: string; result: Record<string, unknown> }
  | { ok: false; verb?: string; target?: string; error: string; code: 'INVALID' | 'CONFIRM_REQUIRED' | 'NOT_FOUND' | 'FAILED' };

class Refusal extends Error {
  constructor(message: string, readonly code: 'INVALID' | 'CONFIRM_REQUIRED' | 'NOT_FOUND' | 'FAILED') { super(message); }
}

function str(v: unknown, max = 500): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** "<host>/<lane>/<pid>" → "<host>/<lane>", the lane's mailbox. */
export function holderAddress(holder: string): string {
  const [host, lane] = holder.split('/');
  return `${host}/${lane}`;
}

function needHolder(args: Record<string, unknown>): string {
  const holder = str(args.holder, 200);
  if (!HOLDER_RE.test(holder)) throw new Refusal('holder must be "<host>/<lane>/<pid>"', 'INVALID');
  return holder;
}

function needConfirm(args: Record<string, unknown>, verb: string): void {
  if (args.confirm !== true) throw new Refusal(`${verb} needs confirm: true`, 'CONFIRM_REQUIRED');
}

async function release(
  tenantId: string, deps: SwarmActionDeps, key: string, holder: string, operator: string, why: string,
): Promise<Record<string, unknown>> {
  const res = await deps.releaseKeyedLease(tenantId, { key, holder });
  if (!res.released) throw new Refusal(res.reason ?? `lease ${key} not held by ${holder}`, 'NOT_FOUND');
  // Tell the holder; a failed notice never undoes the release.
  let notified: string | null = holderAddress(holder);
  try {
    await deps.sendMail(tenantId, {
      to: notified, from: OPERATOR_ADDRESS, kind: 'live-note', subject: `${operator} released ${key}`, body: why,
    });
  } catch {
    notified = null;
  }
  return { released: true, key, holder, notified };
}

async function run(
  tenantId: string, verb: SwarmActionVerb, args: Record<string, unknown>, operator: string, deps: SwarmActionDeps,
): Promise<{ target: string; result: Record<string, unknown>; detail?: Record<string, unknown> }> {
  switch (verb) {
    case 'tell': {
      const to = str(args.to, 120);
      const message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!ADDRESS_RE.test(to)) throw new Refusal('to must be a lane address "<host>/<lane>"', 'INVALID');
      if (!message) throw new Refusal('message is required', 'INVALID');
      if (message.length > MAX_TELL_CHARS) throw new Refusal(`message is over ${MAX_TELL_CHARS} characters`, 'INVALID');
      const subject = message.split('\n')[0].slice(0, 120);
      const msg = await deps.sendMail(tenantId, { to, from: OPERATOR_ADDRESS, kind: 'live-note', subject, body: message });
      return { target: to, result: { sent: true, messageId: msg.messageId }, detail: { messageId: msg.messageId, chars: message.length } };
    }
    case 'ack': {
      const id = str(args.messageId, 80);
      if (!MAIL_ID_RE.test(id)) throw new Refusal('messageId must be a mail-… id', 'INVALID');
      const msg = await deps.ackMail(tenantId, { messageId: id, ackedBy: `${operator} (dashboard)` });
      if (!msg) throw new Refusal(`message not found: ${id}`, 'NOT_FOUND');
      return { target: id, result: { acked: true, messageId: id } };
    }
    case 'release_claim': {
      const key = str(args.key, 400);
      if (!key.startsWith('claim:')) throw new Refusal('key must be a claim:<repo>:<path> lease', 'INVALID');
      const holder = needHolder(args);
      const why = str(args.reason) || 'Released from the dashboard Control Room.';
      return { target: key, result: await release(tenantId, deps, key, holder, operator, why), detail: { holder } };
    }
    case 'handoff': {
      const key = str(args.key, 200);
      if (!key.startsWith('swarm-coordinator:')) throw new Refusal('key must be a swarm-coordinator:<host> lease', 'INVALID');
      const holder = needHolder(args);
      const reason = str(args.reason);
      if (!reason) throw new Refusal('handoff needs a reason', 'INVALID');
      needConfirm(args, 'handoff');
      return { target: key, result: await release(tenantId, deps, key, holder, operator, reason), detail: { holder, reason } };
    }
    case 'stop_swarm': {
      const swarmId = str(args.swarmId, 80);
      if (!SWARM_ID_RE.test(swarmId)) throw new Refusal('swarmId must be a swarm-… id', 'INVALID');
      const reason = str(args.reason) || 'Stopped from the dashboard Control Room';
      needConfirm(args, 'stop_swarm');
      const done = await deps.stopSwarm(tenantId, swarmId, { stoppedBy: `${operator} (dashboard)`, reason });
      if (!done) throw new Refusal(`swarm not found: ${swarmId}`, 'NOT_FOUND');
      return { target: swarmId, result: { stopped: true, swarmId, paused: done.paused, mailed: done.mailed }, detail: { reason } };
    }
  }
}

/**
 * Validate, act, audit. Never throws: refusals and store errors come back as
 * `{ok:false, code}` (and are audited) so the page can say why.
 */
export async function runSwarmAction(
  tenantId: string,
  args: Record<string, unknown>,
  actor: AuditActor,
  deps: SwarmActionDeps = realDeps(),
): Promise<SwarmActionResult> {
  const verb = str(args.verb, 40);
  const operator = str(args.operator, 80) || 'operator';
  if (!(SWARM_ACTION_VERBS as readonly string[]).includes(verb)) {
    const error = `verb must be one of ${SWARM_ACTION_VERBS.join(', ')}`;
    deps.audit({ tenantId, actor, action: 'swarm.action', detail: { verb, operator, outcome: 'invalid', error } });
    return { ok: false, verb, error, code: 'INVALID' };
  }
  const v = verb as SwarmActionVerb;
  try {
    const { target, result, detail } = await run(tenantId, v, args, operator, deps);
    deps.audit({ tenantId, actor, action: 'swarm.action', target, detail: { verb: v, operator, outcome: 'done', ...detail } });
    return { ok: true, verb: v, target, result };
  } catch (err) {
    const code = err instanceof Refusal ? err.code : 'FAILED';
    const error = err instanceof Error ? err.message : String(err);
    const target = str(args.key ?? args.to ?? args.messageId ?? args.swarmId, 400) || undefined;
    deps.audit({ tenantId, actor, action: 'swarm.action', target, detail: { verb: v, operator, outcome: code.toLowerCase(), error } });
    return { ok: false, verb: v, target, error, code };
  }
}
