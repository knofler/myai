/**
 * Migration 006 — Task.reviewEnteredAt backfill (PR #479 follow-up).
 *
 * worker-lane-status.ts's executionFinishedAt() used to count a task held in
 * `review` at `updatedAt` — but the reconciler re-touches review tasks on
 * every pass, bumping `updatedAt` and re-counting the same execution in
 * executions24h every day it sat there. task-store.ts's updateTaskImpl now
 * stamps `reviewEnteredAt` once, on the actual pending/working → 'review'
 * transition, and executionFinishedAt() counts off that instead.
 *
 * Idempotent — the only step backfills `reviewEnteredAt` from `updatedAt` on
 * existing `review` rows that don't have it yet (pre-field rows); the filter
 * excludes anything already backfilled, so re-runs match zero docs. New rows
 * never need this — updateTaskImpl stamps them going forward.
 *
 * Also applied automatically and idempotently at gateway startup by
 * shared/migration-runner.ts (against the shared connection — no
 * connect/disconnect of its own). Manual/standalone run still works:
 *   docker exec myai-gateway node dist/shared/migrations/006-task-review-entered-at.js
 * Or in dev:  npx tsx runtime/src/shared/migrations/006-task-review-entered-at.ts
 */
import { TaskModel } from '../db.js';
import { getLogger } from '../logger.js';

/** Assumes an already-open DB connection (see module docstring). */
export async function migrate(): Promise<void> {
  const log = getLogger();

  // Backfill reviewEnteredAt = updatedAt on existing review rows missing it.
  // Pipeline update (not a literal $set) since the value is copied from
  // another field on the same doc, per doc.
  const backfill = await TaskModel.updateMany(
    { status: 'review', reviewEnteredAt: { $in: [null, undefined] } } as never,
    [{ $set: { reviewEnteredAt: '$updatedAt' } }] as never,
  );
  log.info(
    { matched: backfill.matchedCount, modified: backfill.modifiedCount },
    '006: backfilled Task.reviewEnteredAt from updatedAt for existing review rows',
  );

  try {
    await TaskModel.syncIndexes();
    log.info('006: Task indexes synced');
  } catch (err) {
    log.error({ err }, '006: syncIndexes failed (continuing)');
  }

  log.info('006-task-review-entered-at complete');
}

// Run directly (node dist/.../006-task-review-entered-at.js). Skipped when
// imported — owns its own connect/disconnect since nothing else in the
// process shares it.
const isMain = process.argv[1]?.includes('006-task-review-entered-at');
if (isMain) {
  const { connectDB, disconnectDB } = await import('../db.js');
  connectDB()
    .then(migrate)
    .then(() => disconnectDB())
    .catch((err) => {
      getLogger().error({ err }, '006-task-review-entered-at FAILED');
      process.exit(1);
    });
}
