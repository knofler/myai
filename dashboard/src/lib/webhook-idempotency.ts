// Stripe webhook event idempotency + processed-event ledger (ADR-010 billing
// follow-up). Stripe redelivers an event on any non-2xx response or timeout,
// and delivery order across events isn't guaranteed. Two independent guards,
// both keyed off a durable per-event ledger row (persisted by the caller via
// `ProcessedEventStore` — the webhook route wires a Mongo-backed one; tests
// inject an in-memory fake):
//   1. Exact redelivery — the same `event.id` seen twice → short-circuit as
//      `duplicate`, bump the replay counter (the audit row), never re-apply.
//   2. Out-of-order — a structurally new event whose Stripe `created`
//      timestamp is OLDER than the last APPLIED event for the same logical
//      object (subscription/customer, spanning event TYPES — a
//      `checkout.session.completed`, `customer.subscription.updated`, and
//      `invoice.paid` for the same subscription all share one object id) →
//      short-circuit as `stale`, don't regress state a newer event already set.
//
// Same discipline as dunning.ts / overage.ts: PURE decision core (unit-tested
// with no DB), the Mongo-backed store is thin I/O wiring excluded from unit
// tests (mirrors the "webhook wiring... is integration surface" note there).

import { StripeEvent } from './db';

export interface ProcessedEventRecord {
  eventId: string;
  type: string;
  objectId: string;
  /** Unix seconds — Stripe event.created. */
  eventCreatedAt: number;
  /** Set once the caller's mutation for this event has actually landed. */
  appliedAt: number | null;
  replayCount: number;
}

export interface ProcessedEventStore {
  /** Atomically insert a new ledger row for this event id. Returns null when
   *  one already exists (exact redelivery). */
  claim(entry: {
    eventId: string;
    type: string;
    objectId: string;
    eventCreatedAt: number;
  }): Promise<ProcessedEventRecord | null>;
  /** Bump the replay counter on an existing (duplicate) event — the audit
   *  trail row for a re-delivery. */
  recordReplay(eventId: string): Promise<void>;
  /** The most recently APPLIED record for this object, excluding this event
   *  itself. Null when no prior event has been applied for the object. */
  latestApplied(objectId: string, excludeEventId: string): Promise<ProcessedEventRecord | null>;
  /** Mark a claimed record as applied — the caller's mutation landed. */
  markApplied(eventId: string): Promise<void>;
}

export type WebhookIdempotencyResult =
  | { action: 'apply'; record: ProcessedEventRecord }
  | { action: 'duplicate' }
  | { action: 'stale'; record: ProcessedEventRecord };

/**
 * Resolve the logical entity a Stripe billing event is about, so the
 * out-of-order guard compares events for the SAME subscription/customer even
 * across different event types. Subscription id wins (present on
 * `checkout.session.completed` via `subscription`, on `customer.subscription.*`
 * via `id`, and on subscription invoices via `subscription`); falls back to
 * the object's own id, then the customer id. PURE.
 */
export function resolveWebhookObjectId(obj: { id?: string; subscription?: string; customer?: string }): string {
  return obj.subscription || obj.id || obj.customer || 'unknown';
}

/**
 * The full check-and-claim cycle for an inbound webhook event. PURE aside
 * from the injected store's I/O — no Stripe/Mongo specifics leak in here.
 *
 * On `apply`, the caller MUST invoke `store.markApplied(event.id)` AFTER the
 * mutation is durably persisted (not before) — marking-applied-then-crashing
 * would let a genuinely unapplied event silently win the out-of-order race
 * against a later, correctly-ordered one.
 */
export async function checkWebhookIdempotency(
  store: ProcessedEventStore,
  event: { id: string; type: string; objectId: string; createdAt: number },
): Promise<WebhookIdempotencyResult> {
  const claimed = await store.claim({
    eventId: event.id,
    type: event.type,
    objectId: event.objectId,
    eventCreatedAt: event.createdAt,
  });
  if (!claimed) {
    await store.recordReplay(event.id);
    return { action: 'duplicate' };
  }

  const latest = await store.latestApplied(event.objectId, event.id);
  if (latest && event.createdAt < latest.eventCreatedAt) {
    return { action: 'stale', record: claimed };
  }
  return { action: 'apply', record: claimed };
}

// ── Mongo-backed store (integration wiring — excluded from unit tests) ─────

function isDuplicateKeyError(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: number }).code === 11000);
}

interface StripeEventDoc {
  eventId: string;
  type: string;
  objectId: string;
  eventCreatedAt: number;
  appliedAt?: Date | null;
  replayCount?: number;
}

function toRecord(doc: StripeEventDoc): ProcessedEventRecord {
  return {
    eventId: doc.eventId,
    type: doc.type,
    objectId: doc.objectId,
    eventCreatedAt: doc.eventCreatedAt,
    appliedAt: doc.appliedAt ? doc.appliedAt.getTime() : null,
    replayCount: doc.replayCount ?? 0,
  };
}

/** The webhook route's production store — one row per Stripe event id in the
 *  `stripeevents` collection (unique index on `eventId` is the atomic dedup
 *  primitive; a duplicate insert throws E11000). */
export function createMongoProcessedEventStore(): ProcessedEventStore {
  return {
    async claim({ eventId, type, objectId, eventCreatedAt }) {
      try {
        const doc = await StripeEvent.create({ eventId, type, objectId, eventCreatedAt });
        return toRecord(doc as unknown as StripeEventDoc);
      } catch (err) {
        if (isDuplicateKeyError(err)) return null;
        throw err;
      }
    },
    async recordReplay(eventId) {
      await StripeEvent.updateOne(
        { eventId },
        { $inc: { replayCount: 1 }, $set: { lastReplayAt: new Date() } },
      ).exec();
    },
    async latestApplied(objectId, excludeEventId) {
      const doc = await StripeEvent.findOne({
        objectId,
        eventId: { $ne: excludeEventId },
        appliedAt: { $ne: null },
      })
        .sort({ eventCreatedAt: -1 })
        .exec();
      return doc ? toRecord(doc as unknown as StripeEventDoc) : null;
    },
    async markApplied(eventId) {
      await StripeEvent.updateOne({ eventId }, { $set: { appliedAt: new Date() } }).exec();
    },
  };
}
