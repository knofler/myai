/**
 * dual-write-reconciler — ADR-031 §5 periodic checksum sweep + cutover gate.
 *
 * Two responsibilities, per every tenant currently `TenantDbBinding.status
 * === 'migrating'`:
 *
 *  1. **Periodic sweep** (`runReconcileSweep`, default every
 *     `DUAL_WRITE_RECONCILE_INTERVAL_MINUTES` minutes): row-count each scoped
 *     collection on the DEDICATED connection (unfiltered — that database only
 *     ever holds the one tenant's rows) against the SHARED connection
 *     (filtered `{tenantId}`), plus a bounded-sample checksum spot-check.
 *     Any divergence self-heals by enqueuing a `DualWriteRetryItem`
 *     (`operation: 'upsert'`, payload = the shared-side row's current state)
 *     for the not-yet-built drain worker (`dual-write-worker.ts`, a sibling
 *     queued follow-up) to apply — this file only detects and records the
 *     repair, it never writes to the dedicated connection itself. Persists
 *     `lastReconciledAt`/`lastReconcileClean` on `TenantDbBinding` so the
 *     cutover gate below never has to re-run a full sweep synchronously.
 *
 *  2. **Cutover gate** (`canCutoverTenant`): the answer to ADR-030's open
 *     "one-time gate vs. continuous job" question — continuous throughout
 *     `migrating`, with cutover gated on the continuous job's current state.
 *     `TenantDbBinding.status` may only flip `migrating` -> `active` when
 *     BOTH (a) zero `DualWriteRetryItem`s are `pending`/`retrying`/`dead` for
 *     that tenant, and (b) the most recent sweep was clean AND ran within
 *     2x the sweep interval of "now" (a stale clean result must not be
 *     trusted — it would mean the sweep job itself died).
 *
 * HIGH severity flags this file must not violate (ADR-031 "Severity flags
 * for implementers"):
 *  - the cutover gate must check `dead`-status items, not just
 *    `pending`/`retrying` — see `canCutoverTenant`'s `$in` below.
 *  - the row-count queries must run dedicated UNFILTERED / shared FILTERED
 *    by `tenantId` — swapping this direction would make every comparison
 *    trivially match even when rows are missing. See `reconcileTarget`.
 */
import mongoose from 'mongoose';
import type { Model } from 'mongoose';
import crypto from 'node:crypto';
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
  NotificationModel,
  redactMongoUri,
  isConnected,
} from './db.js';
import type { ITenantDbBinding } from './db.js';
import { scopedCountDocuments, scopedFind } from './scoped-query.js';
import { createChildLogger } from './logger.js';
import { getAdapter } from '../channels/registry.js';

const log = createChildLogger({ module: 'dual-write-reconciler' });

/** `mongoUri` is `select: false` on the schema — every read path here must
 *  opt back in with `.select('+mongoUri')`, never re-declare the field. */
type BindingWithConnStr = ITenantDbBinding & { mongoUri: string };

function envMinutes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** ADR-031 §5 default: 15 minutes. */
export const DEFAULT_RECONCILE_INTERVAL_MINUTES = envMinutes('DUAL_WRITE_RECONCILE_INTERVAL_MINUTES', 15);

/** Bounded-sample checksum size — a full-collection checksum every sweep
 *  does not scale (ADR-031 §5 step 2's own caveat); this trades exhaustive
 *  coverage per sweep for continuous coverage over many sweeps. */
const SAMPLE_SIZE = 25;

/** Repair-item dead-letter threshold — mirrors ADR-031 §3's constant. Local
 *  until `dual-write-queue.ts` (a sibling queued follow-up) exists to own it. */
const DEFAULT_MAX_ATTEMPTS = 20;

// ── Scoped-collection registry (ADR-010 §1.1's 8 scoped collections) ───────
// `naturalKey` returns the row's stable, non-`_id` identifier as a Mongo
// filter for cross-connection lookup (ADR-031 §2's `documentKey` rationale —
// the two connections' `_id`s are independently generated and can't be
// compared). `null` means this collection has no such key yet (a pre-existing
// gap, e.g. Notification is an append-only log with no unique business key) —
// row-count coverage still applies, but the bounded-sample checksum spot-check
// and self-heal are skipped for it rather than guessing at an unsafe filter.
interface ReconcileTarget {
  /** DualWriteRetryItem.collection label. */
  label: string;
  model: Model<any>;
  naturalKey: (doc: Record<string, unknown>) => Record<string, unknown> | null;
  documentKey: (doc: Record<string, unknown>) => string;
}

const TARGETS: ReconcileTarget[] = [
  { label: 'tasks', model: TaskModel, naturalKey: d => ({ taskId: d.taskId }), documentKey: d => String(d.taskId) },
  { label: 'schedules', model: ScheduleModel, naturalKey: d => ({ scheduleId: d.scheduleId }), documentKey: d => String(d.scheduleId) },
  { label: 'planDays', model: PlanDayModel, naturalKey: d => ({ repo: d.repo, day: d.day }), documentKey: d => `${d.repo}:${d.day}` },
  { label: 'repoCards', model: RepoCardModel, naturalKey: d => ({ repoName: d.repoName }), documentKey: d => String(d.repoName) },
  { label: 'vectors', model: VectorModel, naturalKey: d => ({ repo: d.repo, source: d.source, contentHash: d.contentHash }), documentKey: d => `${d.repo}:${d.source}:${d.contentHash}` },
  { label: 'gatewaySessions', model: GatewaySessionModel, naturalKey: d => ({ sessionId: d.sessionId }), documentKey: d => String(d.sessionId) },
  { label: 'budgetUsage', model: BudgetUsageModel, naturalKey: d => ({ callId: d.callId }), documentKey: d => String(d.callId) },
  { label: 'notifications', model: NotificationModel, naturalKey: () => null, documentKey: d => String(d._id) },
];

// ── Stable, deep, key-sorted document hashing (checksum spot-check) ────────

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Excludes fields that legitimately differ across independently-inserted
 *  copies (`_id`, `__v`) — everything else must match byte-for-byte. */
function hashDoc(doc: Record<string, unknown>): string {
  const { _id, __v, ...rest } = doc;
  return crypto.createHash('sha256').update(stableStringify(rest)).digest('hex');
}

// ── Dedicated-connection cache ──────────────────────────────────────────
// Read-only use here (row counts + natural-key lookups for the checksum
// spot-check) — this file never writes to a dedicated connection; repairs
// go through DualWriteRetryItem for the drain worker to apply. Cached
// indefinitely per tenant, same posture ADR-030 §2 describes for the
// (not-yet-built) dispatch layer's own connection cache.
const dedicatedConnections = new Map<string, mongoose.Connection>();

async function getDedicatedConnection(binding: BindingWithConnStr): Promise<mongoose.Connection> {
  const cached = dedicatedConnections.get(binding.tenantId);
  if (cached && cached.readyState === 1) return cached;

  const conn = await mongoose.createConnection(binding.mongoUri, { dbName: binding.dbName }).asPromise();
  dedicatedConnections.set(binding.tenantId, conn);
  log.info({ tenantId: binding.tenantId, mongoUri: redactMongoUri(binding.mongoUri), dbName: binding.dbName }, 'Dual-write reconciler opened dedicated connection');
  return conn;
}

/** Test/lifecycle helper — closes and drops all cached dedicated connections. */
export async function closeDedicatedConnections(): Promise<void> {
  for (const conn of dedicatedConnections.values()) {
    await conn.close().catch(() => {});
  }
  dedicatedConnections.clear();
}

// ── Per-collection reconciliation ───────────────────────────────────────

interface TargetDivergence {
  label: string;
  sharedCount: number;
  dedicatedCount: number;
  countMismatch: boolean;
  /** Docs found missing or checksum-diverged in the bounded sample. */
  diverged: Array<{ doc: Record<string, unknown>; reason: 'missing' | 'checksum' }>;
}

async function reconcileTarget(tenantId: string, conn: mongoose.Connection, target: ReconcileTarget): Promise<TargetDivergence> {
  const collName = target.model.collection.name;

  // HIGH (ADR-031 severity flags): dedicated is UNFILTERED, shared is
  // FILTERED by tenantId. Do not swap this direction.
  const [sharedCount, dedicatedCount] = await Promise.all([
    scopedCountDocuments(target.model, tenantId),
    conn.db!.collection(collName).countDocuments({}),
  ]);

  const diverged: TargetDivergence['diverged'] = [];

  // Bounded-sample checksum spot-check (ADR-031 §5 step 2) — runs every
  // sweep, independent of whether the row counts already matched, since a
  // same-count-but-different-content divergence (e.g. an update that reached
  // shared but not dedicated) wouldn't show up in a count comparison at all.
  const sample = await scopedFind(target.model, tenantId, {})
    .sort({ updatedAt: -1 })
    .limit(SAMPLE_SIZE)
    .lean()
    .exec() as Record<string, unknown>[];

  for (const doc of sample) {
    const key = target.naturalKey(doc);
    if (!key) continue; // no stable key on this collection — count-only coverage
    const dedicatedDoc = await conn.db!.collection(collName).findOne(key);
    if (!dedicatedDoc) {
      diverged.push({ doc, reason: 'missing' });
      continue;
    }
    if (hashDoc(doc) !== hashDoc(dedicatedDoc as Record<string, unknown>)) {
      diverged.push({ doc, reason: 'checksum' });
    }
  }

  return { label: target.label, sharedCount, dedicatedCount, countMismatch: sharedCount !== dedicatedCount, diverged };
}

/**
 * Self-heal: enqueue a `DualWriteRetryItem` for a divergent row, unless one
 * is already tracked (pending/retrying) for the same (tenant, collection,
 * documentKey) — avoids re-enqueuing a duplicate repair every sweep interval
 * while the drain worker hasn't caught up yet.
 */
async function enqueueRepairItem(tenantId: string, target: ReconcileTarget, doc: Record<string, unknown>): Promise<boolean> {
  const documentKey = target.documentKey(doc);

  const existing = await DualWriteRetryItemModel.findOne({
    tenantId,
    collectionName: target.label,
    documentKey,
    status: { $in: ['pending', 'retrying'] },
  }).lean();
  if (existing) return false;

  const { _id, __v, ...payload } = doc;
  await DualWriteRetryItemModel.create({
    tenantId,
    itemId: `dwr_${crypto.randomUUID()}`,
    collectionName: target.label,
    operation: 'upsert',
    documentKey,
    payload,
    status: 'pending',
    attempts: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    nextAttemptAt: new Date(),
  });
  return true;
}

async function alertDivergence(tenantId: string, repairsEnqueued: number, collections: string[]): Promise<void> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) return;
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) return;

  const message = [
    `\u{1F6A8} Dual-write divergence detected — tenant ${tenantId}`,
    `Collections: ${collections.join(', ')}`,
    `${repairsEnqueued} self-heal DualWriteRetryItem(s) enqueued (operation: upsert) during the periodic reconciliation sweep.`,
    'This is HIGH-severity for operator awareness even though the sweep auto-repairs the data (ADR-031 §5 step 3) — a checksum-detected divergence means the dual-write dispatcher silently dropped a write.',
  ].join('\n');

  try {
    await telegram.send(chatId, message);
  } catch (err) {
    log.error({ tenantId, err }, 'Failed to send dual-write divergence alert');
  }
}

// ── Per-tenant sweep ─────────────────────────────────────────────────────

export interface TenantSweepResult {
  tenantId: string;
  ranAt: Date;
  clean: boolean;
  countMismatches: string[];
  checksumMismatches: string[];
  repairsEnqueued: number;
}

async function sweepTenant(binding: BindingWithConnStr): Promise<TenantSweepResult> {
  const ranAt = new Date();
  const conn = await getDedicatedConnection(binding);

  let clean = true;
  const countMismatches: string[] = [];
  const checksumMismatches: string[] = [];
  let repairsEnqueued = 0;

  for (const target of TARGETS) {
    const div = await reconcileTarget(binding.tenantId, conn, target);
    if (div.countMismatch) {
      clean = false;
      countMismatches.push(target.label);
      log.warn(
        { tenantId: binding.tenantId, collectionName: target.label, sharedCount: div.sharedCount, dedicatedCount: div.dedicatedCount },
        'Dual-write reconciliation: row-count mismatch',
      );
    }
    if (div.diverged.length > 0) {
      clean = false;
      checksumMismatches.push(target.label);
      for (const { doc, reason } of div.diverged) {
        const enqueued = await enqueueRepairItem(binding.tenantId, target, doc);
        if (enqueued) {
          repairsEnqueued++;
          log.warn(
            { tenantId: binding.tenantId, collectionName: target.label, documentKey: target.documentKey(doc), reason },
            'Dual-write reconciliation: divergence found — self-heal repair item enqueued',
          );
        }
      }
    }
  }

  await TenantDbBindingModel.updateOne(
    { tenantId: binding.tenantId },
    { $set: { lastReconciledAt: ranAt, lastReconcileClean: clean } },
  );

  if (repairsEnqueued > 0) {
    await alertDivergence(binding.tenantId, repairsEnqueued, [...new Set([...countMismatches, ...checksumMismatches])]);
  }

  return { tenantId: binding.tenantId, ranAt, clean, countMismatches, checksumMismatches, repairsEnqueued };
}

// ── Sweep runner + lifecycle (mirrors monitoring/queue-wait-alerter.ts) ────

export interface ReconcileSweepResult {
  ranAt: Date;
  tenants: TenantSweepResult[];
}

function requireDb(): void {
  if (!isConnected() || !TenantDbBindingModel || !DualWriteRetryItemModel) {
    throw new Error('MongoDB not connected — dual-write reconciler unavailable');
  }
}

/** Sweep every currently-`migrating` tenant once. Never throws — DB/connection
 *  failures are logged and produce an empty result so the interval loop keeps
 *  running. @param now injectable clock for deterministic tests. */
export async function runReconcileSweep(now: Date = new Date()): Promise<ReconcileSweepResult> {
  let bindings: BindingWithConnStr[];
  try {
    requireDb();
    bindings = (await TenantDbBindingModel.find({ status: 'migrating' })
      .select('+mongoUri')
      .lean()
      .exec()) as unknown as BindingWithConnStr[];
  } catch (err) {
    log.warn({ err }, 'Dual-write reconciliation sweep skipped — DB unavailable');
    const result: ReconcileSweepResult = { ranAt: now, tenants: [] };
    latestResult = result;
    return result;
  }

  const tenants: TenantSweepResult[] = [];
  for (const binding of bindings) {
    try {
      tenants.push(await sweepTenant(binding));
    } catch (err) {
      log.error({ tenantId: binding.tenantId, err }, 'Dual-write reconciliation sweep failed for tenant');
    }
  }

  const result: ReconcileSweepResult = { ranAt: now, tenants };
  latestResult = result;
  if (tenants.some(t => !t.clean)) {
    log.info({ tenants: tenants.length, dirty: tenants.filter(t => !t.clean).length }, 'Dual-write reconciliation sweep complete — divergence found');
  }
  return result;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: ReconcileSweepResult | null = null;

export function startDualWriteReconciler(intervalMinutes: number = DEFAULT_RECONCILE_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Dual-write reconciler already running');
    return;
  }
  const intervalMs = intervalMinutes * 60 * 1000;
  log.info({ intervalMinutes }, 'Starting dual-write reconciliation sweep');
  intervalId = setInterval(() => {
    runReconcileSweep().catch(err => log.error({ err }, 'Periodic dual-write reconciliation sweep failed'));
  }, intervalMs);
}

export function stopDualWriteReconciler(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Dual-write reconciler stopped');
  }
}

export function isDualWriteReconcilerRunning(): boolean {
  return intervalId !== null;
}

export function getLatestReconcileSweepResult(): ReconcileSweepResult | null {
  return latestResult;
}

// ── Cutover gate (the answer to ADR-030's open question, ADR-031 §5) ───────

export interface CutoverGateResult {
  eligible: boolean;
  /** Populated with every failing precondition when `eligible` is false. */
  reasons: string[];
}

/**
 * `TenantDbBinding.status` may only flip `migrating` -> `active` when this
 * returns `eligible: true`. Both preconditions must hold simultaneously:
 *
 *  1. Zero `DualWriteRetryItem`s in `{pending, retrying, dead}` for this
 *     tenant. HIGH (ADR-031 severity flags): `dead` MUST be included here —
 *     a dead-lettered item is unresolved data drift by definition, and
 *     gating only on `pending`/`retrying` would let a migration cut over
 *     while a row is permanently missing from the dedicated copy.
 *  2. The most recent sweep for this tenant reported `lastReconcileClean:
 *     true` AND ran within `2 * DEFAULT_RECONCILE_INTERVAL_MINUTES` of now —
 *     a stale clean result (e.g. the sweep job itself died) must not be
 *     trusted as current.
 */
export interface RowCountCheckResult {
  matches: boolean;
  mismatches: Array<{ label: string; sharedCount: number; dedicatedCount: number }>;
}

/**
 * Row-count-only comparison — the same shared-FILTERED / dedicated-UNFILTERED
 * logic `reconcileTarget` above uses for the periodic sweep (step 1), without
 * the checksum spot-check (step 2). Exported so `decommission-sweep.ts` can
 * reuse it verbatim for its immediately-pre-delete safety check (ADR-032
 * §3.2 step 2), per that ADR's own instruction not to reinvent this logic.
 */
export async function checkRowCountsMatch(tenantId: string, binding: BindingWithConnStr): Promise<RowCountCheckResult> {
  const conn = await getDedicatedConnection(binding);
  const mismatches: RowCountCheckResult['mismatches'] = [];

  for (const target of TARGETS) {
    const collName = target.model.collection.name;
    // HIGH (ADR-031 severity flags, same direction as reconcileTarget above):
    // dedicated is UNFILTERED, shared is FILTERED by tenantId.
    const [sharedCount, dedicatedCount] = await Promise.all([
      scopedCountDocuments(target.model, tenantId),
      conn.db!.collection(collName).countDocuments({}),
    ]);
    if (sharedCount !== dedicatedCount) {
      mismatches.push({ label: target.label, sharedCount, dedicatedCount });
    }
  }

  return { matches: mismatches.length === 0, mismatches };
}

export async function canCutoverTenant(tenantId: string, now: Date = new Date()): Promise<CutoverGateResult> {
  const reasons: string[] = [];

  const unresolvedCount = await DualWriteRetryItemModel.countDocuments({
    tenantId,
    status: { $in: ['pending', 'retrying', 'dead'] },
  });
  if (unresolvedCount > 0) {
    reasons.push(`${unresolvedCount} unresolved DualWriteRetryItem(s) (pending/retrying/dead)`);
  }

  const binding = await TenantDbBindingModel.findOne({ tenantId }).lean();
  if (!binding) {
    reasons.push('no TenantDbBinding found for tenant');
  } else {
    if (binding.lastReconcileClean !== true) {
      reasons.push('most recent reconciliation sweep was not clean (or has never run)');
    }
    const staleAfterMs = 2 * DEFAULT_RECONCILE_INTERVAL_MINUTES * 60 * 1000;
    const lastAt = binding.lastReconciledAt ? binding.lastReconciledAt.getTime() : 0;
    if (now.getTime() - lastAt > staleAfterMs) {
      reasons.push(`last reconciliation sweep is stale (older than ${2 * DEFAULT_RECONCILE_INTERVAL_MINUTES}m)`);
    }
  }

  return { eligible: reasons.length === 0, reasons };
}
