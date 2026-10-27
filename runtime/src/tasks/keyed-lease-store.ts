/**
 * Keyed-lease store (SWARM_COORDINATOR_PLAN phase 1).
 *
 * Arbitrary NAMED leases, one document per (tenant, key) in `keyed_leases`:
 *   - coordinator election:  "swarm-coordinator:host-a"
 *   - resource claims:       "claim:my-repo:src/app.ts"
 *
 * Deliberately separate from runner-lease-store.ts, which is a FIXED N-slot
 * pool capping autonomous-runner concurrency. Putting coordinator/claim leases
 * there would consume runner slots and starve the runner.
 *
 * Correctness rests on three database-level properties:
 *  1. The unique index { tenantId, key } — two holders racing to insert the
 *     same free key: exactly one insert wins, the loser gets E11000 and is told
 *     who holds it.
 *  2. Atomic findOneAndUpdate for takeover — a key whose leaseUntil has passed
 *     is taken over in the same operation that checks staleness, so two
 *     acquirers can't both win a stale lease.
 *  3. SERVER TIME. Gateways on several Macs write to one Atlas database, and
 *     their clocks drift. Every expiry write (`leaseUntil = $$NOW + leaseMs`,
 *     `acquiredAt/heartbeatAt = $$NOW`) is an aggregation-pipeline update, and
 *     every expiry check (`$expr: {$lte: ['$leaseUntil', '$$NOW']}`, the list's
 *     `stale` flag) is evaluated by Mongo. This module never writes or compares
 *     a client-side Date. (Mongoose's timestamps plugin appends its own
 *     `updatedAt` stage with the gateway clock — bookkeeping only, never read
 *     for expiry.)
 *
 * Fencing: `epoch` is 1 on insert and +1 on every takeover (unchanged on
 * same-holder extend and heartbeat). A holder keeps the epoch it acquired and
 * passes it to heartbeat/release, so a stale incarnation that was taken over
 * and later re-acquired by the same holder string can't act on the new lease.
 *
 * A TTL index on leaseUntil garbage-collects leftovers ~1h after expiry; it is
 * never relied on for correctness (Mongo's TTL monitor lags up to 60s).
 *
 * Test coverage note: unit tests run against an in-memory mock that emulates
 * the pipeline operators used here. Real-Mongo concurrency/race tests (review
 * item #6 on PR #484) are DEFERRED — mongodb-memory-server is not in
 * runtime's devDependencies.
 */
import { KeyedLeaseModel, isConnected } from '../shared/db.js';
import type { IKeyedLease } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedAggregate, scopedFindOneAndUpdate, scopedDeleteOne } from '../shared/scoped-query.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';

const log = createChildLogger({ module: 'keyed-lease-store' });

export const DEFAULT_KEYED_LEASE_SECONDS = 600;
export const MIN_KEYED_LEASE_SECONDS = 30;
export const MAX_KEYED_LEASE_SECONDS = 86_400;
export const MAX_KEY_LENGTH = 200;
export const MIN_HOLDER_LENGTH = 3;
export const MAX_HOLDER_LENGTH = 200;
/** meta is visibility-only (lane, pid, host, note) — keep it small. */
export const MAX_META_BYTES = 2048;
export const DEFAULT_LIST_LIMIT = 200;
export const MAX_LIST_LIMIT = 1000;

/** Thrown for bad input; MCP handlers turn it into `{ error }`. */
export class KeyedLeaseValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyedLeaseValidationError';
  }
}

export interface AcquireKeyedLeaseInput {
  key: string;
  holder: string;
  leaseSeconds?: number;
  meta?: Record<string, unknown>;
}

export interface HeartbeatKeyedLeaseInput {
  key: string;
  holder: string;
  leaseSeconds?: number;
  /** Fencing token from acquire; when given it must match the stored epoch. */
  epoch?: number;
}

export interface ReleaseKeyedLeaseInput {
  key: string;
  holder: string;
  /** Operator override: delete regardless of holder (capability-gated by the caller). */
  force?: boolean;
  /** Fencing token from acquire; when given it must match the stored epoch. */
  epoch?: number;
}

export interface KeyedLeaseView {
  key: string;
  holder: string;
  epoch: number;
  acquiredAt: Date;
  heartbeatAt: Date;
  leaseUntil: Date;
  meta?: Record<string, unknown>;
  /** leaseUntil <= Mongo server time — the next acquirer takes it over. */
  stale: boolean;
}

/** Shape of a lease doc as returned by findOneAndUpdate or an aggregation. */
type LeaseDocLike = Pick<IKeyedLease, 'key' | 'holder' | 'acquiredAt' | 'heartbeatAt' | 'leaseUntil' | 'meta'>
  & { epoch?: number; previousHolder?: string; stale?: boolean };

/**
 * `stale` must come from the server: pass the aggregation's computed flag, or
 * `false` for a doc this call just wrote (leaseUntil = $$NOW + >=30s).
 */
function toView(doc: LeaseDocLike, stale: boolean): KeyedLeaseView {
  return {
    key: doc.key,
    holder: doc.holder,
    epoch: doc.epoch ?? 1,
    acquiredAt: doc.acquiredAt,
    heartbeatAt: doc.heartbeatAt,
    leaseUntil: doc.leaseUntil,
    meta: doc.meta ?? undefined,
    stale,
  };
}

function requireDb(): void {
  if (!isConnected() || !KeyedLeaseModel) {
    throw new Error('MongoDB not connected — keyed leases unavailable');
  }
}

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

// ── Server-time expressions ───────────────────────────────────────────────

/** Expiry check evaluated by Mongo: leaseUntil <= server now. */
export const STALE_EXPR = { $lte: ['$leaseUntil', '$$NOW'] } as const;

function leaseUntilExpr(leaseMs: number) {
  return { $add: ['$$NOW', leaseMs] };
}

// ── Validation ────────────────────────────────────────────────────────────

export function validateKey(key: unknown): string {
  if (typeof key !== 'string' || key.length === 0) {
    throw new KeyedLeaseValidationError('key is required (non-empty string)');
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new KeyedLeaseValidationError(`key must be at most ${MAX_KEY_LENGTH} characters`);
  }
  if (/\s/.test(key)) {
    throw new KeyedLeaseValidationError('key must not contain whitespace');
  }
  return key;
}

/**
 * Holder identity: "<host>/<lane>/<pid>"-ish — at least two '/'-separated
 * non-empty segments, 3..200 chars, no whitespace. Including the pid makes
 * same-string idempotency per PROCESS: a restarted session gets a new holder
 * string and cannot silently "re-acquire" its dead predecessor's lease.
 */
export function validateHolder(holder: unknown): string {
  if (typeof holder !== 'string' || holder.length === 0) {
    throw new KeyedLeaseValidationError('holder is required (non-empty string)');
  }
  if (holder.length < MIN_HOLDER_LENGTH || holder.length > MAX_HOLDER_LENGTH) {
    throw new KeyedLeaseValidationError(`holder must be ${MIN_HOLDER_LENGTH}-${MAX_HOLDER_LENGTH} characters`);
  }
  if (/\s/.test(holder)) {
    throw new KeyedLeaseValidationError('holder must not contain whitespace');
  }
  const segments = holder.split('/');
  if (segments.length < 2 || segments.some(s => s.length === 0)) {
    throw new KeyedLeaseValidationError('holder must look like "<host>/<lane>/<pid>" (at least two non-empty "/"-separated segments)');
  }
  return holder;
}

/** Default 600s; clamped to 30..86400. Non-numeric input falls back to the default. */
export function clampLeaseSeconds(leaseSeconds: unknown): number {
  if (typeof leaseSeconds !== 'number' || !Number.isFinite(leaseSeconds)) return DEFAULT_KEYED_LEASE_SECONDS;
  return Math.min(MAX_KEYED_LEASE_SECONDS, Math.max(MIN_KEYED_LEASE_SECONDS, Math.floor(leaseSeconds)));
}

export function validateEpoch(epoch: unknown): number | undefined {
  if (epoch === undefined || epoch === null) return undefined;
  if (typeof epoch !== 'number' || !Number.isInteger(epoch) || epoch < 1) {
    throw new KeyedLeaseValidationError('epoch must be a positive integer (the value returned by lease_acquire)');
  }
  return epoch;
}

/** Mongo field names: no leading '$', no '.', at any depth. */
function assertSafeMetaKeys(value: unknown, path: string): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertSafeMetaKeys(v, `${path}[${i}]`));
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k.startsWith('$') || k.includes('.')) {
      throw new KeyedLeaseValidationError(`meta key "${path}${k}" must not start with "$" or contain "."`);
    }
    assertSafeMetaKeys(v, `${path}${k}.`);
  }
}

export function validateMeta(meta: unknown): Record<string, unknown> | undefined {
  if (meta === undefined || meta === null) return undefined;
  if (typeof meta !== 'object' || Array.isArray(meta)) {
    throw new KeyedLeaseValidationError('meta must be a plain object (e.g. {lane, pid, host, note})');
  }
  let json: string;
  try {
    json = JSON.stringify(meta);
  } catch {
    throw new KeyedLeaseValidationError('meta must be JSON-serialisable');
  }
  if (Buffer.byteLength(json, 'utf8') > MAX_META_BYTES) {
    throw new KeyedLeaseValidationError(`meta must serialise to at most ${MAX_META_BYTES} bytes`);
  }
  assertSafeMetaKeys(meta, '');
  return meta as Record<string, unknown>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Reads (server-time stale flag) ───────────────────────────────────────

async function readLease(tenantId: string, key: string): Promise<KeyedLeaseView | undefined> {
  const rows = await scopedAggregate(KeyedLeaseModel, tenantId, [
    { $match: { key } },
    { $limit: 1 },
    { $addFields: { stale: STALE_EXPR } },
  ]) as LeaseDocLike[];
  const row = rows[0];
  return row ? toView(row, row.stale === true) : undefined;
}

// ── Operations ────────────────────────────────────────────────────────────

/**
 * Acquire a keyed lease. Three outcomes, each a single atomic DB operation:
 *  - already ours (valid or expired-but-untaken) → idempotent extend; keeps
 *    acquiredAt and epoch;
 *  - stale (server time) and someone else's → atomic takeover, epoch + 1;
 *  - absent → insert with epoch 1; a lost insert race surfaces as E11000 (or
 *    as the winner's doc being returned) and is reported as heldBy.
 * Validly held by another holder → { acquired:false, heldBy }.
 */
export async function acquireKeyedLease(
  tenantId: string,
  input: AcquireKeyedLeaseInput,
): Promise<{ acquired: boolean; lease?: KeyedLeaseView; heldBy?: KeyedLeaseView; tookOverFrom?: string }> {
  const key = validateKey(input.key);
  const holder = validateHolder(input.holder);
  const leaseMs = clampLeaseSeconds(input.leaseSeconds) * 1000;
  const meta = validateMeta(input.meta);
  requireDb();
  // $literal: caller strings must never be interpreted as field paths/operators.
  const metaLit = meta !== undefined ? { $literal: meta } : undefined;

  // A doc can flip between "ours", "stale", and "absent" while we look, so
  // retry the three-step ladder a couple of times before reporting heldBy.
  for (let attempt = 0; attempt < 3; attempt++) {
    // 1. Same holder → idempotent extend (epoch + acquiredAt unchanged).
    const mine = await scopedFindOneAndUpdate(
      KeyedLeaseModel, tenantId,
      { key, holder },
      [{ $set: {
        heartbeatAt: '$$NOW',
        leaseUntil: leaseUntilExpr(leaseMs),
        ...(metaLit ? { meta: metaLit } : {}),
      } }],
      { new: true },
    ) as LeaseDocLike | null;
    if (mine) {
      log.info({ key, holder, epoch: mine.epoch }, 'Keyed lease extended (idempotent acquire)');
      return { acquired: true, lease: toView(mine, false) };
    }

    // 2. Stale by SERVER time (other holder) → atomic takeover, epoch + 1.
    //    previousHolder captures the old holder in the same write ($set stage
    //    expressions read the pre-update document); old meta never carries over.
    const taken = await scopedFindOneAndUpdate(
      KeyedLeaseModel, tenantId,
      { key, $expr: STALE_EXPR },
      [
        { $set: {
          previousHolder: '$holder',
          holder: { $literal: holder },
          acquiredAt: '$$NOW',
          heartbeatAt: '$$NOW',
          leaseUntil: leaseUntilExpr(leaseMs),
          epoch: { $add: [{ $ifNull: ['$epoch', 0] }, 1] },
          meta: metaLit ?? '$$REMOVE',
        } },
      ],
      { new: true },
    ) as LeaseDocLike | null;
    if (taken) {
      const view = toView(taken, false);
      log.info({ key, holder, previousHolder: taken.previousHolder, epoch: view.epoch }, 'Keyed lease taken over (stale)');
      emitNotifyEvent({
        type: 'lease.takeover',
        tenantId,
        title: `Lease ${key} taken over`,
        message: `${holder} took over from ${taken.previousHolder ?? 'unknown'} (epoch ${view.epoch})`,
        level: 'warning',
        source: 'keyed-lease-store',
        data: { key, holder, previousHolder: taken.previousHolder, epoch: view.epoch },
      });
      return { acquired: true, lease: view, tookOverFrom: taken.previousHolder };
    }

    // 3. Absent → insert via pipeline upsert. Pipelines have no $setOnInsert,
    //    so every field is conditional on "no doc yet" (holder missing): an
    //    existing doc is left as it is and returned, so a concurrent winner is
    //    reported rather than clobbered.
    const isNew = { $eq: [{ $type: '$holder' }, 'missing'] };
    const onInsert = (value: unknown, field: string) => ({ $cond: [isNew, value, `$${field}`] });
    try {
      const doc = await scopedFindOneAndUpdate(
        KeyedLeaseModel, tenantId,
        { key },
        [{ $set: {
          holder: onInsert({ $literal: holder }, 'holder'),
          acquiredAt: onInsert('$$NOW', 'acquiredAt'),
          heartbeatAt: onInsert('$$NOW', 'heartbeatAt'),
          leaseUntil: onInsert(leaseUntilExpr(leaseMs), 'leaseUntil'),
          epoch: onInsert(1, 'epoch'),
          meta: onInsert(metaLit ?? '$$REMOVE', 'meta'),
        } }],
        { upsert: true, new: true },
      ) as LeaseDocLike | null;
      if (doc && doc.holder === holder) {
        log.info({ key, holder, epoch: doc.epoch }, 'Keyed lease acquired');
        return { acquired: true, lease: toView(doc, false) };
      }
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
    // Someone else holds it (or won the insert race). Server decides staleness:
    // a valid lease → refused; stale/absent/ours-now → loop and retry.
    const current = await readLease(tenantId, key);
    if (current && current.holder !== holder && !current.stale) {
      log.info({ key, holder, heldBy: current.holder }, 'Keyed lease NOT acquired');
      return { acquired: false, heldBy: current };
    }
  }

  const current = await readLease(tenantId, key);
  log.info({ key, holder, heldBy: current?.holder }, 'Keyed lease NOT acquired (contended)');
  return { acquired: false, heldBy: current };
}

/**
 * Extend a held lease. Succeeds only while the doc still carries this holder
 * (and `epoch`, when given); after a takeover or release it returns ok:false —
 * the caller has lost the lease and must stop acting as its holder. Extending
 * an expired-but-not-taken-over lease is allowed: the doc still being ours
 * proves nobody took it. Epoch is never changed by a heartbeat.
 */
export async function heartbeatKeyedLease(
  tenantId: string,
  input: HeartbeatKeyedLeaseInput,
): Promise<{ ok: boolean; lease?: KeyedLeaseView; heldBy?: KeyedLeaseView; reason?: string }> {
  const key = validateKey(input.key);
  const holder = validateHolder(input.holder);
  const leaseMs = clampLeaseSeconds(input.leaseSeconds) * 1000;
  const epoch = validateEpoch(input.epoch);
  requireDb();
  const doc = await scopedFindOneAndUpdate(
    KeyedLeaseModel, tenantId,
    { key, holder, ...(epoch !== undefined ? { epoch } : {}) },
    [{ $set: { heartbeatAt: '$$NOW', leaseUntil: leaseUntilExpr(leaseMs) } }],
    { new: true },
  ) as LeaseDocLike | null;
  if (doc) return { ok: true, lease: toView(doc, false) };
  const current = await readLease(tenantId, key);
  return {
    ok: false,
    heldBy: current,
    reason: `lease ${key} not held by ${holder}${epoch !== undefined ? ` at epoch ${epoch}` : ''} (taken over, released, or never acquired)`,
  };
}

/**
 * Release a lease. Holder-scoped (cannot free a lease another holder took
 * over); `force` deletes regardless of holder — the operator override for a
 * wedged holder (the MCP handler requires the `configure` capability for it).
 * `epoch`, when given, must match even under force. Idempotent: releasing an
 * absent lease returns released:false.
 */
export async function releaseKeyedLease(
  tenantId: string,
  input: ReleaseKeyedLeaseInput,
): Promise<{ released: boolean; forced?: boolean; reason?: string }> {
  const key = validateKey(input.key);
  const holder = validateHolder(input.holder);
  const epoch = validateEpoch(input.epoch);
  requireDb();
  const filter: Record<string, unknown> = input.force ? { key } : { key, holder };
  if (epoch !== undefined) filter.epoch = epoch;
  const res = await scopedDeleteOne(KeyedLeaseModel, tenantId, filter);
  const released = (res.deletedCount ?? 0) > 0;
  if (released) {
    log.info({ key, holder, force: !!input.force, epoch }, 'Keyed lease released');
    return input.force ? { released, forced: true } : { released };
  }
  const who = input.force ? 'found' : `held by ${holder}`;
  return { released, reason: `lease ${key} not ${who}${epoch !== undefined ? ` at epoch ${epoch}` : ''}` };
}

/**
 * Keyed leases for the tenant (active + stale-awaiting-GC), key order, with a
 * server-time `stale` flag. `limit` default 200, max 1000; `truncated` says
 * more matched than were returned.
 */
export async function listKeyedLeases(
  tenantId: string,
  opts: { prefix?: string; limit?: number } = {},
): Promise<{ leases: KeyedLeaseView[]; truncated: boolean }> {
  const match: Record<string, unknown> = {};
  if (opts.prefix !== undefined && opts.prefix !== '') {
    if (typeof opts.prefix !== 'string' || opts.prefix.length > MAX_KEY_LENGTH) {
      throw new KeyedLeaseValidationError(`prefix must be a string of at most ${MAX_KEY_LENGTH} characters`);
    }
    match.key = { $regex: `^${escapeRegex(opts.prefix)}` };
  }
  let limit = DEFAULT_LIST_LIMIT;
  if (opts.limit !== undefined && opts.limit !== null) {
    if (typeof opts.limit !== 'number' || !Number.isFinite(opts.limit)) {
      throw new KeyedLeaseValidationError('limit must be a number');
    }
    limit = Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(opts.limit)));
  }
  requireDb();
  const rows = await scopedAggregate(KeyedLeaseModel, tenantId, [
    { $match: match },
    { $sort: { key: 1 } },
    { $limit: limit + 1 },
    { $addFields: { stale: STALE_EXPR } },
  ]) as LeaseDocLike[];
  const truncated = rows.length > limit;
  return { leases: rows.slice(0, limit).map(r => toView(r, r.stale === true)), truncated };
}
