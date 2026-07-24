/**
 * Outbound-webhook pure helpers — signing, event derivation, subscription
 * matching, and retry backoff. NO I/O and NO DB here so every rule is unit-
 * testable in isolation (see tests/unit/webhooks.test.ts).
 *
 * A tenant registers webhook endpoints (url + shared secret + a list of event
 * names) via the REST surface. The dispatcher (webhooks/webhook-dispatcher.ts)
 * subscribes to the in-process notify bus, maps each activity event to zero or
 * more canonical webhook events, and — for every active endpoint subscribed to
 * a matching event — enqueues an HMAC-signed POST with at-least-once delivery
 * (retry + exponential backoff + dead-letter).
 *
 * OUTBOUND_WEBHOOKS plan, Phase 1 (pure core).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { NotifyEvent } from '../notifications/event-bus.js';

/**
 * The canonical outbound webhook event names a tenant can subscribe to. These
 * are the stable public contract (Zapier/n8n/Slack triggers) — deliberately
 * decoupled from the internal notify-bus `type` strings so we can change the
 * bus without breaking a customer's subscription.
 */
export const WEBHOOK_EVENTS = [
  'task.claimed',   // a runner/agent picked up a pending task (pending → working)
  'task.review',    // a task moved into review
  'task.blocked',   // a task became blocked
  'task.completed', // a task finished (done)
  'task.created',   // a new task was queued
  'plan.updated',   // a repo's plan changed
  'runner.fired',   // a runner claimed a slot and started working
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const WEBHOOK_EVENT_SET = new Set<string>(WEBHOOK_EVENTS);

/** True if `name` is a known canonical webhook event. */
export function isWebhookEvent(name: string): name is WebhookEvent {
  return WEBHOOK_EVENT_SET.has(name);
}

/**
 * Normalise + validate a caller-supplied subscription list. `["*"]` (or an
 * empty list) means "all events". Unknown names are rejected so a typo can't
 * silently subscribe to nothing. Returns the de-duped, ordered list or throws.
 */
export function normalizeEventSubscription(raw: unknown): string[] {
  if (raw === undefined || raw === null) return ['*'];
  if (!Array.isArray(raw)) throw new Error('events must be an array of event names or ["*"]');
  const cleaned = raw.map(e => String(e).trim()).filter(Boolean);
  if (cleaned.length === 0 || cleaned.includes('*')) return ['*'];
  const unknown = cleaned.filter(e => !isWebhookEvent(e));
  if (unknown.length) {
    throw new Error(
      `unknown event(s): ${unknown.join(', ')}. Valid: ${WEBHOOK_EVENTS.join(', ')} or ["*"]`,
    );
  }
  return [...new Set(cleaned)];
}

/**
 * Does an endpoint subscribed to `subscribed` want `event`? `["*"]` matches
 * everything; otherwise an exact name match.
 */
export function eventMatches(subscribed: readonly string[], event: string): boolean {
  return subscribed.includes('*') || subscribed.includes(event);
}

/**
 * Map an internal notify-bus event to the canonical webhook event(s) it should
 * fire. Most bus events map 1:1, but `task.updated` fans out to the semantic
 * claimed/review/blocked/completed events based on the status transition in
 * `data` — that's the granularity the public contract promises. Returns an
 * empty array for bus events with no public webhook (they're simply ignored).
 */
export function deriveWebhookEvents(notify: Pick<NotifyEvent, 'type' | 'data'>): WebhookEvent[] {
  const data = (notify.data ?? {}) as Record<string, unknown>;
  const status = typeof data.status === 'string' ? data.status : undefined;
  const prevStatus = typeof data.prevStatus === 'string' ? data.prevStatus : undefined;

  switch (notify.type) {
    case 'task.created':
      return ['task.created'];
    case 'task.completed':
      return ['task.completed'];
    case 'plan.updated':
      return ['plan.updated'];
    case 'runner.fired':
      return ['runner.fired'];
    case 'task.updated': {
      // A claim: pending → working (the claim path stamps claimedBy).
      if (data.claimedBy || (prevStatus === 'pending' && status === 'working')) {
        return ['task.claimed'];
      }
      if (status === 'review') return ['task.review'];
      if (status === 'blocked') return ['task.blocked'];
      if (status === 'done') return ['task.completed'];
      return [];
    }
    default:
      return [];
  }
}

// ── HMAC signing ────────────────────────────────────────────────────

/** Header name carrying the timestamped HMAC signature. */
export const SIGNATURE_HEADER = 'X-Myai-Signature';
/** Header carrying the canonical event name. */
export const EVENT_HEADER = 'X-Myai-Event';
/** Header carrying the unique delivery id (idempotency key for the receiver). */
export const DELIVERY_HEADER = 'X-Myai-Delivery';

/**
 * Compute the signature value for a payload. Stripe-style scheme: the signed
 * string is `${timestamp}.${body}`, HMAC-SHA256 with the endpoint secret, and
 * the header value embeds the timestamp so the receiver can reject stale
 * deliveries: `t=<unix-seconds>,v1=<hex>`.
 */
export function signPayload(secret: string, body: string, timestampSec: number): string {
  const mac = createHmac('sha256', secret).update(`${timestampSec}.${body}`).digest('hex');
  return `t=${timestampSec},v1=${mac}`;
}

/**
 * Verify a signature header against the body + secret (constant-time). Exported
 * so receivers/tests share the exact scheme. `toleranceSec` (default 5 min)
 * bounds replay; pass 0 to skip the freshness check.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  nowSec: number,
  toleranceSec = 300,
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map(kv => {
      const [k, v] = kv.split('=');
      return [k?.trim(), v?.trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || typeof v1 !== 'string' || !v1) return false;
  if (toleranceSec > 0 && Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(v1, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Retry backoff ───────────────────────────────────────────────────

/** Default number of delivery attempts before a delivery is dead-lettered. */
export const DEFAULT_MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 5_000;      // first retry ~5s after the initial failure
const MAX_DELAY_MS = 3_600_000;   // cap backoff at 1h

/**
 * Exponential backoff for the delay before attempt N (1-indexed: the delay
 * *after* the Nth failed attempt, before attempt N+1). Deterministic (no
 * jitter) so the schedule is exactly assertable in tests: 5s, 10s, 20s, 40s,
 * … capped at 1h.
 */
export function backoffMs(attempt: number): number {
  const exp = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(MAX_DELAY_MS, exp);
}

/** HTTP status → treat as delivered? Any 2xx is a success. */
export function isDeliverySuccess(statusCode: number): boolean {
  return statusCode >= 200 && statusCode < 300;
}

/**
 * Given the attempt count just made and the endpoint's max, decide the next
 * delivery state after a FAILED attempt: 'dead' once attempts exhausted,
 * otherwise 'retrying' with the computed next-attempt delay.
 */
export function nextFailureState(
  attemptsMade: number,
  maxAttempts: number,
): { status: 'dead' } | { status: 'retrying'; delayMs: number } {
  if (attemptsMade >= maxAttempts) return { status: 'dead' };
  return { status: 'retrying', delayMs: backoffMs(attemptsMade) };
}
