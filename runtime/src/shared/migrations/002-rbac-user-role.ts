/**
 * Migration 002 — RBAC v1 user roles (ADR-013 slice 1).
 *
 * Idempotent. Safe to re-run — every step is self-gating:
 *  1. Backfill `role = 'member'` on every existing User missing a role (a
 *     pre-RBAC row). Matches the schema default (`db.ts` userSchema) so new
 *     rows are already correct; this only heals rows written before the field
 *     existed. Re-runs match zero docs.
 *  2. Promote the tenant's original signup user to `owner` where a tenant has
 *     NO owner yet — pre-RBAC single-operator tenants otherwise have no one who
 *     can manage members/billing. Picks the earliest-created User per tenant.
 *     Self-gating: skipped for any tenant that already has ≥1 owner.
 *  3. syncIndexes() on User — no-op unless indexes drifted.
 *
 * Also applied automatically and idempotently at gateway startup by
 * shared/migration-runner.ts (against the shared connection — no
 * connect/disconnect of its own). Manual/standalone run still works:
 *   docker exec myai-gateway node dist/shared/migrations/002-rbac-user-role.js
 * Or in dev:  npx tsx runtime/src/shared/migrations/002-rbac-user-role.ts
 */
import { UserModel } from '../db.js';
import type { IUser } from '../db.js';
import { getLogger } from '../logger.js';

/** Assumes an already-open DB connection (see module docstring). */
export async function migrate(): Promise<void> {
  const log = getLogger();

  // 1. Backfill role on pre-RBAC User rows. Filter only touches docs missing a
  //    role → re-runs match nothing.
  const missingRole = { role: { $in: [null, undefined] } };
  const backfill = await UserModel.updateMany(
    missingRole as never,
    { $set: { role: 'member' } },
  );
  log.info(
    { matched: backfill.matchedCount, modified: backfill.modifiedCount },
    '002: backfilled User.role = member',
  );

  // 2. Ensure every tenant has an owner. Group existing users by tenant, and for
  //    any tenant with no owner, promote its earliest-created user. Idempotent:
  //    tenants that already have an owner are skipped.
  const tenantsWithOwner = new Set<string>(
    (await UserModel.distinct('tenantId', { role: 'owner' })) as string[],
  );
  const allTenants = (await UserModel.distinct('tenantId')) as string[];
  let promoted = 0;
  for (const tenantId of allTenants) {
    if (tenantsWithOwner.has(tenantId)) continue;
    const first = await UserModel.findOne({ tenantId })
      .sort({ createdAt: 1 })
      .lean<IUser>();
    if (!first) continue;
    await UserModel.updateOne({ userId: first.userId }, { $set: { role: 'owner' } });
    promoted += 1;
    log.info({ tenantId, userId: first.userId }, '002: promoted earliest user to owner');
  }
  log.info({ tenantsWithoutOwner: promoted }, '002: owner backfill complete');

  // 3. Reconcile indexes (no-op unless drifted).
  try {
    await UserModel.syncIndexes();
    log.info('002: User indexes synced');
  } catch (err) {
    log.error({ err }, '002: syncIndexes failed (continuing)');
  }

  log.info('002-rbac-user-role complete');
}

// Run directly (node dist/.../002-rbac-user-role.js). Skipped when imported —
// owns its own connect/disconnect since nothing else in the process shares it.
const isMain = process.argv[1]?.includes('002-rbac-user-role');
if (isMain) {
  const { connectDB, disconnectDB } = await import('../db.js');
  connectDB()
    .then(migrate)
    .then(() => disconnectDB())
    .catch((err) => {
      getLogger().error({ err }, '002-rbac-user-role FAILED');
      process.exit(1);
    });
}
