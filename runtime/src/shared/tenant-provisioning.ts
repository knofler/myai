/**
 * tenant-provisioning — ADR-032 §1 provisioning automation (ADR-030 §3 step
 * 1), region-ordered per ADR-033.
 *
 * `provisionTenantIsolation(tenantId, tier, region?)` is the operator-invoked
 * entrypoint (§1.1) — not customer self-serve. It creates the
 * `TenantDbBinding` row with `status: 'provisioning'` and drives:
 *  - `dedicated-db` (§1.3): synchronous, same-cluster, completes inline.
 *  - `dedicated-cluster` (§1.4): kicks off `createCluster` and returns
 *    immediately — `tenant-provisioning-worker.ts` polls it to completion.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ REGION-FIRST SEQUENCING (ADR-033)                                        │
 * │                                                                           │
 * │   A tenant's `region` must be resolved before isolation-tier             │
 * │   provisioning runs. This module NEVER discovers or infers a region —    │
 * │   it consumes `Tenant.region` (the ADR-024 pin) as the default and only   │
 * │   accepts a differing `region` argument when the caller explicitly sets   │
 * │   `allowRegionOverride: true` (never silent, ADR-032 §1.1 / ADR-033 §3).  │
 * │   An accepted override updates `Tenant.region` itself — the two fields    │
 * │   must never end up disagreeing about a tenant's region.                  │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * §1.5 CRITICAL (enforced in `atlas-admin-client.ts`, not here): the Atlas
 * database user this module requests is scoped to exactly one `databaseName`
 * — see that file's header and `tests/unit/atlas-database-user-scope.test.ts`.
 */
import mongoose from 'mongoose';
import {
  TenantModel,
  TenantDbBindingModel,
  TaskModel,
  ScheduleModel,
  PlanDayModel,
  RepoCardModel,
  VectorModel,
  GatewaySessionModel,
  BudgetUsageModel,
  NotificationModel,
  redactMongoUri,
} from './db.js';
import type { TenantRegion, ITenantDbBinding } from './db.js';
import { getConfig } from './config.js';
import {
  createScopedDatabaseUser,
  createCluster,
  deleteCluster,
  deleteDatabaseUser,
} from './atlas-admin-client.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger({ module: 'tenant-provisioning' });

export type IsolationTier = 'dedicated-db' | 'dedicated-cluster';

// ── Region-first guard (ADR-033) ────────────────────────────────────────

export class RegionOverrideRequiredError extends Error {
  readonly tenantId: string;
  readonly existingRegion: TenantRegion;
  readonly requestedRegion: TenantRegion;
  constructor(tenantId: string, existingRegion: TenantRegion, requestedRegion: TenantRegion) {
    super(
      `provisionTenantIsolation: tenant '${tenantId}' is pinned to region '${existingRegion}' but ` +
        `'${requestedRegion}' was requested — pass { allowRegionOverride: true } to explicitly re-pin ` +
        `(ADR-033 §3: mismatch is an explicit operator override, never silent).`,
    );
    this.name = 'RegionOverrideRequiredError';
    this.tenantId = tenantId;
    this.existingRegion = existingRegion;
    this.requestedRegion = requestedRegion;
  }
}

/**
 * Resolves the region isolation-tier provisioning must use. Never infers a
 * region independently (ADR-033 decision, point 2): the existing `Tenant.region`
 * pin is the default; a differing `region` argument is only accepted with an
 * explicit `allowRegionOverride`.
 */
export function resolveProvisioningRegion(
  tenantId: string,
  existingRegion: TenantRegion,
  requestedRegion: TenantRegion | undefined,
  allowRegionOverride: boolean,
): TenantRegion {
  if (!requestedRegion || requestedRegion === existingRegion) {
    return existingRegion;
  }
  if (!allowRegionOverride) {
    throw new RegionOverrideRequiredError(tenantId, existingRegion, requestedRegion);
  }
  return requestedRegion;
}

// ── Shared naming / target helpers ──────────────────────────────────────

export function dbNameForTenant(tenantId: string): string {
  return `tenant_${tenantId}`;
}

export function usernameForTenant(tenantId: string): string {
  return `tenant_${tenantId}_user`;
}

export function atlasClusterNameForTenant(tenantId: string): string {
  return `tenant-${tenantId}`;
}

function requireAtlasProjectId(): string {
  const projectId = process.env.ATLAS_PROJECT_ID;
  if (!projectId) {
    throw new Error('tenant-provisioning: ATLAS_PROJECT_ID not configured');
  }
  return projectId;
}

function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw && raw.length > 0 ? raw : fallback;
}

/** ADR-032 §1.4 default: the entry-level dedicated-cluster instance size. */
export const DEFAULT_DEDICATED_CLUSTER_TIER = envString('ATLAS_DEDICATED_CLUSTER_TIER', 'M10');

/**
 * Builds the dedicated tenant's `mongoUri` from the host cluster's own
 * connection string + the freshly-scoped credential + `dbName` (§1.3 step 5 /
 * §1.4 step 2 "IDLE" branch). Never logged raw — callers must go through
 * `redactMongoUri()`, same posture as every other `mongoUri` write.
 */
export function buildDedicatedMongoUri(hostUri: string, username: string, password: string, dbName: string): string {
  const u = new URL(hostUri);
  u.username = encodeURIComponent(username);
  u.password = encodeURIComponent(password);
  u.pathname = `/${dbName}`;
  return u.toString();
}

// ── Scoped collection registry (ADR-010 §1.1's 8+ collections) — same set
// `dual-write-worker.ts` / `decommission-sweep.ts` already replay/delete
// against, reused verbatim rather than re-enumerated. ─────────────────────

const SCOPED_MODELS: mongoose.Model<any>[] = [
  TaskModel,
  ScheduleModel,
  PlanDayModel,
  RepoCardModel,
  VectorModel,
  GatewaySessionModel,
  BudgetUsageModel,
  NotificationModel,
];

/**
 * §1.3 step 4: create the required collections + indexes on the freshly
 * provisioned dedicated connection by reusing the *same* schema definitions
 * `db.ts` already exports for the shared-tier models — run once at provision
 * time instead of per-request (identical pattern to ADR-030 §2's per-tenant
 * model cache).
 */
export async function createScopedCollections(conn: mongoose.Connection): Promise<void> {
  for (const model of SCOPED_MODELS) {
    const scoped = conn.model(model.modelName, model.schema);
    await scoped.createCollection().catch(() => {}); // already-exists is fine (idempotent)
    await scoped.syncIndexes();
  }
}

// ── §1.6 readiness check ─────────────────────────────────────────────────

export interface ReadinessResult {
  ready: boolean;
  error?: string;
}

/**
 * Same shape both provisioning flows hand off through: connect via the new
 * `mongoUri` exactly as the runtime will, confirm every required collection
 * exists, then round-trip a throwaway document to confirm the scoped
 * credential actually has read+write on `dbName` — Atlas propagation of role
 * grants is occasionally eventually-consistent, so "the user object was
 * created" is not proof the grant is live yet (§1.6 step 3).
 */
export async function checkProvisioningReadiness(mongoUri: string, dbName: string): Promise<ReadinessResult> {
  let conn: mongoose.Connection | null = null;
  try {
    conn = await mongoose.createConnection(mongoUri, { dbName }).asPromise();
    for (const model of SCOPED_MODELS) {
      const exists = await conn.db!.listCollections({ name: model.collection.name }).hasNext();
      if (!exists) {
        return { ready: false, error: `missing collection '${model.collection.name}'` };
      }
    }
    const probe = conn.db!.collection('__provisioning_probe__');
    const insertResult = await probe.insertOne({ _probe: true, at: new Date() });
    const found = await probe.findOne({ _id: insertResult.insertedId });
    await probe.deleteOne({ _id: insertResult.insertedId });
    if (!found) {
      return { ready: false, error: 'round-trip insert/read-back failed' };
    }
    return { ready: true };
  } catch (err) {
    return { ready: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await conn?.close().catch(() => {});
  }
}

/**
 * Same exponential-with-cap SHAPE as ADR-031 §3's `dualWriteBackoffMs` /
 * ADR-032 §1.4's cluster-poll backoff, scaled down for a bounded *inline*
 * retry (§1.6 step 4) rather than a background poll — the dedicated-db flow
 * is a synchronous, "provisioned in seconds" operator call (§1.3), so this
 * retries a handful of times over single-digit seconds, not minutes.
 */
export function readinessRetryBackoffMs(attempt: number, baseMs = 500, capMs = 8_000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(capMs, exp);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runReadinessCheckWithRetry(
  mongoUri: string,
  dbName: string,
  maxAttempts = 5,
): Promise<ReadinessResult> {
  let last: ReadinessResult = { ready: false, error: 'not attempted' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    last = await checkProvisioningReadiness(mongoUri, dbName);
    if (last.ready) return last;
    if (attempt < maxAttempts) await sleep(readinessRetryBackoffMs(attempt));
  }
  return last;
}

/** ADR-032 §1.4's exponential-with-cap poll backoff (base 30s, cap 5min) —
 *  cluster creation is minutes not hours, so this caps far lower than the
 *  dual-write queue's 30min. Exported so `tenant-provisioning-worker.ts`
 *  reuses this exact shape rather than redefining it. */
export function clusterPollBackoffMs(attempt: number, baseMs = 30_000, capMs = 300_000): number {
  const exp = baseMs * 2 ** Math.max(0, attempt - 1);
  return Math.min(capMs, exp);
}

// ── Result types ──────────────────────────────────────────────────────────

export type ProvisionResult =
  | { outcome: 'migrating'; tenantId: string }
  | { outcome: 'provisioning'; tenantId: string; atlasClusterName: string }
  | { outcome: 'readiness-failed'; tenantId: string; error?: string };

// ── §1.3 dedicated-db — synchronous, same-cluster ───────────────────────

function assertGatewayServesRegion(region: TenantRegion): void {
  const gatewayRegion = getConfig().region.gatewayRegion;
  if (gatewayRegion && gatewayRegion !== region) {
    throw new Error(
      `provisionTenantIsolation: this gateway serves region '${gatewayRegion}' — 'dedicated-db' targets an ` +
        `existing shared cluster in the resolved region (ADR-032 §1.3 step 1), and region '${region}' is ` +
        `served by a different regional gateway deployment.`,
    );
  }
}

async function provisionDedicatedDb(tenantId: string, region: TenantRegion, now: Date): Promise<ProvisionResult> {
  assertGatewayServesRegion(region);
  const projectId = requireAtlasProjectId();
  const dbName = dbNameForTenant(tenantId);
  const username = usernameForTenant(tenantId);

  // Placeholder mongoUri (schema requires the field present, even though its
  // real value isn't known until the scoped credential exists a few lines
  // below) — overwritten before this function returns success, and the row
  // is deleted outright on any failure path (see catch below), so a stray
  // empty-string mongoUri is never observable outside this function.
  await TenantDbBindingModel.create({
    tenantId,
    isolationTier: 'dedicated-db',
    status: 'provisioning',
    mongoUri: '',
    dbName,
    provisionedAt: now,
  });

  try {
    const { password } = await createScopedDatabaseUser({ projectId, dbName, username });
    const mongoUri = buildDedicatedMongoUri(getConfig().database.uri, username, password, dbName);

    const conn = await mongoose.createConnection(mongoUri, { dbName }).asPromise();
    try {
      await createScopedCollections(conn);
    } finally {
      await conn.close().catch(() => {});
    }

    const readiness = await runReadinessCheckWithRetry(mongoUri, dbName);
    if (!readiness.ready) {
      // Persist the failure for operator visibility — status stays
      // 'provisioning' so a retry (or manual fix) can resume from here.
      await TenantDbBindingModel.updateOne(
        { tenantId },
        { $set: { mongoUri, 'provisioning.lastError': readiness.error, 'provisioning.attempts': 1, 'provisioning.requestedAt': now, 'provisioning.nextPollAt': now } },
      );

      // Diagnostic log — no live credential in this line, just the reason.
      log.error({ tenantId, error: readiness.error }, 'dedicated-db readiness check failed — leaving binding in provisioning for operator retry');
      return { outcome: 'readiness-failed', tenantId, error: readiness.error };
    }

    // §1.6 step 5: flip provisioning -> migrating. Not manual, not
    // time-based — gated purely on the readiness check passing.
    await TenantDbBindingModel.updateOne(
      { tenantId },
      { $set: { mongoUri, status: 'migrating' }, $unset: { provisioning: 1 } },
    );
    await TenantModel.updateOne({ tenantId }, { $set: { isolationTier: 'dedicated-db' } });

    log.info({ tenantId, dbName, mongoUri: redactMongoUri(mongoUri) }, 'dedicated-db provisioning complete — provisioning -> migrating');
    return { outcome: 'migrating', tenantId };
  } catch (err) {
    log.error({ tenantId, err }, 'dedicated-db provisioning failed — rolling back the binding row');
    await TenantDbBindingModel.deleteOne({ tenantId }).catch(() => {});
    throw err;
  }
}

// ── §1.4 dedicated-cluster — asynchronous, polled ───────────────────────

async function provisionDedicatedCluster(tenantId: string, region: TenantRegion, now: Date): Promise<ProvisionResult> {
  const projectId = requireAtlasProjectId();
  const dbName = dbNameForTenant(tenantId);
  const clusterName = atlasClusterNameForTenant(tenantId);

  await TenantDbBindingModel.create({
    tenantId,
    isolationTier: 'dedicated-cluster',
    status: 'provisioning',
    mongoUri: '', // unknown until the cluster is IDLE and a credential exists — see db.ts field comment
    dbName,
    atlasProjectId: projectId,
    atlasClusterName: clusterName,
    provisioning: { requestedAt: now, attempts: 0, nextPollAt: now },
    provisionedAt: now,
  });

  await createCluster({ projectId, clusterName, region, tier: DEFAULT_DEDICATED_CLUSTER_TIER });
  await TenantModel.updateOne({ tenantId }, { $set: { isolationTier: 'dedicated-cluster' } });

  log.info(
    { tenantId, clusterName, region },
    'dedicated-cluster provisioning kicked off — tenant-provisioning-worker.ts polls it to completion',
  );
  return { outcome: 'provisioning', tenantId, atlasClusterName: clusterName };
}

// ── §1.1 entrypoint ───────────────────────────────────────────────────────

export interface ProvisionTenantIsolationOptions {
  /** ADR-033 §3 — required to accept a `region` that differs from the
   *  tenant's existing ADR-024 pin. Never defaults to true. */
  allowRegionOverride?: boolean;
  /** Injectable clock for deterministic tests. */
  now?: Date;
}

export async function provisionTenantIsolation(
  tenantId: string,
  tier: IsolationTier,
  region?: TenantRegion,
  opts: ProvisionTenantIsolationOptions = {},
): Promise<ProvisionResult> {
  const now = opts.now ?? new Date();

  const tenant = await TenantModel.findOne({ tenantId }).lean();
  if (!tenant) {
    throw new Error(`provisionTenantIsolation: no such tenant '${tenantId}'`);
  }

  const existingBinding = await TenantDbBindingModel.findOne({ tenantId }).lean();
  if (existingBinding) {
    throw new Error(
      `provisionTenantIsolation: tenant '${tenantId}' already has a TenantDbBinding (status='${existingBinding.status}')`,
    );
  }

  // ADR-033 region-first sequencing: resolve BEFORE any isolation-tier call.
  const resolvedRegion = resolveProvisioningRegion(tenantId, tenant.region as TenantRegion, region, opts.allowRegionOverride ?? false);
  if (resolvedRegion !== tenant.region) {
    // §3: the override updates Tenant.region itself — the two fields must
    // never end up disagreeing about a tenant's region.
    await TenantModel.updateOne({ tenantId }, { $set: { region: resolvedRegion } });
    log.info({ tenantId, from: tenant.region, to: resolvedRegion }, 'Operator region override applied to Tenant.region (ADR-033 §3)');
  }

  if (tier === 'dedicated-db') {
    return provisionDedicatedDb(tenantId, resolvedRegion, now);
  }
  return provisionDedicatedCluster(tenantId, resolvedRegion, now);
}

// ── §1.7 provisioning rollback / teardown ───────────────────────────────

/**
 * Mirror image of the creation flows above, in reverse — reuses the same
 * Atlas client functions. Called when a migration aborts back to `shared`
 * before decommission (ADR-030 §3's rollback guarantee): the dedicated
 * infrastructure this module provisioned must not be left running (cost, and
 * a stale unused credential is itself an attack surface).
 *
 * `dedicated-db`: no separate teardown call for the created database — it
 * never held authoritative data past a `suspended` binding (§1.6 gates that),
 * dropping it is a single safe `db.dropDatabase()` left to a future decision,
 * not performed here (§1.7 verbatim).
 */
export async function teardownTenantProvisioning(tenantId: string): Promise<void> {
  const binding = await TenantDbBindingModel.findOne({ tenantId }).lean() as (ITenantDbBinding & { _id: unknown }) | null;
  if (!binding) {
    log.info({ tenantId }, 'teardownTenantProvisioning: no binding — nothing to tear down');
    return;
  }

  const projectId = binding.atlasProjectId ?? requireAtlasProjectId();
  const username = usernameForTenant(tenantId);

  await deleteDatabaseUser(projectId, username);
  if (binding.isolationTier === 'dedicated-cluster' && binding.atlasClusterName) {
    await deleteCluster(projectId, binding.atlasClusterName);
  }

  await TenantDbBindingModel.deleteOne({ tenantId });
  await TenantModel.updateOne({ tenantId }, { $set: { isolationTier: 'shared' } });

  log.info({ tenantId, isolationTier: binding.isolationTier }, 'Tenant provisioning torn down — reverted to shared');
}
