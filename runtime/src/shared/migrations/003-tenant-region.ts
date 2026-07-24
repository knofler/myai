/**
 * Migration 003 — data-residency region backfill (ADR-023).
 *
 * Idempotent. Safe to re-run — every step is self-gating:
 *  1. Backfill `region = 'us'` on every existing Tenant missing the field (a
 *     pre-ADR-023 row). Matches the schema default (`db.ts` tenantSchema) so
 *     new rows are already correct; this only heals rows written before the
 *     field existed. 'us' is the only defensible backfill value — every
 *     tenant that signed up before region pinning existed was, in effect,
 *     served by the single (US-hosted) MVP deployment. Re-runs match zero docs.
 *  2. syncIndexes() on Tenant — builds the new `region` index (no-op unless
 *     indexes drifted).
 *
 * Also applied automatically and idempotently at gateway startup by
 * shared/migration-runner.ts (against the shared connection — no
 * connect/disconnect of its own). Manual/standalone run still works:
 *   docker exec myai-gateway node dist/shared/migrations/003-tenant-region.js
 * Or in dev:  npx tsx runtime/src/shared/migrations/003-tenant-region.ts
 */
import { TenantModel } from '../db.js';
import { getLogger } from '../logger.js';

/** Assumes an already-open DB connection (see module docstring). */
export async function migrate(): Promise<void> {
  const log = getLogger();

  // 1. Backfill region on pre-ADR-023 Tenant rows. Filter only touches docs
  //    missing the field → re-runs match nothing.
  const missingRegion = { region: { $in: [null, undefined] } };
  const backfill = await TenantModel.updateMany(
    missingRegion as never,
    { $set: { region: 'us' } },
  );
  log.info(
    { matched: backfill.matchedCount, modified: backfill.modifiedCount },
    '003: backfilled Tenant.region = us',
  );

  // 2. Reconcile indexes (builds the new `region` index; no-op unless drifted).
  try {
    await TenantModel.syncIndexes();
    log.info('003: Tenant indexes synced');
  } catch (err) {
    log.error({ err }, '003: syncIndexes failed (continuing)');
  }

  log.info('003-tenant-region complete');
}

// Run directly (node dist/.../003-tenant-region.js). Skipped when imported —
// owns its own connect/disconnect since nothing else in the process shares it.
const isMain = process.argv[1]?.includes('003-tenant-region');
if (isMain) {
  const { connectDB, disconnectDB } = await import('../db.js');
  connectDB()
    .then(migrate)
    .then(() => disconnectDB())
    .catch((err) => {
      getLogger().error({ err }, '003-tenant-region FAILED');
      process.exit(1);
    });
}
