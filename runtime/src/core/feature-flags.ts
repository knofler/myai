/**
 * Platform feature-flag service — global flags with per-tenant overrides,
 * deterministic percentage rollout, and kill-switch semantics. Lets risky
 * product features ship dark and roll out gradually, per tenant or by cohort.
 *
 * Distinct from the operator fleet kill-switch (ops-wide runner pause) and
 * from env-var toggles like INLINE_EXEC_ENABLED (boot-time, fleet-wide):
 * these flags gate INDIVIDUAL PRODUCT FEATURES, are mutable at runtime via
 * the admin REST routes (server.ts `/api/flags`), and evaluate per tenant.
 *
 * Evaluation precedence (strict, top wins):
 *   1. state 'killed'      → OFF for everyone, tenant overrides IGNORED.
 *                            The kill-switch is the emergency brake — nothing
 *                            re-enables a killed flag except an explicit
 *                            state change back to on/off.
 *   2. tenant override     → forced on/off for that tenant.
 *   3. state 'off'         → OFF (dark — the default for a new flag).
 *   4. state 'on' + rollout → deterministic percentage bucket: FNV-1a hash of
 *                            `key:tenantId` mod 100 < rolloutPercent. Stable
 *                            across restarts/machines so a tenant never
 *                            flip-flops as the gateway redeploys.
 *
 * Storage follows the repo's "MongoDB first, fallback to memory" posture
 * (same as agents/skills): writes land in `FeatureFlagModel` when connected,
 * and a process-local Map keeps local single-operator mode working with no
 * Mongo at all. A short read-through cache bounds eval cost per request.
 */
import { FeatureFlagModel, isConnected, type IFeatureFlag } from '../shared/db.js';
import { AuthError } from './tenant-context.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'feature-flags' });

export type FlagState = 'on' | 'off' | 'killed';

export interface TenantOverride {
  tenantId: string;
  enabled: boolean;
}

/** Plain (lean) shape of one flag — what the REST layer and evaluator see. */
export interface FeatureFlag {
  key: string;
  description?: string;
  state: FlagState;
  /** 0–100; only consulted when state === 'on'. 100 = everyone. */
  rolloutPercent: number;
  overrides: TenantOverride[];
  updatedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface FlagEvaluation {
  key: string;
  enabled: boolean;
  reason: 'killed' | 'override' | 'off' | 'rollout-in' | 'rollout-out' | 'missing';
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const FLAG_STATES: readonly FlagState[] = ['on', 'off', 'killed'];

export function isValidFlagKey(key: string): boolean {
  return KEY_RE.test(key);
}

// ── Pure evaluation core (no I/O — unit-testable) ────────────────

/**
 * Deterministic rollout bucket 0–99 for a (flag, tenant) pair — FNV-1a 32-bit
 * over `key:tenantId`. Pure and stable: the same pair lands in the same
 * bucket on every machine, forever, so a 20% rollout is a fixed cohort that
 * only grows as the percentage is raised (never reshuffles).
 */
export function rolloutBucket(key: string, tenantId: string): number {
  const input = `${key}:${tenantId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 100;
}

/** Evaluate one flag for a tenant per the precedence contract above. */
export function evaluateFlag(flag: FeatureFlag, tenantId: string): FlagEvaluation {
  if (flag.state === 'killed') return { key: flag.key, enabled: false, reason: 'killed' };
  const override = flag.overrides.find((o) => o.tenantId === tenantId);
  if (override) return { key: flag.key, enabled: override.enabled, reason: 'override' };
  if (flag.state === 'off') return { key: flag.key, enabled: false, reason: 'off' };
  const inCohort = rolloutBucket(flag.key, tenantId) < flag.rolloutPercent;
  return { key: flag.key, enabled: inCohort, reason: inCohort ? 'rollout-in' : 'rollout-out' };
}

// ── Store (Mongo first, in-memory fallback) ──────────────────────

const memoryStore = new Map<string, FeatureFlag>();

// Read-through cache for the hot eval path — one Mongo find per TTL window
// instead of one per request. Writes invalidate immediately.
const CACHE_TTL_MS = 10_000;
let cachedFlags: FeatureFlag[] | null = null;
let cachedAt = 0;

function invalidateCache(): void {
  cachedFlags = null;
  cachedAt = 0;
}

/** Test hook — reset both the memory store and the read cache. */
export function resetFeatureFlagStore(): void {
  memoryStore.clear();
  invalidateCache();
}

function toPlain(doc: IFeatureFlag | FeatureFlag): FeatureFlag {
  return {
    key: doc.key,
    description: doc.description,
    state: doc.state,
    rolloutPercent: doc.rolloutPercent,
    overrides: (doc.overrides ?? []).map((o) => ({ tenantId: o.tenantId, enabled: o.enabled })),
    updatedBy: doc.updatedBy,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function listFlags(): Promise<FeatureFlag[]> {
  if (isConnected() && FeatureFlagModel) {
    const docs = await FeatureFlagModel.find({}).sort({ key: 1 }).lean<IFeatureFlag[]>();
    return docs.map(toPlain);
  }
  return [...memoryStore.values()].sort((a, b) => a.key.localeCompare(b.key)).map(toPlain);
}

export async function getFlag(key: string): Promise<FeatureFlag | null> {
  if (isConnected() && FeatureFlagModel) {
    const doc = await FeatureFlagModel.findOne({ key }).lean<IFeatureFlag | null>();
    return doc ? toPlain(doc) : null;
  }
  const flag = memoryStore.get(key);
  return flag ? toPlain(flag) : null;
}

export interface UpsertFlagInput {
  key: string;
  description?: string;
  state?: FlagState;
  rolloutPercent?: number;
  updatedBy?: string;
}

/**
 * Create or update a flag. New flags default DARK (state 'off', rollout 0) —
 * shipping the flag never ships the feature. Reviving a killed flag requires
 * explicitly passing state 'on'/'off' here (kill is sticky by design).
 */
export async function upsertFlag(input: UpsertFlagInput): Promise<FeatureFlag> {
  const key = String(input.key ?? '').trim();
  if (!isValidFlagKey(key)) {
    throw new AuthError(`invalid flag key '${key}' — lowercase alphanumeric plus . _ - (max 64 chars)`, 400, 'BAD_REQUEST');
  }
  if (input.state !== undefined && !FLAG_STATES.includes(input.state)) {
    throw new AuthError(`invalid state '${String(input.state)}' — one of on|off|killed`, 400, 'BAD_REQUEST');
  }
  if (input.rolloutPercent !== undefined) {
    const p = input.rolloutPercent;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 100) {
      throw new AuthError('rolloutPercent must be a number 0–100', 400, 'BAD_REQUEST');
    }
  }

  const existing = await getFlag(key);
  const next: FeatureFlag = {
    key,
    description: input.description ?? existing?.description,
    state: input.state ?? existing?.state ?? 'off',
    rolloutPercent: input.rolloutPercent ?? existing?.rolloutPercent ?? 0,
    overrides: existing?.overrides ?? [],
    updatedBy: input.updatedBy ?? existing?.updatedBy,
  };

  if (isConnected() && FeatureFlagModel) {
    const doc = await FeatureFlagModel.findOneAndUpdate(
      { key },
      { $set: { description: next.description, state: next.state, rolloutPercent: next.rolloutPercent, updatedBy: next.updatedBy } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean<IFeatureFlag>();
    invalidateCache();
    log.info({ key, state: next.state, rolloutPercent: next.rolloutPercent, updatedBy: next.updatedBy }, 'feature flag upserted');
    return toPlain(doc);
  }

  memoryStore.set(key, { ...next, createdAt: existing?.createdAt ?? new Date(), updatedAt: new Date() });
  invalidateCache();
  log.info({ key, state: next.state, rolloutPercent: next.rolloutPercent, source: 'memory' }, 'feature flag upserted');
  return toPlain(memoryStore.get(key)!);
}

/** Kill-switch: force the flag OFF for everyone, overrides included. */
export async function killFlag(key: string, updatedBy?: string): Promise<FeatureFlag> {
  const existing = await getFlag(key);
  if (!existing) throw new AuthError(`unknown flag '${key}'`, 404, 'NOT_FOUND');
  log.warn({ key, updatedBy }, 'feature flag KILLED — off for all tenants until explicitly revived');
  return upsertFlag({ key, state: 'killed', updatedBy });
}

/** Set (enabled boolean) or clear (enabled null) a per-tenant override. */
export async function setTenantOverride(key: string, tenantId: string, enabled: boolean | null, updatedBy?: string): Promise<FeatureFlag> {
  const tid = String(tenantId ?? '').trim();
  if (!tid) throw new AuthError('tenantId required', 400, 'BAD_REQUEST');
  const existing = await getFlag(key);
  if (!existing) throw new AuthError(`unknown flag '${key}'`, 404, 'NOT_FOUND');

  const overrides = existing.overrides.filter((o) => o.tenantId !== tid);
  if (enabled !== null) overrides.push({ tenantId: tid, enabled: Boolean(enabled) });

  if (isConnected() && FeatureFlagModel) {
    const doc = await FeatureFlagModel.findOneAndUpdate(
      { key },
      { $set: { overrides, updatedBy: updatedBy ?? existing.updatedBy } },
      { new: true },
    ).lean<IFeatureFlag>();
    invalidateCache();
    log.info({ key, tenantId: tid, enabled, updatedBy }, 'feature flag tenant override set');
    return toPlain(doc!);
  }

  const flag = memoryStore.get(key)!;
  flag.overrides = overrides;
  flag.updatedBy = updatedBy ?? flag.updatedBy;
  flag.updatedAt = new Date();
  invalidateCache();
  log.info({ key, tenantId: tid, enabled, source: 'memory' }, 'feature flag tenant override set');
  return toPlain(flag);
}

export async function deleteFlag(key: string): Promise<boolean> {
  if (isConnected() && FeatureFlagModel) {
    const result = await FeatureFlagModel.deleteOne({ key });
    invalidateCache();
    return result.deletedCount > 0;
  }
  const had = memoryStore.delete(key);
  invalidateCache();
  return had;
}

// ── Read helpers (the hot path — cached) ─────────────────────────

async function allFlagsCached(): Promise<FeatureFlag[]> {
  const now = Date.now();
  if (cachedFlags && now - cachedAt < CACHE_TTL_MS) return cachedFlags;
  cachedFlags = await listFlags();
  cachedAt = now;
  return cachedFlags;
}

/** Evaluated on/off map for one tenant — what `/api/flags/eval` returns and
 *  the dashboard/SDK consume. Unknown flags simply aren't present. */
export async function evaluateAllFlags(tenantId: string): Promise<Record<string, boolean>> {
  const flags = await allFlagsCached();
  const result: Record<string, boolean> = {};
  for (const flag of flags) result[flag.key] = evaluateFlag(flag, tenantId).enabled;
  return result;
}

/**
 * In-process typed read helper for gateway code gating its own features:
 *   if (await isFeatureEnabled('brain-v2-distiller', ctx.tenantId)) { ... }
 * Missing flags are OFF (`defaultValue` overridable) — a typo'd key can never
 * accidentally enable a dark feature.
 */
export async function isFeatureEnabled(key: string, tenantId: string, defaultValue = false): Promise<boolean> {
  const flags = await allFlagsCached();
  const flag = flags.find((f) => f.key === key);
  if (!flag) return defaultValue;
  return evaluateFlag(flag, tenantId).enabled;
}
