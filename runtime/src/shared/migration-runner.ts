/**
 * Idempotent startup migration runner (deploy self-heal).
 *
 * Runs every registered migration, in order, against the gateway's already-
 * open DB connection — never re-running one that already succeeded (tracked
 * via MigrationRecordModel) and never running a later migration on top of an
 * earlier one that failed. /readyz gates on getMigrationStatus().allApplied
 * so a redeploy never serves traffic mid-migration or after a half-applied
 * one — the pod simply never goes ready until the migration is fixed.
 */
import { isConnected, MigrationRecordModel } from './db.js';
import { createChildLogger } from './logger.js';
import { migrate as migrateTenantScoping } from './migrations/001-tenant-scoping.js';
import { migrate as migrateRbacUserRole } from './migrations/002-rbac-user-role.js';
import { migrate as migrateTenantRegion } from './migrations/003-tenant-region.js';
import { migrate as migrateTenantDbBinding } from './migrations/004-tenant-db-binding.js';

const log = createChildLogger({ module: 'migration-runner' });

interface MigrationDef {
  id: string;
  run: () => Promise<void>;
}

// Ordered — append new migrations here, never reorder or remove a completed
// entry (its id is the applied-state key in MigrationRecordModel).
const MIGRATIONS: MigrationDef[] = [
  { id: '001-tenant-scoping', run: migrateTenantScoping },
  { id: '002-rbac-user-role', run: migrateRbacUserRole },
  { id: '003-tenant-region', run: migrateTenantRegion },
  { id: '004-tenant-db-binding', run: migrateTenantDbBinding },
];

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  allApplied: boolean;
  lastError: string | null;
}

let status: MigrationStatus = {
  applied: [],
  pending: MIGRATIONS.map((m) => m.id),
  allApplied: false,
  lastError: null,
};

export async function runMigrations(): Promise<MigrationStatus> {
  if (!isConnected()) {
    status = { applied: [], pending: MIGRATIONS.map((m) => m.id), allApplied: false, lastError: 'MongoDB not connected' };
    return status;
  }

  const applied: string[] = [];
  const pending: string[] = [];
  let lastError: string | null = null;
  let halted = false;

  for (const migration of MIGRATIONS) {
    if (halted) {
      pending.push(migration.id);
      continue;
    }

    const existing = await MigrationRecordModel.findOne({ migrationId: migration.id }).lean();
    if (existing) {
      applied.push(migration.id);
      continue;
    }

    try {
      log.info({ migrationId: migration.id }, 'Running startup migration');
      await migration.run();
      await MigrationRecordModel.updateOne(
        { migrationId: migration.id },
        { $setOnInsert: { migrationId: migration.id, appliedAt: new Date() } },
        { upsert: true },
      );
      applied.push(migration.id);
      log.info({ migrationId: migration.id }, 'Startup migration applied');
    } catch (err) {
      lastError = `${migration.id}: ${(err as Error).message}`;
      log.error({ migrationId: migration.id, err }, 'Startup migration failed — halting remaining migrations');
      pending.push(migration.id);
      halted = true;
    }
  }

  status = { applied, pending, allApplied: pending.length === 0, lastError };
  return status;
}

export function getMigrationStatus(): MigrationStatus {
  return status;
}
