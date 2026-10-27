/**
 * Durable mailbox store (SWARM_MESSAGING plan, P1).
 *
 * The messaging layer's DURABLE, ADDRESSED, ACKED path — the one that never
 * loses anything when the recipient is asleep. Live SendMessage/SSE stays the
 * fast path when both ends are online; this is where a message to an offline
 * Mac (or a repo/role that isn't running right now) waits until it wakes.
 *
 * ADDITIVE to the realtime notifications event-bus, NOT a fork (guardrail §3 /
 * P0 §5.1): {@link sendMail} persists the message here AND emits a
 * `message.received` event onto {@link notifyBus}, so an open dashboard still
 * gets the live toast + a history row through the exact same pipeline every
 * other activity event uses (notifications/service.ts). Nothing about the
 * event-bus changes; the mailbox is a new sink that also emits.
 *
 * Addresses are free strings resolved by CONVENTION, not a registry:
 *   host          e.g. "host-a"                  — a whole Mac
 *   host/repo     e.g. "host-a/my-repo"          — one repo's session on a Mac
 *   repo          e.g. "ai_management"           — any session working a repo
 *   role          e.g. "reviewer"                — whoever plays a role
 * They are lowercase-normalised at write AND read so a hostname's casing can
 * never strand a message ("HOST-A" ↔ "host-a").
 */
import { randomUUID } from 'node:crypto';
import { MailboxMessageModel, isConnected } from '../shared/db.js';
import type { IMailboxMessage } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import {
  scopedFind, scopedFindOne, scopedFindOneAndUpdate, scopedCountDocuments, tenantScope,
} from '../shared/scoped-query.js';
import { emitNotifyEvent } from './event-bus.js';

const log = createChildLogger({ module: 'mailbox-store' });

/** Default page size for an inbox read — plenty for a session-start banner. */
export const DEFAULT_INBOX_LIMIT = 50;
const MAX_INBOX_LIMIT = 200;
const MAX_SUBJECT_CHARS = 300;
const MAX_BODY_CHARS = 8000;

export interface SendMailInput {
  to: string;
  from: string;
  kind?: string;
  subject: string;
  body?: string;
  replyTo?: string;
  swarmId?: string;
}

export interface InboxInput {
  /** One address, or the set of addresses this caller answers to. */
  to: string | string[];
  /** Include already-acked mail too (default false → unread only). */
  includeAcked?: boolean;
  limit?: number;
}

export interface AckMailInput {
  messageId: string;
  /** Who acked it, for the audit trail (optional). */
  ackedBy?: string;
}

export interface MailboxMessageView {
  messageId: string;
  to: string;
  from: string;
  kind: string;
  subject: string;
  body: string;
  replyTo?: string;
  swarmId?: string;
  acked: boolean;
  ackedAt?: Date;
  ackedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

function requireDb(): void {
  if (!isConnected() || !MailboxMessageModel) {
    throw new Error('MongoDB not connected — mailbox unavailable');
  }
}

/** Normalise an address for storage + matching: trim + lowercase, never empty. */
export function normalizeAddress(addr: unknown): string {
  if (typeof addr !== 'string') return '';
  return addr.trim().toLowerCase();
}

function toView(doc: IMailboxMessage): MailboxMessageView {
  return {
    messageId: doc.messageId,
    to: doc.to,
    from: doc.from,
    kind: doc.kind,
    subject: doc.subject,
    body: doc.body,
    replyTo: doc.replyTo,
    swarmId: doc.swarmId,
    acked: doc.acked,
    ackedAt: doc.ackedAt,
    ackedBy: doc.ackedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Send one durable message. Persists it (unacked) and — additively — emits a
 * `message.received` event onto the notification bus so live listeners (SSE /
 * history) see it too. The emit is fire-and-forget and never fails the send.
 */
export async function sendMail(tenantId: string, input: SendMailInput): Promise<MailboxMessageView> {
  requireDb();
  const to = normalizeAddress(input.to);
  const from = normalizeAddress(input.from);
  const subject = typeof input.subject === 'string' ? input.subject.trim() : '';
  if (!to) throw new Error('to is required');
  if (!from) throw new Error('from is required');
  if (!subject) throw new Error('subject is required');

  const messageId = `mail-${randomUUID()}`;
  const doc = await MailboxMessageModel.create({
    ...tenantScope(tenantId),
    messageId,
    to,
    from,
    kind: (typeof input.kind === 'string' && input.kind.trim()) ? input.kind.trim() : 'note',
    subject: subject.slice(0, MAX_SUBJECT_CHARS),
    body: typeof input.body === 'string' ? input.body.slice(0, MAX_BODY_CHARS) : '',
    replyTo: input.replyTo,
    swarmId: input.swarmId,
    acked: false,
  });
  log.info({ messageId, to, from, kind: doc.kind, swarmId: doc.swarmId }, 'Mail sent');

  // ADDITIVE to the event-bus (guardrail §3): live listeners see the message
  // through the same pipeline as every other activity event. Never fails the
  // send — emitNotifyEvent is synchronous and swallows handler errors.
  emitNotifyEvent({
    type: 'message.received',
    tenantId,
    title: `Mail for ${to}: ${doc.subject}`,
    message: `from ${from}${doc.swarmId ? ` · swarm ${doc.swarmId}` : ''}`,
    level: 'info',
    source: 'mailbox-store',
    data: { messageId, to, from, kind: doc.kind, subject: doc.subject, swarmId: doc.swarmId, replyTo: doc.replyTo },
  });

  return toView(doc);
}

/**
 * Read the inbox for one or more addresses. Unread (unacked) only by default,
 * newest first. `to` accepts a single address or the full set of addresses the
 * caller answers to (host, host/repo, repo, role) so one call drains
 * everything addressed to this session.
 */
export async function inboxFor(tenantId: string, input: InboxInput): Promise<{ messages: MailboxMessageView[]; unreadCount: number }> {
  requireDb();
  const addresses = Array.from(new Set(
    (Array.isArray(input.to) ? input.to : [input.to]).map(normalizeAddress).filter(a => a.length > 0),
  ));
  if (addresses.length === 0) throw new Error('to is required');

  const limit = Math.min(Math.max(1, input.limit ?? DEFAULT_INBOX_LIMIT), MAX_INBOX_LIMIT);
  const filter: Record<string, unknown> = { to: { $in: addresses } };
  if (!input.includeAcked) filter.acked = false;

  const docs = await scopedFind(MailboxMessageModel, tenantId, filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .exec() as IMailboxMessage[];

  // Unread count is independent of includeAcked / limit — it's what the
  // session-start banner shows ("N unread"), so always count unacked.
  const unreadCount = await scopedCountDocuments(MailboxMessageModel, tenantId, { to: { $in: addresses }, acked: false });

  return { messages: docs.map(toView), unreadCount };
}

/**
 * Tenant-wide recent mail across EVERY address — the swarm_live mailbox strip
 * and hourly timeline (one operator's swarm is one tenant's mail). `since`
 * bounds the window (timeline = today); `unreadCount` is tenant-wide.
 */
export async function recentMail(
  tenantId: string,
  opts: { limit?: number; since?: Date } = {},
): Promise<{ messages: MailboxMessageView[]; unreadCount: number }> {
  requireDb();
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_INBOX_LIMIT), MAX_INBOX_LIMIT);
  const filter: Record<string, unknown> = opts.since ? { createdAt: { $gte: opts.since } } : {};
  const docs = await scopedFind(MailboxMessageModel, tenantId, filter)
    .sort({ createdAt: -1 })
    .limit(limit)
    .exec() as IMailboxMessage[];
  const unreadCount = await scopedCountDocuments(MailboxMessageModel, tenantId, { acked: false });
  return { messages: docs.map(toView), unreadCount };
}

/**
 * Acknowledge (mark read/handled) one message by id. Idempotent — acking an
 * already-acked message is a no-op that returns the current view. Returns null
 * if no message with that id exists for this tenant.
 */
export async function ackMail(tenantId: string, input: AckMailInput): Promise<MailboxMessageView | null> {
  requireDb();
  const messageId = typeof input.messageId === 'string' ? input.messageId.trim() : '';
  if (!messageId) throw new Error('messageId is required');

  const doc = await scopedFindOneAndUpdate(
    MailboxMessageModel, tenantId,
    { messageId },
    { $set: { acked: true, ackedAt: new Date(), ...(input.ackedBy ? { ackedBy: input.ackedBy } : {}) } },
    { new: true },
  ) as IMailboxMessage | null;
  if (!doc) return null;
  log.info({ messageId, to: doc.to }, 'Mail acked');
  return toView(doc);
}

/** Count unread (unacked) mail for an address set — the banner's headline number. */
export async function unreadCountFor(tenantId: string, to: string | string[]): Promise<number> {
  requireDb();
  const addresses = Array.from(new Set(
    (Array.isArray(to) ? to : [to]).map(normalizeAddress).filter(a => a.length > 0),
  ));
  if (addresses.length === 0) return 0;
  return await scopedCountDocuments(MailboxMessageModel, tenantId, { to: { $in: addresses }, acked: false });
}

/**
 * Atomically claim one unacked message for ACTION (not just reading) —
 * AGENT_MESSAGING_DISPATCH mail-to-task conversion. Unlike {@link ackMail}
 * (unconditional set, built for an operator clicking "handled"), this uses
 * `{messageId, acked: false}` as the update filter so when two pollers race
 * on the same fire (a runner fire and an idle tmux session both draining the
 * same address), only ONE wins and gets a non-null result — the other sees
 * acked:true already and gets null, exactly like claimTask's atomic
 * findOneAndUpdate. Callers that lose the race must not act twice.
 */
export async function claimMail(tenantId: string, messageId: string, claimedBy?: string): Promise<MailboxMessageView | null> {
  requireDb();
  const doc = await scopedFindOneAndUpdate(
    MailboxMessageModel, tenantId,
    { messageId, acked: false },
    { $set: { acked: true, ackedAt: new Date(), ...(claimedBy ? { ackedBy: claimedBy } : {}) } },
    { new: true },
  ) as IMailboxMessage | null;
  if (!doc) return null;
  log.info({ messageId, to: doc.to, claimedBy }, 'Mail claimed for action');
  return toView(doc);
}

/** Fetch one message by id (tenant-scoped), or null. */
export async function getMail(tenantId: string, messageId: string): Promise<MailboxMessageView | null> {
  requireDb();
  const doc = await scopedFindOne(MailboxMessageModel, tenantId, { messageId }).exec() as IMailboxMessage | null;
  return doc ? toView(doc) : null;
}
