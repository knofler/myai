/**
 * decommission-sweep — ADR-032 §3 decommission mechanics (ADR-030 §3 step 4,
 * second half).
 *
 * Same `setInterval` lifecycle shape as `dual-write-reconciler.ts`'s sweep /
 * `dual-write-worker.ts`'s drain, but slow and low-urgency (daily, not
 * every-15-minutes) — this is bounded cleanup, not a data-loss watch.
 *
 * For every `TenantDbBinding` at `status === 'active'` whose `migratedAt` is
 * older than the retention window (§3.2 step 1):
 *
 *  1. Re-runs a row-count check (`checkRowCountsMatch`, reused verbatim from
 *     `dual-write-reconciler.ts` — ADR-032's own instruction, not reinvented
 *     here) **immediately** before deleting anything (§3.2 step 2, HIGH).
 *     Time-based eligibility plus "nothing could have changed" is not an
 *     acceptable substitute for re-verifying right before an irreversible
 *     bulk delete — see the ADR's severity flag.
 *  2. On a clean check, bulk-deletes that tenant's rows from every scoped
 *     collection, then flips `status: 'active' -> 'decommissioned'` and
 *     stamps `decommissionedAt` (§3.2 step 3 / §3.3).
 *  3. On a mismatch, skips that tenant THIS CYCLE and alerts — never
 *     deletes against a check that didn't pass clean (§3.2 step 2).
 *
 * Irreversible by design (§3.4): once shared-tier rows for a tenant are
 * dropped there is nothing left to roll back to. `dryRun: true` computes
 * exactly what a real run would do — mismatches, would-delete counts —
 * without deleting anything or touching `status`, so this sweep can be
 * exercised against real data before it is ever run for real.
 */
import type { Model } from 'mongoose';
import {
  TenantDbBindingModel,
  TaskModel,
  ScheduleModel,
  PlanDayModel,
  RepoCardModel,
  VectorModel,
  GatewaySessionModel,
  BudgetUsageModel,
  NotificationModel,
  isConnected,
} from './db.js';
import type { ITenantDbBinding } from './db.js';
import { scopedDeleteMany, scopedCountDocuments } from './scoped-query.js';
import { checkRowCountsMatch } from './dual-write-reconciler.js';
import type { RowCountCheckResult } from './dual-write-reconciler.js';
import { createChildLogger } from './logger.js';
import { getAdapter } from '../channels/registry.js';

const log = createChildLogger({ module: 'decommission-sweep' });

function envPositiveNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** ADR-032 §3.2 step 1 default: 30 days — fixed and documented, per ADR-030
 *  §3 step 4's own instruction ("a fixed, documented number of days, not
 *  'forever' or 'immediately'"). */
export const DEFAULT_DECOMMISSION_RETENTION_DAYS = envPositiveNumber('DEDICATED_TENANT_DECOMMISSION_DAYS', 30);

/** ADR-032 §3.2 default: 24h — slow cleanup, unlike the 15-minute
 *  reconciliation sweep watching for active data-loss risk. */
export const DEFAULT_SWEEP_INTERVAL_HOURS = envPositiveNumber('DECOMMISSION_SWEEP_INTERVAL_HOURS', 24);

/** `mongoUri` is `select: false` on the schema — the row-count check needs it
 *  to open the dedicated connection, so every binding read here opts back in
 *  with `.select('+mongoUri')`. */
type BindingWithConnStr = ITenantDbBinding & { mongoUri: string };

// ── Scoped-collection registry (ADR-010 §1.1's 8 scoped collections) ───────
interface DecommissionTarget {
  label: string;
  model: Model<any>;
}

const TARGETS: DecommissionTarget[] = [
  { label: 'tasks', model: TaskModel },
  { label: 'schedules', model: ScheduleModel },
  { label: 'planDays', model: PlanDayModel },
  { label: 'repoCards', model: RepoCardModel },
  { label: 'vectors', model: VectorModel },
  { label: 'gatewaySessions', model: GatewaySessionModel },
  { label: 'budgetUsage', model: BudgetUsageModel },
  { label: 'notifications', model: NotificationModel },
];

export type TenantDecommissionOutcome =
  | { tenantId: string; action: 'decommissioned'; deletedCounts: Record<string, number> }
  | { tenantId: string; action: 'skipped-row-count-mismatch'; mismatches: RowCountCheckResult['mismatches'] }
  | { tenantId: string; action: 'dry-run-would-decommission'; wouldDelete: Record<string, number> }
  | { tenantId: string; action: 'dry-run-would-skip-row-count-mismatch'; mismatches: RowCountCheckResult['mismatches'] };

async function alertMismatch(tenantId: string, mismatches: RowCountCheckResult['mismatches']): Promise<void> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) return;
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) return;

  const message = [
    `\u{1F6A8} Decommission sweep skipped tenant ${tenantId} — row-count mismatch immediately before delete`,
    `Collections: ${mismatches.map(m => `${m.label} (shared=${m.sharedCount}, dedicated=${m.dedicatedCount})`).join(', ')}`,
    'HIGH (ADR-032 §3.2 step 2): eligibility was already gated on status===active and elapsed time, but that is not trusted alone before an irreversible bulk delete. Skipped this tenant this cycle rather than deleting.',
  ].join('\n');

  try {
    await telegram.send(chatId, message);
  } catch (err) {
    log.error({ tenantId, err }, 'Failed to send decommission mismatch alert');
  }
}

async function sweepOneTenant(binding: BindingWithConnStr, dryRun: boolean): Promise<TenantDecommissionOutcome> {
  const { matches, mismatches } = await checkRowCountsMatch(binding.tenantId, binding);

  if (!matches) {
    log.warn(
      { tenantId: binding.tenantId, mismatches, dryRun },
      'Decommission sweep: row-count mismatch immediately before delete — skipping tenant this cycle',
    );
    if (!dryRun) {
      await alertMismatch(binding.tenantId, mismatches);
    }
    return dryRun
      ? { tenantId: binding.tenantId, action: 'dry-run-would-skip-row-count-mismatch', mismatches }
      : { tenantId: binding.tenantId, action: 'skipped-row-count-mismatch', mismatches };
  }

  if (dryRun) {
    const wouldDelete: Record<string, number> = {};
    for (const target of TARGETS) {
      wouldDelete[target.label] = await scopedCountDocuments(target.model, binding.tenantId);
    }
    log.info({ tenantId: binding.tenantId, wouldDelete }, 'Decommission sweep (dry-run): would decommission tenant — nothing deleted');
    return { tenantId: binding.tenantId, action: 'dry-run-would-decommission', wouldDelete };
  }

  const deletedCounts: Record<string, number> = {};
  for (const target of TARGETS) {
    const res = await scopedDeleteMany(target.model, binding.tenantId);
    deletedCounts[target.label] = (res as { deletedCount?: number }).deletedCount ?? 0;
  }

  // §3.3: terminal, irreversible-by-design (§3.4) — no code path ever flips
  // 'decommissioned' back to anything else.
  await TenantDbBindingModel.updateOne(
    { tenantId: binding.tenantId },
    { $set: { status: 'decommissioned', decommissionedAt: new Date() } },
  );

  log.info(
    { tenantId: binding.tenantId, deletedCounts },
    'Decommission sweep: tenant decommissioned — shared-tier rows dropped, status -> decommissioned (irreversible)',
  );
  return { tenantId: binding.tenantId, action: 'decommissioned', deletedCounts };
}

export interface DecommissionSweepResult {
  ranAt: Date;
  dryRun: boolean;
  tenants: TenantDecommissionOutcome[];
}

function requireDb(): void {
  if (!isConnected() || !TenantDbBindingModel) {
    throw new Error('MongoDB not connected — decommission sweep unavailable');
  }
}

/**
 * Sweep every currently-eligible tenant once (§3.2). Never throws — DB/
 * connection failures are logged and produce an empty result so the interval
 * loop keeps running.
 *
 * @param now injectable clock for deterministic tests + retention math.
 * @param dryRun computes mismatches/would-delete counts without deleting
 *   anything or touching `status` — exercise this before ever running for
 *   real (§3.4, irreversible).
 * @param retentionDays defaults to `DEFAULT_DECOMMISSION_RETENTION_DAYS`.
 */
export async function runDecommissionSweep(
  now: Date = new Date(),
  dryRun = false,
  retentionDays: number = DEFAULT_DECOMMISSION_RETENTION_DAYS,
): Promise<DecommissionSweepResult> {
  let bindings: BindingWithConnStr[];
  try {
    requireDb();
    const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
    bindings = (await TenantDbBindingModel.find({ status: 'active', migratedAt: { $lte: cutoff } })
      .select('+mongoUri')
      .lean()
      .exec()) as unknown as BindingWithConnStr[];
  } catch (err) {
    log.warn({ err }, 'Decommission sweep skipped — DB unavailable');
    const result: DecommissionSweepResult = { ranAt: now, dryRun, tenants: [] };
    latestResult = result;
    return result;
  }

  const tenants: TenantDecommissionOutcome[] = [];
  for (const binding of bindings) {
    try {
      tenants.push(await sweepOneTenant(binding, dryRun));
    } catch (err) {
      log.error({ tenantId: binding.tenantId, err }, 'Decommission sweep failed for tenant');
    }
  }

  const result: DecommissionSweepResult = { ranAt: now, dryRun, tenants };
  latestResult = result;
  log.info(
    { tenants: tenants.length, decommissioned: tenants.filter(t => t.action === 'decommissioned').length, dryRun },
    'Decommission sweep complete',
  );
  return result;
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: DecommissionSweepResult | null = null;

export function startDecommissionSweep(intervalHours: number = DEFAULT_SWEEP_INTERVAL_HOURS): void {
  if (intervalId) {
    log.warn('Decommission sweep already running');
    return;
  }
  const intervalMs = intervalHours * 60 * 60 * 1000;
  log.info({ intervalHours }, 'Starting decommission sweep');
  intervalId = setInterval(() => {
    runDecommissionSweep().catch(err => log.error({ err }, 'Periodic decommission sweep failed'));
  }, intervalMs);
  intervalId.unref?.();
}

export function stopDecommissionSweep(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Decommission sweep stopped');
  }
}

export function isDecommissionSweepRunning(): boolean {
  return intervalId !== null;
}

export function getLatestDecommissionSweepResult(): DecommissionSweepResult | null {
  return latestResult;
}
