/**
 * Migration 005 — ADR-031 §2 DualWriteRetryItem index build + TenantDbBinding
 * reconciliation-field index sync.
 *
 * Additive schema change only, no backfill needed — DualWriteRetryItem is a
 * new, empty collection (nothing enqueues into it until ADR-030 §2's
 * dual-write dispatch lands; the reconciliation sweep in
 * `dual-write-reconciler.ts` is its first read/write consumer). This
 * migration just builds the collection's indexes (worker claim hot path,
 * cutover-gate depth check, sweep dedup lookup, resolved-item TTL) up front,
 * same as 004 did for the (also then-empty) TenantDbBinding collection.
 *
 * Also applied automatically and idempotently at gateway startup by
 * shared/migration-runner.ts (against the shared connection — no
 * connect/disconnect of its own). Manual/standalone run still works:
 *   docker exec myai-gateway node dist/shared/migrations/005-dual-write-retry-item.js
 * Or in dev:  npx tsx runtime/src/shared/migrations/005-dual-write-retry-item.ts
 */
import { DualWriteRetryItemModel, TenantDbBindingModel } from '../db.js';
import { getLogger } from '../logger.js';

/** Assumes an already-open DB connection (see module docstring). */
export async function migrate(): Promise<void> {
  const log = getLogger();

  try {
    await DualWriteRetryItemModel.syncIndexes();
    // lastReconciledAt/lastReconcileClean are plain fields (no index on
    // either), but re-syncing here keeps this migration the single place
    // that reconciles TenantDbBinding's index set after any additive change.
    await TenantDbBindingModel.syncIndexes();
    log.info('005: DualWriteRetryItem + TenantDbBinding indexes synced');
  } catch (err) {
    log.error({ err }, '005: syncIndexes failed (continuing)');
  }

  log.info('005-dual-write-retry-item complete');
}

// Run directly (node dist/.../005-dual-write-retry-item.js). Skipped when
// imported — owns its own connect/disconnect since nothing else in the
// process shares it.
const isMain = process.argv[1]?.includes('005-dual-write-retry-item');
if (isMain) {
  const { connectDB, disconnectDB } = await import('../db.js');
  connectDB()
    .then(migrate)
    .then(() => disconnectDB())
    .catch((err) => {
      getLogger().error({ err }, '005-dual-write-retry-item FAILED');
      process.exit(1);
    });
}
