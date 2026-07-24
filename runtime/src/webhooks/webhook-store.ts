/**
 * Outbound-webhook persistence — endpoint CRUD + the at-least-once delivery
 * queue. All reads/writes are tenant-scoped (ADR-010) through the scoped-query
 * helpers so a leaked id from another tenant matches nothing.
 *
 * Endpoints hold the destination + signing secret + subscription list.
 * Deliveries are the durable delivery-attempt records the retry worker drives
 * (webhook-dispatcher.ts): claim due rows, POST, reschedule or dead-letter.
 *
 * OUTBOUND_WEBHOOKS plan, Phase 2 (storage).
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { WebhookEndpointModel, WebhookDeliveryModel, isConnected } from '../shared/db.js';
import type { IWebhookEndpoint, IWebhookDelivery, WebhookDeliveryStatus } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import {
  scopedFind,
  scopedFindOne,
  scopedFindOneAndUpdate,
  scopedDeleteOne,
} from '../shared/scoped-query.js';
import { normalizeEventSubscription, DEFAULT_MAX_ATTEMPTS } from './outbound-events.js';

const log = createChildLogger({ module: 'webhook-store' });

/** Guard: every store call requires a live DB connection. */
function requireDb(): void {
  if (!isConnected()) throw new Error('database not connected');
}

// ── Public views ────────────────────────────────────────────────────

/** Endpoint as returned to the API — the secret is redacted except on create. */
export interface WebhookEndpointView {
  endpointId: string;
  url: string;
  events: string[];
  active: boolean;
  description?: string;
  lastStatus?: string;
  lastDeliveryAt?: string;
  createdAt: string;
  /** Present ONLY in the create response — the plaintext signing secret. */
  secret?: string;
}

export interface WebhookDeliveryView {
  deliveryId: string;
  endpointId: string;
  url: string;
  event: string;
  status: WebhookDeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  lastError?: string;
  lastStatusCode?: number;
  deliveredAt?: string;
  createdAt: string;
}

function toEndpointView(doc: IWebhookEndpoint, withSecret = false): WebhookEndpointView {
  return {
    endpointId: doc.endpointId,
    url: doc.url,
    events: doc.events,
    active: doc.active,
    description: doc.description,
    lastStatus: doc.lastStatus,
    lastDeliveryAt: doc.lastDeliveryAt?.toISOString(),
    createdAt: doc.createdAt.toISOString(),
    ...(withSecret ? { secret: doc.secret } : {}),
  };
}

function toDeliveryView(doc: IWebhookDelivery): WebhookDeliveryView {
  return {
    deliveryId: doc.deliveryId,
    endpointId: doc.endpointId,
    url: doc.url,
    event: doc.event,
    status: doc.status,
    attempts: doc.attempts,
    maxAttempts: doc.maxAttempts,
    nextAttemptAt: doc.nextAttemptAt.toISOString(),
    lastError: doc.lastError,
    lastStatusCode: doc.lastStatusCode,
    deliveredAt: doc.deliveredAt?.toISOString(),
    createdAt: doc.createdAt.toISOString(),
  };
}

// ── Endpoint CRUD ────────────────────────────────────────────────────

export interface CreateEndpointInput {
  url: string;
  events?: unknown;
  description?: string;
}

/** Generate a fresh signing secret. Displayed once (on create) — never again. */
export function generateSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

/**
 * Validate a webhook URL: must parse and be http(s). Returns the normalized
 * href or throws. HTTPS is required in production; http is allowed only for
 * loopback (local dev / self-host on a private network).
 */
export function validateWebhookUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('url must be a valid absolute URL');
  }
  const isLoopback = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol === 'https:' || (u.protocol === 'http:' && isLoopback)) return u.href;
  throw new Error('url must be https (http allowed only for loopback)');
}

export async function createEndpoint(
  tenantId: string,
  input: CreateEndpointInput,
): Promise<WebhookEndpointView> {
  requireDb();
  const url = validateWebhookUrl(input.url);
  const events = normalizeEventSubscription(input.events);
  const doc = await WebhookEndpointModel.create({
    tenantId,
    endpointId: `wh_${randomUUID()}`,
    url,
    secret: generateSecret(),
    events,
    active: true,
    description: input.description,
  });
  log.info({ tenantId, endpointId: doc.endpointId, events }, 'webhook endpoint created');
  return toEndpointView(doc, /* withSecret */ true);
}

export async function listEndpoints(tenantId: string): Promise<WebhookEndpointView[]> {
  if (!isConnected()) return [];
  const docs = await scopedFind(WebhookEndpointModel, tenantId, {})
    .sort({ createdAt: -1 })
    .lean<IWebhookEndpoint[]>();
  return docs.map(d => toEndpointView(d));
}

export interface UpdateEndpointInput {
  url?: string;
  events?: unknown;
  active?: boolean;
  description?: string;
}

export async function updateEndpoint(
  tenantId: string,
  endpointId: string,
  input: UpdateEndpointInput,
): Promise<WebhookEndpointView | null> {
  requireDb();
  const set: Record<string, unknown> = {};
  if (input.url !== undefined) set.url = validateWebhookUrl(input.url);
  if (input.events !== undefined) set.events = normalizeEventSubscription(input.events);
  if (typeof input.active === 'boolean') set.active = input.active;
  if (input.description !== undefined) set.description = input.description;
  if (Object.keys(set).length === 0) {
    const existing = await scopedFindOne(WebhookEndpointModel, tenantId, { endpointId }).lean<IWebhookEndpoint>();
    return existing ? toEndpointView(existing) : null;
  }
  const doc = await scopedFindOneAndUpdate(
    WebhookEndpointModel,
    tenantId,
    { endpointId },
    { $set: set },
    { new: true },
  );
  return doc ? toEndpointView(doc as IWebhookEndpoint) : null;
}

export async function deleteEndpoint(tenantId: string, endpointId: string): Promise<boolean> {
  requireDb();
  const res = await scopedDeleteOne(WebhookEndpointModel, tenantId, { endpointId });
  return (res.deletedCount ?? 0) > 0;
}

/** Active endpoints for a tenant — the dispatcher's fan-out set. */
export async function activeEndpoints(tenantId: string): Promise<IWebhookEndpoint[]> {
  if (!isConnected()) return [];
  return scopedFind(WebhookEndpointModel, tenantId, { active: true }).lean<IWebhookEndpoint[]>();
}

// ── Delivery queue ───────────────────────────────────────────────────

export interface EnqueueDeliveryInput {
  endpointId: string;
  url: string;
  event: string;
  payload: Record<string, unknown>;
  maxAttempts?: number;
}

/** Enqueue a delivery, due immediately. Returns the deliveryId. */
export async function enqueueDelivery(
  tenantId: string,
  input: EnqueueDeliveryInput,
  now: Date = new Date(),
): Promise<string> {
  requireDb();
  const deliveryId = `whd_${randomUUID()}`;
  await WebhookDeliveryModel.create({
    tenantId,
    deliveryId,
    endpointId: input.endpointId,
    url: input.url,
    event: input.event,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: now,
  });
  return deliveryId;
}

/**
 * Atomically claim ONE due delivery for processing. Flips a due
 * pending/retrying row to 'delivering' so a second worker (or the next tick)
 * won't pick it up. Returns null when nothing is due. Cross-tenant by design —
 * the worker is a trusted system process draining the global queue.
 */
export async function claimDueDelivery(now: Date = new Date()): Promise<IWebhookDelivery | null> {
  requireDb();
  // tenant-ok: cross-tenant BY DESIGN — see doc comment above.
  const doc = await WebhookDeliveryModel.findOneAndUpdate(
    { status: { $in: ['pending', 'retrying'] }, nextAttemptAt: { $lte: now } },
    { $set: { status: 'delivering' }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, new: true },
  ).exec();
  return doc as IWebhookDelivery | null;
}

/** Mark a claimed delivery delivered (2xx). Also stamps the endpoint's ops view. */
export async function markDelivered(
  tenantId: string,
  deliveryId: string,
  statusCode: number,
  now: Date = new Date(),
): Promise<void> {
  requireDb();
  const d = await scopedFindOneAndUpdate(
    WebhookDeliveryModel,
    tenantId,
    { deliveryId },
    { $set: { status: 'delivered', lastStatusCode: statusCode, deliveredAt: now, lastError: undefined } },
    { new: true },
  );
  if (d) await stampEndpoint(tenantId, (d as IWebhookDelivery).endpointId, 'delivered', now);
}

/**
 * Record a failed attempt: reschedule with backoff ('retrying') or dead-letter
 * ('dead') once attempts are exhausted. `nextState` is computed by the pure
 * `nextFailureState` helper in the dispatcher and passed in here.
 */
export async function markFailedAttempt(
  tenantId: string,
  deliveryId: string,
  args: {
    next: { status: 'dead' } | { status: 'retrying'; delayMs: number };
    error: string;
    statusCode?: number;
    now?: Date;
  },
): Promise<void> {
  requireDb();
  const now = args.now ?? new Date();
  const set: Record<string, unknown> = {
    status: args.next.status,
    lastError: args.error.slice(0, 1000),
    lastStatusCode: args.statusCode,
  };
  if (args.next.status === 'retrying') {
    set.nextAttemptAt = new Date(now.getTime() + args.next.delayMs);
  }
  const d = await scopedFindOneAndUpdate(
    WebhookDeliveryModel,
    tenantId,
    { deliveryId },
    { $set: set },
    { new: true },
  );
  if (d && args.next.status === 'dead') {
    await stampEndpoint(tenantId, (d as IWebhookDelivery).endpointId, 'dead', now);
    log.warn({ tenantId, deliveryId, endpointId: (d as IWebhookDelivery).endpointId }, 'webhook delivery dead-lettered');
  } else if (d) {
    await stampEndpoint(tenantId, (d as IWebhookDelivery).endpointId, 'failed', now);
  }
}

async function stampEndpoint(
  tenantId: string,
  endpointId: string,
  status: 'delivered' | 'failed' | 'dead',
  now: Date,
): Promise<void> {
  await scopedFindOneAndUpdate(
    WebhookEndpointModel,
    tenantId,
    { endpointId },
    { $set: { lastStatus: status, lastDeliveryAt: now } },
  ).catch(err => log.debug({ err, endpointId }, 'endpoint stamp failed (non-fatal)'));
}

export interface ListDeliveriesFilter {
  endpointId?: string;
  status?: WebhookDeliveryStatus;
  limit?: number;
}

export async function listDeliveries(
  tenantId: string,
  filter: ListDeliveriesFilter = {},
): Promise<WebhookDeliveryView[]> {
  if (!isConnected()) return [];
  const q: Record<string, unknown> = {};
  if (filter.endpointId) q.endpointId = filter.endpointId;
  if (filter.status) q.status = filter.status;
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const docs = await scopedFind(WebhookDeliveryModel, tenantId, q)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean<IWebhookDelivery[]>();
  return docs.map(toDeliveryView);
}

/** Re-queue a dead (or any) delivery for another attempt chain. */
export async function replayDelivery(
  tenantId: string,
  deliveryId: string,
  now: Date = new Date(),
): Promise<boolean> {
  requireDb();
  const doc = await scopedFindOneAndUpdate(
    WebhookDeliveryModel,
    tenantId,
    { deliveryId },
    { $set: { status: 'pending', attempts: 0, nextAttemptAt: now, lastError: undefined } },
    { new: true },
  );
  return !!doc;
}
