/**
 * Migration 001 — multi-tenant scoping (ADR-010, M1 Day 2).
 *
 * Idempotent. Safe to re-run — every step is self-gating:
 *  1. Upsert the `default` Tenant (keyed on tenantId → no E11000 on re-run).
 *  2. Backfill `tenantId = DEFAULT_TENANT_ID` on every existing scoped record
 *     that is missing it (re-runs match zero docs).
 *  3. syncIndexes() on each scoped model — drops the old non-tenant unique
 *     indexes ({repo,day}, {repo,source,contentHash}, repoName) and builds the
 *     new tenant-prefixed ones declared in db.ts. Run AFTER the backfill so no
 *     row has a null tenantId when the new unique indexes build.
 *
 * Also applied automatically and idempotently at gateway startup by
 * shared/migration-runner.ts (against the shared connection — no
 * connect/disconnect of its own). Manual/standalone run still works:
 *   docker exec myai-gateway node dist/shared/migrations/001-tenant-scoping.js
 * Or in dev:  npx tsx runtime/src/shared/migrations/001-tenant-scoping.ts
 */
import {
  DEFAULT_TENANT_ID,
  TenantModel, TaskModel, ScheduleModel, RepoCardModel, PlanDayModel,
  GatewaySessionModel, BudgetUsageModel, NotificationModel, VectorModel,
} from '../db.js';
import { getLogger } from '../logger.js';

/** Assumes an already-open DB connection (see module docstring). */
export async function migrate(): Promise<void> {
  const log = getLogger();

  // 1. Ensure the default Tenant exists. apiKeyHash/apiKeyPrefix are
  //    placeholders — the auth-layer key-provisioning flow rotates a real key.
  await TenantModel.updateOne(
    { tenantId: DEFAULT_TENANT_ID },
    {
      $setOnInsert: {
        tenantId: DEFAULT_TENANT_ID,
        name: 'Default (single-operator)',
        apiKeyHash: 'MIGRATION_PLACEHOLDER',
        apiKeyPrefix: 'myai_default',
        plan: 'scale',
        status: 'active',
        metadata: { seededBy: '001-tenant-scoping' },
      },
    },
    { upsert: true },
  );
  log.info({ tenantId: DEFAULT_TENANT_ID }, '001: default tenant ensured');

  // 2. Backfill tenantId on existing scoped records. Filter only touches docs
  //    that don't yet have the field → re-runs match nothing.
  const unset = { tenantId: { $in: [null, undefined] } };
  const scoped: Array<[string, { updateMany: Function }]> = [
    ['tasks', TaskModel],
    ['schedules', ScheduleModel],
    ['repocards', RepoCardModel],
    ['plandays', PlanDayModel],
    ['gatewaysessions', GatewaySessionModel],
    ['budgetusage', BudgetUsageModel],
    ['notifications', NotificationModel],
    ['vectors', VectorModel],
  ];

  for (const [label, model] of scoped) {
    const res = await model.updateMany(unset as never, { $set: { tenantId: DEFAULT_TENANT_ID } });
    log.info({ label, matched: res.matchedCount, modified: res.modifiedCount }, '001: backfilled tenantId');
  }

  // 3. Reconcile indexes — drop old non-tenant unique indexes, build new ones.
  //    Done last so the new unique indexes never see a null tenantId.
  const indexed: Array<[string, { syncIndexes: Function }]> = [
    ['tasks', TaskModel],
    ['schedules', ScheduleModel],
    ['repocards', RepoCardModel],
    ['plandays', PlanDayModel],
    ['gatewaysessions', GatewaySessionModel],
    ['budgetusage', BudgetUsageModel],
    ['notifications', NotificationModel],
    ['vectors', VectorModel],
    ['tenants', TenantModel],
  ];

  for (const [label, model] of indexed) {
    try {
      await model.syncIndexes();
      log.info({ label }, '001: indexes synced');
    } catch (err) {
      log.error({ label, err }, '001: syncIndexes failed (continuing)');
    }
  }

  log.info('001-tenant-scoping complete');
}

// Run directly (node dist/.../001-tenant-scoping.js). Skipped when imported —
// owns its own connect/disconnect since nothing else in the process shares it.
const isMain = process.argv[1]?.includes('001-tenant-scoping');
if (isMain) {
  const { connectDB, disconnectDB } = await import('../db.js');
  connectDB()
    .then(migrate)
    .then(() => disconnectDB())
    .catch((err) => {
      getLogger().error({ err }, '001-tenant-scoping FAILED');
      process.exit(1);
    });
}
