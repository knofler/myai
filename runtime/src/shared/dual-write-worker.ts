/**
 * dual-write-worker — ADR-031 §3 background retry-draining loop.
 *
 * Same lifecycle shape as `monitoring/queue-wait-alerter.ts` (setInterval,
 * poll-and-act, start/stop/isRunning) and the same claim-drain-until-empty
 * shape as `webhooks/webhook-dispatcher.ts`'s `drainDeliveries` (atomic
 * claim-one-at-a-time via `findOneAndUpdate`, looped up to a per-tick cap,
 * re-entrancy guarded so a slow drain never overlaps the next tick).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ RESUMABILITY CONTRACT (ADR-031, "Resumability contract" table)            │
 * │                                                                           │
 * │   The worker re-derives its entire work list from the database on EVERY  │
 * │   poll — `claimDueDualWriteItem` queries live state                       │
 * │   (`{status: pending|retrying, nextAttemptAt <= now}`), nothing here is   │
 * │   cached across ticks. A gateway restart loses only the in-flight tick;   │
 * │   the next tick's claim query picks up exactly where the database says    │
 * │   work is due. No special recovery code, no in-memory checkpoint.         │
 * │                                                                           │
 * │   Per-tenant eligibility is likewise re-checked every time an item is     │
 * │   claimed (never cached): `provisioning`/`suspended` tenants are skipped  │
 * │   (§ releaseIneligibleItem below), `migrating`/`active` tenants are       │
 * │   drained. A tenant that flips status between two polls is picked up      │
 * │   correctly on the very next tick with zero special-cased transition      │
 * │   logic — the query is stateless every time.                              │
 * └─────────────────────────────────────────────────────────────────────────┘
 */
import mongoose from 'mongoose';
import {
  TenantDbBindingModel,
  DualWriteRetryItemModel,
  TaskModel,
  ScheduleModel,
  PlanDayModel,
  RepoCardModel,
  VectorModel,
  GatewaySessionModel,
  BudgetUsageModel,
  redactMongoUri,
  isConnected,
} from './db.js';
import type { ITenantDbBinding } from './db.js';
import {
  claimDueDualWriteItem,
  resolveDualWriteIntent,
  markDualWriteAttemptFailed,
} from './dual-write-queue.js';
import type { ClaimedDualWriteItem } from './dual-write-queue.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'dual-write-worker' });

function envSeconds(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** ADR-031 §3 default: 30s — tight enough that a `pending` item doesn't sit
 *  idle long after the inline fast-retries (§1) already gave it a few
 *  seconds' grace. */
export const DEFAULT_POLL_SECONDS = envSeconds('DUAL_WRITE_QUEUE_POLL_SECONDS', 30);

/** `mongoUri` is `select: false` on the schema — every read here must opt
 *  back in with `.select('+mongoUri')`, never re-declare the field. */
type BindingWithConnStr = ITenantDbBinding & { mongoUri: string };

// ── Dedicated-connection cache ──────────────────────────────────────────
// Same cache-by-tenantId posture as `dual-write-reconciler.ts`'s own cache
// (a separate instance — the reconciler and this worker are independent
// consumers of the same routing table, each owning its own pooled connection
// per currently-migrating tenant).

const dedicatedConnections = new Map<string, mongoose.Connection>();

async function getDedicatedConnection(binding: BindingWithConnStr): Promise<mongoose.Connection> {
  const cached = dedicatedConnections.get(binding.tenantId);
  if (cached && cached.readyState === 1) return cached;

  const conn = await mongoose.createConnection(binding.mongoUri, { dbName: binding.dbName }).asPromise();
  dedicatedConnections.set(binding.tenantId, conn);
  log.info({ tenantId: binding.tenantId, mongoUri: redactMongoUri(binding.mongoUri), dbName: binding.dbName }, 'Dual-write worker opened dedicated connection');
  return conn;
}

/** Test/lifecycle helper — closes and drops all cached dedicated connections. */
export async function closeDedicatedConnections(): Promise<void> {
  for (const conn of dedicatedConnections.values()) {
    await conn.close().catch(() => {});
  }
  dedicatedConnections.clear();
}

// ── Scoped-collection replay registry (ADR-010 §1.1's 8 scoped collections,
// ADR-031 §4's idempotent-replay semantics) ─────────────────────────────────
// `naturalKeyFromPayload` builds the replaceOne filter for an 'upsert' item —
// the full document snapshot is always present for upserts, so this is a
// direct field lookup. `naturalKeyFromDocumentKey` builds the deleteOne
// filter for a 'delete' item — no payload is stored for deletes (schema
// comment on IDualWriteRetryItem.payload), so this parses the same delimited
// `documentKey` string `dual-write-reconciler.ts`'s TARGETS registry builds
// on enqueue. `notifications` has no stable natural key (append-only log, per
// the reconciler's own comment) — both return null, and a delete/upsert
// replay for it fails loudly rather than guessing at an unsafe filter.

interface ReplayTarget {
  label: string;
  model: mongoose.Model<any>;
  naturalKeyFromPayload: (doc: Record<string, unknown>) => Record<string, unknown> | null;
  naturalKeyFromDocumentKey: (documentKey: string) => Record<string, unknown> | null;
}

const REPLAY_TARGETS: ReplayTarget[] = [
  {
    label: 'tasks',
    model: TaskModel,
    naturalKeyFromPayload: d => ({ taskId: d.taskId }),
    naturalKeyFromDocumentKey: k => ({ taskId: k }),
  },
  {
    label: 'schedules',
    model: ScheduleModel,
    naturalKeyFromPayload: d => ({ scheduleId: d.scheduleId }),
    naturalKeyFromDocumentKey: k => ({ scheduleId: k }),
  },
  {
    label: 'planDays',
    model: PlanDayModel,
    naturalKeyFromPayload: d => ({ repo: d.repo, day: d.day }),
    naturalKeyFromDocumentKey: k => {
      const i = k.indexOf(':');
      if (i < 0) return null;
      return { repo: k.slice(0, i), day: k.slice(i + 1) };
    },
  },
  {
    label: 'repoCards',
    model: RepoCardModel,
    naturalKeyFromPayload: d => ({ repoName: d.repoName }),
    naturalKeyFromDocumentKey: k => ({ repoName: k }),
  },
  {
    label: 'vectors',
    model: VectorModel,
    naturalKeyFromPayload: d => ({ repo: d.repo, source: d.source, contentHash: d.contentHash }),
    naturalKeyFromDocumentKey: k => {
      const parts = k.split(':');
      if (parts.length !== 3) return null;
      const [repo, source, contentHash] = parts;
      return { repo, source, contentHash };
    },
  },
  {
    label: 'gatewaySessions',
    model: GatewaySessionModel,
    naturalKeyFromPayload: d => ({ sessionId: d.sessionId }),
    naturalKeyFromDocumentKey: k => ({ sessionId: k }),
  },
  {
    label: 'budgetUsage',
    model: BudgetUsageModel,
    naturalKeyFromPayload: d => ({ callId: d.callId }),
    naturalKeyFromDocumentKey: k => ({ callId: k }),
  },
  {
    label: 'notifications',
    model: null as unknown as mongoose.Model<any>,
    naturalKeyFromPayload: () => null,
    naturalKeyFromDocumentKey: () => null,
  },
];

function findReplayTarget(label: string): ReplayTarget | undefined {
  return REPLAY_TARGETS.find(t => t.label === label);
}

/**
 * Idempotent replay of ONE claimed item against the dedicated connection
 * (ADR-031 §4): `replaceOne(..., {upsert: true})` for 'upsert' (a repeat of
 * an already-applied replace is a no-op change, never a duplicate-key
 * error), `deleteOne` for 'delete' (deleting an already-absent row is a
 * no-op, not an error). Throws on any failure — the caller (processClaimedItem)
 * decides retry/dead-letter from that.
 */
export async function applyClaimedItem(item: ClaimedDualWriteItem, conn: mongoose.Connection): Promise<void> {
  const target = findReplayTarget(item.collectionName);
  if (!target) {
    throw new Error(`dual-write worker: unknown collection '${item.collectionName}'`);
  }
  const collName = target.model ? target.model.collection.name : item.collectionName;

  if (item.operation === 'upsert') {
    if (!item.payload) {
      throw new Error(`dual-write worker: 'upsert' item ${item.itemId} has no payload`);
    }
    const filter = target.naturalKeyFromPayload(item.payload);
    if (!filter) {
      throw new Error(`dual-write worker: collection '${item.collectionName}' has no natural key — cannot replay upsert`);
    }
    await conn.db!.collection(collName).replaceOne(filter, item.payload, { upsert: true });
    return;
  }

  // operation === 'delete'
  const filter = target.naturalKeyFromDocumentKey(item.documentKey);
  if (!filter) {
    throw new Error(`dual-write worker: collection '${item.collectionName}' has no natural key — cannot replay delete`);
  }
  await conn.db!.collection(collName).deleteOne(filter);
}

export type DualWriteItemApplier = (item: ClaimedDualWriteItem, conn: mongoose.Connection) => Promise<void>;

// ── Per-item processing (resumability contract + claim/resolve/fail) ───────

async function bindingFor(tenantId: string): Promise<BindingWithConnStr | null> {
  return TenantDbBindingModel.findOne({ tenantId })
    .select('+mongoUri')
    .lean() as unknown as Promise<BindingWithConnStr | null>;
}

/**
 * Undo an atomic claim without charging it as a real (failed) attempt.
 * `claimDueDualWriteItem` unconditionally flips the row to 'retrying' and
 * increments `attempts` the moment it's claimed — but per the resumability
 * contract table, a `provisioning`/`suspended` tenant (or one with no binding
 * at all) is not eligible right now, and that ineligibility is not the
 * item's fault. This reverses both claim side-effects and reschedules one
 * poll interval out, so the item neither hot-loops nor silently marches
 * toward dead-lettering while merely waiting on tenant state it doesn't
 * control.
 */
async function releaseIneligibleItem(item: ClaimedDualWriteItem, pollSeconds: number, now: Date): Promise<void> {
  const revertedAttempts = Math.max(0, item.attempts - 1);
  await DualWriteRetryItemModel.updateOne(
    { tenantId: item.tenantId, itemId: item.itemId },
    {
      $set: {
        status: revertedAttempts > 0 ? 'retrying' : 'pending',
        nextAttemptAt: new Date(now.getTime() + pollSeconds * 1000),
      },
      $inc: { attempts: -1 },
    },
  );
}

export type ProcessOutcome = 'resolved' | 'retrying' | 'dead' | 'skipped';

async function processClaimedItem(
  item: ClaimedDualWriteItem,
  applier: DualWriteItemApplier,
  pollSeconds: number,
  now: Date,
): Promise<ProcessOutcome> {
  const binding = await bindingFor(item.tenantId);

  // Resumability contract: only 'migrating' (active drain) and 'active'
  // (harmless residual drain, dedicated is sole-authoritative post-cutover)
  // are eligible. 'provisioning' and 'suspended' (and no binding at all) are
  // skipped without penalty — see releaseIneligibleItem's doc comment.
  if (!binding || (binding.status !== 'migrating' && binding.status !== 'active')) {
    await releaseIneligibleItem(item, pollSeconds, now);
    log.debug(
      { tenantId: item.tenantId, itemId: item.itemId, bindingStatus: binding?.status ?? 'none' },
      'Dual-write item skipped — tenant not currently eligible for drain',
    );
    return 'skipped';
  }

  try {
    const conn = await getDedicatedConnection(binding);
    await applier(item, conn);
    await resolveDualWriteIntent(item.tenantId, item.itemId);
    return 'resolved';
  } catch (err) {
    const outcome = await markDualWriteAttemptFailed(item.tenantId, item.itemId, item.attempts, item.maxAttempts, err, now);
    log.warn(
      { tenantId: item.tenantId, itemId: item.itemId, collectionName: item.collectionName, outcome: outcome.status, err },
      'Dual-write replay attempt failed',
    );
    return outcome.status;
  }
}

// ── Drain tick (mirrors webhook-dispatcher.ts's drainDeliveries) ───────────

export interface DrainResult {
  processed: number;
  resolved: number;
  retrying: number;
  dead: number;
  skipped: number;
}

function emptyDrainResult(): DrainResult {
  return { processed: 0, resolved: 0, retrying: 0, dead: 0, skipped: 0 };
}

function requireDb(): void {
  if (!isConnected() || !TenantDbBindingModel || !DualWriteRetryItemModel) {
    throw new Error('MongoDB not connected — dual-write worker unavailable');
  }
}

let draining = false;

/**
 * Drain all currently-due `DualWriteRetryItem`s, one atomic claim at a time,
 * up to `max` per tick (a burst is worked down within a single tick without
 * an unbounded loop). Re-entrancy guarded — a slow tick never overlaps the
 * next interval firing. Never throws — DB/connection failures are logged and
 * produce an empty result so the interval loop keeps running.
 *
 * @param now injectable clock (claim key + reschedule math) for deterministic tests.
 * @param max per-tick claim cap.
 * @param applier injectable replay function (defaults to `applyClaimedItem`) — tests
 *        substitute a fake to exercise the claim/eligibility/resolve/fail control
 *        flow without a real dedicated MongoDB connection.
 * @param pollSeconds used to compute the reschedule delay for ineligible-tenant items.
 */
export async function drainDualWriteQueue(
  now: Date = new Date(),
  max = 100,
  applier: DualWriteItemApplier = applyClaimedItem,
  pollSeconds: number = DEFAULT_POLL_SECONDS,
): Promise<DrainResult> {
  if (draining) return emptyDrainResult();
  draining = true;
  const result = emptyDrainResult();
  try {
    requireDb();
    while (result.processed < max) {
      const item = await claimDueDualWriteItem(now);
      if (!item) break;
      const outcome = await processClaimedItem(item, applier, pollSeconds, now).catch((err: unknown) => {
        log.error({ err, itemId: item.itemId }, 'Dual-write item processing threw unexpectedly');
        return 'retrying' as ProcessOutcome;
      });
      result.processed++;
      result[outcome]++;
    }
  } catch (err) {
    log.warn({ err }, 'Dual-write drain tick skipped — DB unavailable');
  } finally {
    draining = false;
  }
  if (result.processed > 0) {
    log.info(result, 'Dual-write queue drain tick complete');
  }
  latestResult = { ranAt: now, ...result };
  return result;
}

// ── Lifecycle (mirrors monitoring/queue-wait-alerter.ts) ────────────────────

export interface DualWriteWorkerStatusResult extends DrainResult {
  ranAt: Date;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: DualWriteWorkerStatusResult | null = null;

export function startDualWriteWorker(pollSeconds: number = DEFAULT_POLL_SECONDS): void {
  if (intervalId) {
    log.warn('Dual-write worker already running');
    return;
  }
  const intervalMs = pollSeconds * 1000;
  log.info({ pollSeconds }, 'Starting dual-write retry-drain worker');
  intervalId = setInterval(() => {
    drainDualWriteQueue(new Date(), 100, applyClaimedItem, pollSeconds).catch(err =>
      log.error({ err }, 'Periodic dual-write drain tick failed'),
    );
  }, intervalMs);
  intervalId.unref?.();
}

export function stopDualWriteWorker(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Dual-write worker stopped');
  }
}

export function isDualWriteWorkerRunning(): boolean {
  return intervalId !== null;
}

export function getLatestDualWriteWorkerResult(): DualWriteWorkerStatusResult | null {
  return latestResult;
}
