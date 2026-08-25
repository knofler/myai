/**
 * dual-write-queue — ADR-031 §1/§3 inline dual-write dispatcher + retry-queue
 * enqueue/resolve helpers (the pure-logic + DB-access half; the background
 * drain loop is `dual-write-worker.ts`, a sibling follow-up).
 *
 * ADR-030 §3 step 2: every write for a `migrating`-status tenant must land in
 * BOTH the shared connection (still authoritative for reads) and the dedicated
 * connection. The shared write is authoritative — a dual-write failure must
 * never fail the caller's request or roll back the shared write. This module
 * owns what happens *after* the shared write has already succeeded.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ CRITICAL ORDERING (ADR-031 §1 step 1 + "Severity flags for implementers")│
 * │                                                                           │
 * │   dualWriteWithRetry() inserts the durable `DualWriteRetryItem` intent    │
 * │   record (status='pending') **BEFORE** it attempts the dedicated write —  │
 * │   unconditionally, NOT only in the failure branch.                        │
 * │                                                                           │
 * │   The single highest-risk defect this whole ADR exists to close is a      │
 * │   write that lands in shared with ZERO record anywhere that a shadow      │
 * │   copy is owed. Writing the intent record only on failure (the more       │
 * │   "obvious" way) reopens the exact crash-gap: a process death between     │
 * │   shared-write-success and the dedicated-write attempt would leave no     │
 * │   trace, and the retry queue cannot retry what it never recorded. Writing │
 * │   it first means the worst a crash can do is leave a `pending` item for a │
 * │   write that actually would have succeeded — the worker replays it        │
 * │   idempotently (§4) and resolves it. A wasted retry, never data loss.     │
 * │                                                                           │
 * │   The regression test that locks this ordering in is                      │
 * │   `tests/unit/dual-write-queue.test.ts` — do not reorder these steps.     │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import { randomUUID } from 'node:crypto';
import {
  DualWriteRetryItemModel,
  isConnected,
} from './db.js';
import type { DualWriteOperation, IDualWriteRetryItem } from './db.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'dual-write-queue' });

// ── Retry/backoff constants (ADR-031 §3) ───────────────────────────────────
// Same *shape* as webhooks/outbound-events.ts's deterministic no-jitter
// backoff, but tuned for data-loss risk (not delivery risk): far more
// persistent before dead-lettering.

/** Dead-letter threshold for background-worker attempts (ADR-031 §3). */
export const DEFAULT_MAX_ATTEMPTS = 20;
const BASE_DELAY_MS = 10_000; // first queued retry ~10s after the failure
const MAX_DELAY_MS = 1_800_000; // cap at 30 min

/** ADR-031 §1 step 2: inline fast-retries absorb a transient blip without
 *  queue overhead for the common case. These are NOT counted in
 *  `DualWriteRetryItem.attempts` (which counts only queued worker attempts). */
const INLINE_FAST_RETRIES = 2;
const INLINE_RETRY_DELAY_MS = 200;

/**
 * Deterministic exponential backoff (no jitter) for the delay before queued
 * worker attempt N — exactly assertable in tests: 10s, 20s, 40s, … capped at
 * 30 min. Persistent enough to ride out a dedicated-cluster maintenance
 * window, short enough that a genuinely broken `mongoUri` dead-letters
 * same-day rather than silently for the tenant's whole `migrating` window.
 */
export function dualWriteBackoffMs(attempt: number): number {
  const exp = BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  return Math.min(MAX_DELAY_MS, exp);
}

/**
 * Given the queued attempt count just made and the item's max, decide the next
 * state after a FAILED queued attempt: 'dead' once attempts are exhausted,
 * otherwise 'retrying' with the computed next-attempt delay. Mirrors
 * `webhooks/outbound-events.ts:nextFailureState`'s decision shape so the
 * (not-yet-built) drain worker reuses the proven pattern.
 */
export function nextDualWriteFailureState(
  attemptsMade: number,
  maxAttempts: number,
): { status: 'dead' } | { status: 'retrying'; delayMs: number } {
  if (attemptsMade >= maxAttempts) return { status: 'dead' };
  return { status: 'retrying', delayMs: dualWriteBackoffMs(attemptsMade) };
}

// ── DB-access helpers ───────────────────────────────────────────────────────

function requireDb(): void {
  if (!isConnected() || !DualWriteRetryItemModel) {
    throw new Error('MongoDB not connected — dual-write queue unavailable');
  }
}

export interface EnqueueDualWriteIntentInput {
  tenantId: string;
  collectionName: string;
  operation: DualWriteOperation;
  documentKey: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  now?: Date;
}

/**
 * Insert the durable "intent record" (status='pending') for a dual-write
 * shadow copy. This is ADR-031 §1 step 1 — it MUST run and be awaited before
 * the dedicated write is attempted. Returns the new item's `itemId`.
 */
export async function enqueueDualWriteIntent(input: EnqueueDualWriteIntentInput): Promise<string> {
  requireDb();
  const itemId = `dwr_${randomUUID()}`;
  await DualWriteRetryItemModel.create({
    tenantId: input.tenantId,
    itemId,
    collectionName: input.collectionName,
    operation: input.operation,
    documentKey: input.documentKey,
    payload: input.payload,
    status: 'pending',
    attempts: 0,
    maxAttempts: input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: input.now ?? new Date(),
  });
  return itemId;
}

/**
 * Resolve an intent record after the dedicated write succeeded. ADR-031 §4
 * prefers DELETE over mark-resolved-and-keep: a resolved dual-write item is a
 * purely transient reconciliation artifact with no further operational value.
 */
export async function resolveDualWriteIntent(tenantId: string, itemId: string): Promise<void> {
  requireDb();
  await DualWriteRetryItemModel.deleteOne({ tenantId, itemId });
}

// ── Claim-by-nextAttemptAt (ADR-031 §3 background worker) ──────────────────
// This is the DB-access half the background drain worker (`dual-write-worker.ts`,
// a sibling follow-up — see the module doc comment at the top of this file)
// polls against. Mirrors `webhooks/webhook-store.ts:claimDueDelivery`'s
// atomic findOneAndUpdate claim pattern exactly, so two worker ticks (or two
// worker processes) can never double-claim the same item.

/** A claimed retry-queue item, ready for the worker to replay (ADR-031 §4). */
export type ClaimedDualWriteItem = Pick<
  IDualWriteRetryItem,
  'tenantId' | 'itemId' | 'collectionName' | 'operation' | 'documentKey' | 'payload' | 'attempts' | 'maxAttempts'
>;

/**
 * Atomically claim ONE due retry-queue item for background processing. Flips
 * a due `pending`/`retrying` row to `retrying` and increments `attempts` so a
 * second poll tick (or a second worker process) won't pick it up again.
 * Returns `null` when nothing is due. Cross-tenant by design — the worker is
 * a trusted system process draining the global queue, same as the webhook
 * delivery worker.
 *
 * NOTE: per the ADR's resumability contract, the caller (the worker) is
 * responsible for skipping items whose tenant is not currently `migrating` —
 * that requires joining against `TenantDbBinding`, which is background-worker
 * policy, not this module's pure claim mechanics.
 */
export async function claimDueDualWriteItem(now: Date = new Date()): Promise<ClaimedDualWriteItem | null> {
  requireDb();
  const doc = await DualWriteRetryItemModel.findOneAndUpdate(
    { status: { $in: ['pending', 'retrying'] }, nextAttemptAt: { $lte: now } },
    { $set: { status: 'retrying' }, $inc: { attempts: 1 } },
    { sort: { nextAttemptAt: 1 }, new: true },
  );
  if (!doc) return null;
  return {
    tenantId: doc.tenantId,
    itemId: doc.itemId,
    collectionName: doc.collectionName,
    operation: doc.operation,
    documentKey: doc.documentKey,
    payload: doc.payload,
    attempts: doc.attempts,
    maxAttempts: doc.maxAttempts,
  };
}

/**
 * Record the outcome of a claimed item's replay attempt (ADR-031 §3):
 * success deletes the intent record via `resolveDualWriteIntent` (§4 prefers
 * delete over mark-and-keep — call that directly, no separate helper needed).
 * Failure reuses `nextDualWriteFailureState`'s decision shape to either
 * dead-letter the item or reschedule it with backoff.
 */
export async function markDualWriteAttemptFailed(
  tenantId: string,
  itemId: string,
  attemptsMade: number,
  maxAttempts: number,
  error: unknown,
  now: Date = new Date(),
): Promise<{ status: 'dead' } | { status: 'retrying'; nextAttemptAt: Date }> {
  requireDb();
  const msg = error instanceof Error ? error.message : String(error);
  const next = nextDualWriteFailureState(attemptsMade, maxAttempts);
  if (next.status === 'dead') {
    await DualWriteRetryItemModel.updateOne(
      { tenantId, itemId },
      { $set: { status: 'dead', lastError: msg.slice(0, 1000) } },
    );
    log.warn({ tenantId, itemId, attemptsMade, maxAttempts }, 'Dual-write retry item dead-lettered');
    return { status: 'dead' };
  }
  const nextAttemptAt = new Date(now.getTime() + next.delayMs);
  await DualWriteRetryItemModel.updateOne(
    { tenantId, itemId },
    { $set: { status: 'retrying', nextAttemptAt, lastError: msg.slice(0, 1000) } },
  );
  return { status: 'retrying', nextAttemptAt };
}

/** Stamp the last inline error on an intent record left `pending` for the
 *  worker. Non-fatal — the record staying `pending` is what matters. */
async function recordInlineFailure(tenantId: string, itemId: string, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  await DualWriteRetryItemModel.updateOne(
    { tenantId, itemId },
    { $set: { lastError: msg.slice(0, 1000) } },
  ).catch((e: unknown) => log.debug({ err: e, itemId }, 'inline-failure stamp failed (non-fatal)'));
}

// ── The inline dispatcher (ADR-031 §1) ──────────────────────────────────────

export interface DualWriteParams {
  tenantId: string;
  collectionName: string;
  operation: DualWriteOperation;
  documentKey: string;
  payload?: Record<string, unknown>;
  /**
   * Performs the write against the tenant's DEDICATED connection. Invoked
   * ONLY after the durable intent record has been persisted (see the CRITICAL
   * ordering note at the top of this file). Must throw on failure.
   */
  attemptDedicatedWrite: () => Promise<void>;
  maxAttempts?: number;
  /** Inline fast-retry count (default 2, ADR-031 §1 step 2). */
  inlineRetries?: number;
  /** Inline fast-retry delay in ms (default 200). */
  retryDelayMs?: number;
  /** Injectable sleep for deterministic tests (default real timer). */
  sleep?: (ms: number) => Promise<void>;
  now?: Date;
}

export interface DualWriteOutcome {
  itemId: string;
  /** 'resolved' — dedicated write succeeded inline, intent record deleted.
   *  'pending'  — inline retries exhausted; item left for the background
   *               worker. The caller's request still succeeds regardless. */
  status: 'resolved' | 'pending';
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Dual-write shadow-copy dispatch with inline fast-retry, called by ADR-030
 * §2's write-path fan-out AFTER the shared write has already succeeded.
 *
 * Step order is load-bearing (ADR-031 §1 — CRITICAL):
 *   1. Persist the `pending` intent record — BEFORE attempting the dedicated
 *      write, unconditionally, not only on failure.
 *   2. Attempt the dedicated write inline, up to `inlineRetries` fast retries.
 *   3a. Success → delete the intent record, return 'resolved'.
 *   3b. Retries exhausted → leave the item 'pending' for the worker, return
 *       'pending'. Never throws to the caller — the shared write is done.
 */
export async function dualWriteWithRetry(params: DualWriteParams): Promise<DualWriteOutcome> {
  const {
    tenantId,
    collectionName,
    operation,
    documentKey,
    payload,
    attemptDedicatedWrite,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    inlineRetries = INLINE_FAST_RETRIES,
    retryDelayMs = INLINE_RETRY_DELAY_MS,
    sleep = defaultSleep,
    now = new Date(),
  } = params;

  // STEP 1 — durable intent record FIRST (ADR-031 §1 step 1, CRITICAL).
  const itemId = await enqueueDualWriteIntent({
    tenantId,
    collectionName,
    operation,
    documentKey,
    payload,
    maxAttempts,
    now,
  });

  // STEP 2 — attempt the dedicated write inline, with fast retries.
  let lastError: unknown;
  for (let attempt = 0; attempt <= inlineRetries; attempt++) {
    if (attempt > 0) await sleep(retryDelayMs);
    try {
      await attemptDedicatedWrite();
      // STEP 3a — success: delete the intent record (ADR-031 §4).
      await resolveDualWriteIntent(tenantId, itemId);
      return { itemId, status: 'resolved' };
    } catch (err) {
      lastError = err;
    }
  }

  // STEP 3b — inline retries exhausted: leave the item 'pending'. The
  // background worker (§3) drains it on its next poll; the caller still
  // succeeds because the shared write already landed.
  await recordInlineFailure(tenantId, itemId, lastError);
  log.warn(
    { tenantId, itemId, collectionName, documentKey, operation },
    'Dual-write dedicated attempt failed inline — left pending for background worker',
  );
  return { itemId, status: 'pending' };
}
