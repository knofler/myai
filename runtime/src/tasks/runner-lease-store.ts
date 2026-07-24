/**
 * Runner-lease store (ADR-011 slice 3 — fleet-wide runner concurrency).
 *
 * A fixed pool of N slots (N = active Claude accounts, start 2) caps concurrent
 * autonomous runner sessions ACROSS machines. This replaces the per-machine
 * /tmp/cli-task-runner.slots dirs, which could never see the other Mac's
 * runners — two Macs each running MAX_CONCURRENT sessions would exceed what the
 * subscriptions allow. With the lease, at most N sessions run fleet-wide no
 * matter how many machines fire.
 *
 * Concurrency safety rests on two database-level primitives:
 *  1. The unique index { tenantId, slot } — two runners upserting the same free
 *     slot race, exactly one insert wins, the loser gets E11000 and tries the
 *     next slot.
 *  2. Atomic findOneAndUpdate for reclaim — a slot whose leaseUntil is in the
 *     past (crashed runner) is taken over in the same operation that checks
 *     staleness, so two reclaimers can't both win.
 *
 * A holder keeps its lease alive via heartbeat (extends leaseUntil); release
 * deletes the slot doc so the next fire acquires instantly. A TTL index on the
 * collection garbage-collects leftovers of crashed runners ~1h after expiry.
 */
import { RunnerLeaseModel, isConnected } from '../shared/db.js';
import type { IRunnerLease } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOneAndUpdate, scopedDeleteOne, scopedCountDocuments } from '../shared/scoped-query.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';

const log = createChildLogger({ module: 'runner-lease-store' });

/** ADR-011: slots = active Claude accounts (claude-tech + claude-personal). */
export const DEFAULT_LEASE_SLOTS = 2;
/** Covers the runner's 45-min session cap with margin, so a runner that never
 *  heartbeats (old script version) still can't lose its slot mid-run. */
export const DEFAULT_LEASE_SECONDS = 3600;

export interface AcquireLeaseInput {
  /** Runner identity, e.g. "runner-host/12345". */
  holder: string;
  machine?: string;
  account?: string;
  taskId?: string;
  /** Slot-pool size; default DEFAULT_LEASE_SLOTS. */
  slots?: number;
  leaseSeconds?: number;
}

export interface HeartbeatLeaseInput {
  holder: string;
  slot: number;
  leaseSeconds?: number;
  /** Optionally stamp the task being worked (visibility). */
  taskId?: string;
}

export interface ReleaseLeaseInput {
  holder: string;
  slot: number;
}

export interface RunnerLeaseView {
  slot: number;
  holder: string;
  machine?: string;
  account?: string;
  taskId?: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  leaseUntil: Date;
  /** leaseUntil in the past — reclaimable by the next acquirer. */
  stale: boolean;
}

function toView(doc: IRunnerLease, now: Date): RunnerLeaseView {
  return {
    slot: doc.slot,
    holder: doc.holder,
    machine: doc.machine,
    account: doc.account,
    taskId: doc.taskId,
    acquiredAt: doc.acquiredAt,
    heartbeatAt: doc.heartbeatAt,
    leaseUntil: doc.leaseUntil,
    stale: doc.leaseUntil.getTime() <= now.getTime(),
  };
}

function requireDb(): void {
  if (!isConnected() || !RunnerLeaseModel) {
    throw new Error('MongoDB not connected — runner leases unavailable');
  }
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

/**
 * Try to acquire one of the N lease slots. Walks slot 0..N-1; for each, one
 * atomic upsert that succeeds when the slot is free (insert), stale (reclaim),
 * or already ours (idempotent re-acquire — a retried fire keeps its slot).
 * Returns { acquired:false } when every slot is validly held.
 */
export async function acquireLease(
  tenantId: string,
  input: AcquireLeaseInput,
): Promise<{ acquired: boolean; lease?: RunnerLeaseView; maxSlots: number; activeSlots: number }> {
  requireDb();
  const maxSlots = Math.max(1, input.slots ?? DEFAULT_LEASE_SLOTS);
  const leaseMs = (input.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;

  for (let slot = 0; slot < maxSlots; slot++) {
    const now = new Date();
    try {
      const doc = await scopedFindOneAndUpdate(
        RunnerLeaseModel, tenantId,
        // Matches when the slot doc is ours OR stale; no match + upsert inserts
        // a fresh doc (free slot) — the unique {tenantId, slot} index turns a
        // lost insert race into E11000, handled below. A validly-held slot
        // (other holder, unexpired) matches nothing and E11000s on the insert.
        { slot, $or: [{ holder: input.holder }, { leaseUntil: { $lte: now } }] },
        {
          $set: {
            holder: input.holder,
            machine: input.machine,
            account: input.account,
            taskId: input.taskId,
            acquiredAt: now,
            heartbeatAt: now,
            leaseUntil: new Date(now.getTime() + leaseMs),
          },
        },
        { upsert: true, new: true },
      ) as IRunnerLease | null;
      if (doc) {
        const activeSlots = await scopedCountDocuments(RunnerLeaseModel, tenantId, { leaseUntil: { $gt: now } });
        log.info({ slot: doc.slot, holder: input.holder, leaseUntil: doc.leaseUntil }, 'Runner lease acquired');
        // Real-time "runner fired" event — a runner just claimed a slot and is
        // about to work. Surfaces on the dashboard live (slot N of M busy).
        // Fire-and-forget: the notify bus never throws or blocks the acquire.
        emitNotifyEvent({
          type: 'runner.fired',
          tenantId,
          title: `Runner fired on slot ${doc.slot}`,
          message: `${input.holder} — ${activeSlots}/${maxSlots} slot(s) busy`,
          level: 'info',
          source: 'runner-lease-store',
          data: {
            slot: doc.slot,
            holder: input.holder,
            machine: input.machine,
            account: input.account,
            taskId: input.taskId,
            activeSlots,
            maxSlots,
          },
        });
        return { acquired: true, lease: toView(doc, now), maxSlots, activeSlots };
      }
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      // slot validly held by another runner — try the next one
    }
  }

  const now = new Date();
  const activeSlots = await scopedCountDocuments(RunnerLeaseModel, tenantId, { leaseUntil: { $gt: now } });
  log.info({ holder: input.holder, maxSlots, activeSlots }, 'Runner lease NOT acquired — all slots busy');
  return { acquired: false, maxSlots, activeSlots };
}

/**
 * Extend a held lease. Only succeeds while the slot doc still carries this
 * holder — after a stale reclaim by another runner it returns ok:false, which
 * the runner must treat as "lost the slot" (finish current step, don't claim
 * more work). Extending an expired-but-unreclaimed lease is allowed: the doc
 * still being ours proves nobody took it.
 */
export async function heartbeatLease(
  tenantId: string,
  input: HeartbeatLeaseInput,
): Promise<{ ok: boolean; lease?: RunnerLeaseView; reason?: string }> {
  requireDb();
  const now = new Date();
  const leaseMs = (input.leaseSeconds ?? DEFAULT_LEASE_SECONDS) * 1000;
  const update: Record<string, unknown> = {
    heartbeatAt: now,
    leaseUntil: new Date(now.getTime() + leaseMs),
  };
  if (input.taskId !== undefined) update.taskId = input.taskId;
  const doc = await scopedFindOneAndUpdate(
    RunnerLeaseModel, tenantId,
    { slot: input.slot, holder: input.holder },
    { $set: update },
    { new: true },
  ) as IRunnerLease | null;
  if (!doc) {
    return { ok: false, reason: `slot ${input.slot} not held by ${input.holder} (expired and reclaimed, released, or never acquired)` };
  }
  return { ok: true, lease: toView(doc, now) };
}

/**
 * Release a held lease (delete the slot doc). Holder-scoped so a runner can
 * never free a slot another runner reclaimed from it. Idempotent — releasing
 * an already-released slot reports released:false, not an error.
 */
export async function releaseLease(
  tenantId: string,
  input: ReleaseLeaseInput,
): Promise<{ released: boolean }> {
  requireDb();
  const res = await scopedDeleteOne(RunnerLeaseModel, tenantId, { slot: input.slot, holder: input.holder });
  const released = (res.deletedCount ?? 0) > 0;
  if (released) log.info({ slot: input.slot, holder: input.holder }, 'Runner lease released');
  return { released };
}

/** All lease docs for the tenant (active + stale-awaiting-GC), slot order. */
export async function listLeases(
  tenantId: string,
  slots?: number,
): Promise<{ maxSlots: number; activeSlots: number; leases: RunnerLeaseView[] }> {
  requireDb();
  const now = new Date();
  const docs = await scopedFind(RunnerLeaseModel, tenantId, {}).sort({ slot: 1 }).exec() as IRunnerLease[];
  const leases = docs.map(d => toView(d, now));
  return {
    maxSlots: Math.max(1, slots ?? DEFAULT_LEASE_SLOTS),
    activeSlots: leases.filter(l => !l.stale).length,
    leases,
  };
}
