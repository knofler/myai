/**
 * ADR-029 §5 — the `staging/` TTL sweep. Only unreviewed (or already-
 * promoted-and-left-behind, per §5's last retention-table row) bytes under
 * `staging/` are ever swept; `published/` is retained indefinitely per
 * ADR-019's lifecycle grandfather clauses and this sweep never touches it —
 * it only ever enumerates and deletes keys under the `staging` stage.
 * Implementation checklist item #4.
 *
 * Not wired to an automatic in-process cron — an operator/cron invokes this
 * on a daily cadence, same posture as `scheduler/quota-reset-sweep.ts` and
 * `core/account-erasure.ts`'s `runErasureSweep`. Each object is handled
 * independently — a delete failure on one never blocks the rest (mirrors
 * `runQuotaResetSweep`'s per-tenant isolation).
 */
import { LocalFilesystemArtifactStore, type ArtifactStore } from '../marketplace/artifact-store.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'marketplace-staging-sweep' });

/**
 * ADR-029 §5: "TTL 30 days from upload" for a fresh submission's staging
 * bytes, and — per the retention table's last row — the SAME TTL for the
 * copy left behind in `staging/` after an `approved → published` promotion
 * ("TTL 30 days from promotion, same sweep"). One rule covers both rows: age
 * is measured from the object's own last-write time (`mtimeMs`), which is
 * set fresh by whichever write produced it (initial upload, or promotion's
 * copy) — the sweep doesn't need to distinguish the two cases.
 */
export const STAGING_TTL_DAYS = 30;

/** `MARKETPLACE_STAGING_TTL_DAYS` env override (days) for ops tuning; falls
 *  back to {@link STAGING_TTL_DAYS} on an unset/invalid value. */
function stagingTtlMs(env: NodeJS.ProcessEnv): number {
  const raw = env.MARKETPLACE_STAGING_TTL_DAYS;
  const days = raw !== undefined && raw.trim() !== '' && Number.isFinite(Number(raw)) && Number(raw) > 0
    ? Number(raw)
    : STAGING_TTL_DAYS;
  return days * 24 * 60 * 60 * 1000;
}

export interface StagingSweepResult {
  ranAt: Date;
  ttlDays: number;
  dryRun: boolean;
  scanned: number;
  deleted: string[];  // keys removed (or, in dryRun, keys that WOULD be removed)
  retained: string[]; // keys still within TTL
  failed: Array<{ key: string; error: string }>;
}

export interface StagingSweepOptions {
  now?: Date;
  /** Report what would be deleted without touching the store — the mode a
   *  scheduled verification run (and this module's own tests) exercise
   *  before trusting the sweep with real deletes. */
  dryRun?: boolean;
  artifactStore?: ArtifactStore;
  env?: NodeJS.ProcessEnv;
}

/**
 * Sweep every object under the `staging/` stage; delete (or, in `dryRun`
 * mode, report) anything older than the TTL. `published/` is never
 * enumerated or touched — the sweep only ever calls `listStage('staging')`.
 */
export async function runMarketplaceStagingSweep(opts: StagingSweepOptions = {}): Promise<StagingSweepResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const env = opts.env ?? process.env;
  const artifactStore = opts.artifactStore ?? new LocalFilesystemArtifactStore(env);
  const ttlMs = stagingTtlMs(env);

  const result: StagingSweepResult = {
    ranAt: now,
    ttlDays: ttlMs / (24 * 60 * 60 * 1000),
    dryRun,
    scanned: 0,
    deleted: [],
    retained: [],
    failed: [],
  };

  const entries = await artifactStore.listStage('staging');
  result.scanned = entries.length;

  for (const entry of entries) {
    const ageMs = now.getTime() - entry.mtimeMs;
    if (ageMs < ttlMs) {
      result.retained.push(entry.key);
      continue;
    }
    if (dryRun) {
      result.deleted.push(entry.key);
      continue;
    }
    try {
      await artifactStore.delete(entry.key);
      result.deleted.push(entry.key);
    } catch (err) {
      log.error({ err, key: entry.key }, 'marketplace-staging-sweep: delete failed');
      result.failed.push({ key: entry.key, error: (err as Error).message });
    }
  }

  log.info(
    {
      scanned: result.scanned,
      deleted: result.deleted.length,
      retained: result.retained.length,
      failed: result.failed.length,
      dryRun,
    },
    'marketplace-staging-sweep: complete',
  );
  return result;
}
