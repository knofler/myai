/**
 * Migration 004 — ADR-030 §4 isolationTier backfill + TenantDbBinding index build.
 *
 * Additive schema change only — data-model slice, zero behavior change.
 * Nothing reads `Tenant.isolationTier` yet (that's the getConnectionForTenant
 * chokepoint, a separate queued follow-up); TenantDbBinding stays empty until
 * the Phase-3 enterprise tier is actually sold. Idempotent — safe to re-run:
 *  1. Backfill `isolationTier = 'shared'` on every existing Tenant missing the
 *     field (a pre-ADR-030 row). Matches the schema default (`db.ts`
 *     tenantSchema) so new rows are already correct; this only heals rows
 *     written before the field existed. Re-runs match zero docs.
 *  2. syncIndexes() on Tenant (new `isolationTier` index) and TenantDbBinding
 *     (new collection — `tenantId` unique index, `status` index).
 *
 * Also applied automatically and idempotently at gateway startup by
 * shared/migration-runner.ts (against the shared connection — no
 * connect/disconnect of its own). Manual/standalone run still works:
 *   docker exec myai-gateway node dist/shared/migrations/004-tenant-db-binding.js
 * Or in dev:  npx tsx runtime/src/shared/migrations/004-tenant-db-binding.ts
 */
import { TenantModel, TenantDbBindingModel } from '../db.js';
import { getLogger } from '../logger.js';

/** Assumes an already-open DB connection (see module docstring). */
export async function migrate(): Promise<void> {
  const log = getLogger();

  // 1. Backfill isolationTier on pre-ADR-030 Tenant rows. Filter only touches
  //    docs missing the field → re-runs match nothing, no data loss.
  const missingIsolationTier = { isolationTier: { $in: [null, undefined] } };
  const backfill = await TenantModel.updateMany(
    missingIsolationTier as never,
    { $set: { isolationTier: 'shared' } },
  );
  log.info(
    { matched: backfill.matchedCount, modified: backfill.modifiedCount },
    '004: backfilled Tenant.isolationTier = shared',
  );

  // 2. Reconcile indexes — Tenant's new `isolationTier` index, and build the
  //    (currently empty) TenantDbBinding collection's indexes up front.
  try {
    await TenantModel.syncIndexes();
    await TenantDbBindingModel.syncIndexes();
    log.info('004: Tenant + TenantDbBinding indexes synced');
  } catch (err) {
    log.error({ err }, '004: syncIndexes failed (continuing)');
  }

  log.info('004-tenant-db-binding complete');
}

// Run directly (node dist/.../004-tenant-db-binding.js). Skipped when
// imported — owns its own connect/disconnect since nothing else in the
// process shares it.
const isMain = process.argv[1]?.includes('004-tenant-db-binding');
if (isMain) {
  const { connectDB, disconnectDB } = await import('../db.js');
  connectDB()
    .then(migrate)
    .then(() => disconnectDB())
    .catch((err) => {
      getLogger().error({ err }, '004-tenant-db-binding FAILED');
      process.exit(1);
    });
}
