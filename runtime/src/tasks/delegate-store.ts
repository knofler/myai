/**
 * Agent dispatch layer (AGENT_MESSAGING_DISPATCH, phase 1).
 *
 * The director (phone-reachable) should only converse + delegate; workers
 * (runner sessions, Codex CLI, Antigravity CLI, local Ollama) do
 * the work. This module is the DISPATCH verb plus the two halves of "workers
 * act on mail": converting inbound `kind:'request'` mail into a claimed task,
 * and replying `kind:'result'` once that task is done — so one agent can ask
 * another for help ("runner → local: summarise these logs") without the
 * director polling anything.
 *
 * Builds entirely on P1 (mailbox-store) + P2 (swarm-store/task-store) — no new
 * collection. `sendMail`'s existing additive emit to the notifications event
 * bus (→ SSE → web-push) is what gets a result back to the director's phone;
 * this module does not duplicate that pipeline, it just sends good mail.
 */
import { sendMail, inboxFor, claimMail, normalizeAddress } from '../notifications/mailbox-store.js';
import type { MailboxMessageView } from '../notifications/mailbox-store.js';
import { createTask, claimTask } from './task-store.js';
import type { TaskView } from './task-store.js';
import type { TaskPriority } from '../shared/db.js';
import { planSwarm } from './swarm-store.js';
import type { PlanSwarmInput, SwarmWithChildren } from './swarm-store.js';
import { createChildLogger } from '../shared/logger.js';
import { resolveDirectorLanes, isDirectorAddressFor } from '../swarm/roles.js';

const log = createChildLogger({ module: 'delegate-store' });

/** Director addresses (AGENT_MESSAGING_DISPATCH guardrail): a director session
 *  converses + delegates and must NEVER auto-claim work off its own mailbox —
 *  only a worker's poll is allowed to turn mail into a task. Which LANES are
 *  directors is data, not a hard-coded name (v1 G6): resolveDirectorLanes()
 *  reads the live swarm-coordinator lease, then MYAI_DIRECTOR_LANES, then
 *  `default` (swarm/roles.ts). The `director` role always counts. */
export function isDirectorAddress(address: string, directorLanes: readonly string[]): boolean {
  return isDirectorAddressFor(normalizeAddress(address), directorLanes);
}

/** A single child, for the explicit multi-step (swarm) delegation path. */
export interface DelegateChildInput {
  title: string;
  description?: string;
  assignedAgent?: string;
  recommendedModel?: string;
  priority?: TaskPriority;
  dependsOnIndexes?: number[];
}

export interface DelegateInput {
  /** The director's own address — where result/failure mail comes back to. */
  from: string;
  /** What the work is. Becomes the task title / swarm goal / mail subject. */
  work: string;
  description?: string;
  repo?: string;
  /** Explicit routing. 'auto' (default) picks swarm vs task vs mail by size. */
  mode?: 'auto' | 'swarm' | 'task' | 'mail';
  /** For mode:'task'|'mail' (or auto picking one of those): who receives it —
   *  a host, host/repo, repo, or role address (same convention as mail_send). */
  to?: string;
  assignedAgent?: string;
  recommendedModel?: string;
  priority?: TaskPriority;
  /** For mode:'swarm' (or auto picking swarm because >1 child is given). */
  children?: DelegateChildInput[];
  childCap?: number;
  consent?: boolean;
}

export type DelegateHandle =
  | { mode: 'swarm'; swarmId: string; repo: string; childCount: number; result: SwarmWithChildren }
  | { mode: 'task'; taskId: string; repo: string; to?: string; result: TaskView }
  | { mode: 'mail'; messageId: string; to: string; result: MailboxMessageView };

export class DelegateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DelegateError';
  }
}

/** Mail linkage marker stashed in a task's `notes` so completeMailTask (below)
 *  and claimMailAsTask (below) can find their way back to the requester
 *  without a new DB field — mirrors swarm-store stamping `notes: "swarm …"`. */
const MAIL_LINK_RE = /\bmail:(mail-[a-zA-Z0-9-]+)\s+replyTo:(\S+)/;

function mailLinkNote(messageId: string, replyTo: string): string {
  return `mail:${messageId} replyTo:${replyTo}`;
}

/**
 * The DISPATCH verb: one call, the director hands off work and gets a handle
 * back immediately (never blocks on the work itself). Routing:
 *   - `children` with >1 entries (or mode:'swarm')      -> swarm_plan (paused, needs approval — unchanged guardrail)
 *   - mode:'mail', or mode:'auto' with a `to` and no repo -> a durable request mail (fire-and-forget ask)
 *   - everything else                                    -> a single claimable task, addressed to `to`/assignedAgent
 */
export async function delegateWork(tenantId: string, input: DelegateInput): Promise<DelegateHandle> {
  const from = normalizeAddress(input.from);
  if (!from) throw new DelegateError('from is required');
  if (!input.work || !input.work.trim()) throw new DelegateError('work is required');

  const mode = resolveMode(input);

  if (mode === 'swarm') {
    if (!input.repo) throw new DelegateError('repo is required for a swarm delegation');
    const children = (input.children && input.children.length ? input.children : [{ title: input.work }]);
    const planInput: PlanSwarmInput = {
      repo: input.repo,
      goal: input.work.trim(),
      createdBy: from,
      children,
      childCap: input.childCap,
      consent: input.consent,
      notes: `delegated by ${from}`,
    };
    const result = await planSwarm(tenantId, planInput);
    log.info({ swarmId: result.swarm.swarmId, from, children: result.children.length }, 'Delegated as swarm');
    return { mode: 'swarm', swarmId: result.swarm.swarmId, repo: input.repo, childCount: result.children.length, result };
  }

  if (mode === 'mail') {
    if (!input.to) throw new DelegateError('to is required for a mail delegation');
    const to = normalizeAddress(input.to);
    const result = await sendMail(tenantId, {
      to,
      from,
      kind: 'request',
      subject: input.work.trim(),
      body: input.description ?? '',
      replyTo: from,
    });
    log.info({ messageId: result.messageId, from, to }, 'Delegated as mail');
    return { mode: 'mail', messageId: result.messageId, to, result };
  }

  // mode === 'task'
  if (!input.repo) throw new DelegateError('repo is required for a task delegation');
  const to = input.to ? normalizeAddress(input.to) : undefined;
  const task = await createTask(tenantId, {
    repo: input.repo,
    title: input.work.trim(),
    description: input.description,
    priority: input.priority,
    assignedAgent: input.assignedAgent ?? input.to,
    recommendedModel: input.recommendedModel,
    source: 'manual',
    notes: `delegated by ${from}${to ? ` to ${to}` : ''}`,
  });
  log.info({ taskId: task.taskId, from, to }, 'Delegated as task');
  return { mode: 'task', taskId: task.taskId, repo: input.repo, to, result: task };
}

function resolveMode(input: DelegateInput): 'swarm' | 'task' | 'mail' {
  if (input.mode && input.mode !== 'auto') return input.mode;
  if (input.children && input.children.length > 1) return 'swarm';
  if (input.to && !input.repo) return 'mail';
  return 'task';
}

// ── Workers acting on mail ──────────────────────────────────────────────

export interface ClaimMailAsTaskOptions {
  /** Default repo for a converted task when the mail doesn't name one. */
  defaultRepo: string;
  /** Who is claiming (holder identity, e.g. "host-a/codex" or a runner holder). */
  claimedBy: string;
  /** Max mail converted in one poll (flood/loop guardrail). Default 5. */
  maxPerPoll?: number;
}

export interface ClaimedMailTask {
  messageId: string;
  taskId: string;
  from: string;
  replyTo: string;
  subject: string;
}

const DEFAULT_MAX_PER_POLL = 5;

/**
 * Poll one worker address's inbox and turn actionable mail (`kind:'request'`)
 * into tasks already claimed by this worker — "fire and idle sessions poll
 * their inbox, turn actionable mail into claimed tasks" (AGENT_MESSAGING_DISPATCH
 * phase 1). Guardrails:
 *   - REFUSED for a director address (a director never auto-claims its own mail).
 *   - kind must be exactly 'request' — a 'result' or 'live-note' is never
 *     re-dispatched, which is what keeps two agents from ping-ponging forever.
 *   - from === to (a self-addressed message) is skipped, not converted.
 *   - capped at maxPerPoll per call — flood protection against a runaway sender.
 *   - the mailbox claim (claimMail) is atomic, so a concurrent poller (another
 *     idle session answering the same address) can never double-claim the
 *     same message into two tasks.
 */
export async function claimMailAsTask(tenantId: string, address: string, opts: ClaimMailAsTaskOptions): Promise<ClaimedMailTask[]> {
  const to = normalizeAddress(address);
  const { lanes: directorLanes } = await resolveDirectorLanes(tenantId);
  if (isDirectorAddress(to, directorLanes)) {
    throw new DelegateError(`${to} is a director address — directors delegate, they do not auto-claim mail`);
  }
  const cap = Math.max(1, Math.min(opts.maxPerPoll ?? DEFAULT_MAX_PER_POLL, 20));

  const { messages } = await inboxFor(tenantId, { to, includeAcked: false, limit: cap * 4 });
  const actionable = messages.filter((m) => m.kind === 'request' && normalizeAddress(m.from) !== to).slice(0, cap);

  const claimed: ClaimedMailTask[] = [];
  for (const mail of actionable) {
    const won = await claimMail(tenantId, mail.messageId, opts.claimedBy);
    if (!won) continue; // another poller won the race — not an error

    const replyTo = normalizeAddress(mail.replyTo || mail.from);
    const repo = opts.defaultRepo;
    const created = await createTask(tenantId, {
      repo,
      title: mail.subject,
      description: mail.body,
      source: 'manual',
      assignedAgent: to,
      notes: mailLinkNote(mail.messageId, replyTo),
    });
    const inWork = await claimTask(tenantId, { claimedBy: opts.claimedBy, taskId: created.taskId }) ?? created;
    claimed.push({ messageId: mail.messageId, taskId: inWork.taskId, from: mail.from, replyTo, subject: mail.subject });
    log.info({ messageId: mail.messageId, taskId: inWork.taskId, to, replyTo }, 'Mail claimed as task');
  }
  return claimed;
}

export interface CompleteMailTaskInput {
  taskId: string;
  /** Mail-linked task's outcome. */
  outcome: 'done' | 'failed';
  summary: string;
  /** Links the requester cares about (PR, commit, log). */
  links?: string[];
  /** The worker's own address (the `from` on the result mail). */
  from: string;
}

/**
 * Reply to a mail-derived task's originating requester with `kind:'result'` —
 * "agents can ask each other for help ... and reply with outcome + links".
 * Reads the `mail:<id> replyTo:<addr>` linkage this module stamps into the
 * task's notes at claim time (see claimMailAsTask); a task with no such
 * linkage (ordinary task, not mail-derived) is a no-op (returns null), so
 * callers can call this unconditionally at task close without checking first.
 * The result mail's `sendMail` call is what reaches the director's phone —
 * mailbox-store's existing additive `message.received` event already fans out
 * to the push pipeline, so no separate notification call is needed here.
 */
export async function completeMailTask(tenantId: string, input: CompleteMailTaskInput, taskNotes: string | undefined): Promise<MailboxMessageView | null> {
  if (!taskNotes) return null;
  const match = MAIL_LINK_RE.exec(taskNotes);
  if (!match) return null;
  const [, originMessageId, replyTo] = match;

  const linksText = input.links && input.links.length ? `\n\nLinks:\n${input.links.map((l) => `- ${l}`).join('\n')}` : '';
  const result = await sendMail(tenantId, {
    to: replyTo,
    from: normalizeAddress(input.from),
    kind: 'result',
    subject: `${input.outcome === 'done' ? 'Done' : 'Failed'}: ${input.taskId}`,
    body: `${input.summary}${linksText}`,
    replyTo: originMessageId,
  });
  log.info({ taskId: input.taskId, to: replyTo, outcome: input.outcome }, 'Mail task result sent');
  return result;
}
