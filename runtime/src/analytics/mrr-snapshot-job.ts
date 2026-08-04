/**
 * Nightly MRR-snapshot job — persists one {tenantId, mrr, plan, capturedAt}
 * document per non-deleted tenant per UTC day.
 *
 * Closes the gap noted on dashboard /revenue and /revenue/nrr: those pages
 * used to reconstruct a single "now" MRR point per tenant (no historical
 * series existed), so cohort expansion/contraction always read as a proxy
 * ("we cannot yet tell whether an active account has already expanded/
 * contracted since signup") rather than a real trend. Once this sweep has
 * run for a few days, the pages can read `MrrSnapshotModel` for a tenant's
 * real MRR at any past date instead of guessing from current subscription
 * state.
 *
 * Same tenant population as the dashboard's existing proxy query
 * (`status !== 'deleted'`) so a tenant's snapshot history includes the day
 * its MRR drops to 0 on cancellation — that's the churn signal the cohort
 * report needs, not just the still-active accounts.
 *
 * Idempotent: the unique {tenantId, snapshotDate} index on `MrrSnapshotModel`
 * makes re-running the sweep on the same UTC day an upsert (overwrite) of
 * that day's row rather than a duplicate — safe to re-run after a crash or
 * more than once a day. Each tenant is handled independently — a failure on
 * one never blocks the rest (mirrors `scheduler/quota-reset-sweep.ts`).
 *
 * Not wired to an automatic in-process cron — an operator/cron schedule
 * (kind=tool, target=mrr_snapshot_sweep) invokes this on a daily cadence,
 * same as `scheduler/evening-sweep.ts` and `scheduler/quota-reset-sweep.ts`.
 */
import { TenantModel, MrrSnapshotModel, isConnected, type TenantPlan, type SubscriptionStatus } from '../shared/db.js';
import { mrrForSnapshot, type TenantBillingSnapshot, type BillingInterval } from './revenue.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'mrr-snapshot-job' });

/** 'YYYY-MM-DD' in UTC — the per-tenant daily dedupe/upsert key. Pure. */
export function snapshotDateKey(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export interface MrrSnapshotSweepResult {
  ranAt: Date;
  snapshotDate: string;
  tenantsChecked: number;
  written: string[];                                  // tenantIds snapshotted today
  failed: Array<{ tenantId: string; error: string }>;
}

interface SweepTenant {
  tenantId: string;
  plan?: TenantPlan;
  subscriptionStatus?: SubscriptionStatus;
  billingInterval?: BillingInterval;
  status?: string;
}

/**
 * Operator/cron-run sweep: for every non-deleted tenant, upsert today's MRR
 * snapshot. Returns per-tenant results rather than throwing — a single
 * tenant's write failure is recorded in `failed` and does not stop the sweep.
 */
export async function runMrrSnapshotSweep(now: Date = new Date()): Promise<MrrSnapshotSweepResult> {
  const snapshotDate = snapshotDateKey(now);
  const result: MrrSnapshotSweepResult = { ranAt: now, snapshotDate, tenantsChecked: 0, written: [], failed: [] };

  if (!isConnected() || !TenantModel || !MrrSnapshotModel) {
    log.warn('mrr-snapshot-job: MongoDB not connected — skipping sweep');
    return result;
  }

  const tenants = await TenantModel.find({ status: { $ne: 'deleted' } })
    .select('tenantId plan subscriptionStatus billingInterval status')
    .lean<SweepTenant[]>()
    .exec();

  result.tenantsChecked = tenants.length;

  for (const tenant of tenants) {
    try {
      const plan: TenantPlan = tenant.plan ?? 'free';
      const snap: TenantBillingSnapshot = {
        tenantId: tenant.tenantId,
        plan,
        subscriptionStatus: tenant.subscriptionStatus,
        billingInterval: tenant.billingInterval,
      };
      const mrr = mrrForSnapshot(snap);

      await MrrSnapshotModel.findOneAndUpdate(
        { tenantId: tenant.tenantId, snapshotDate },
        { $set: { mrr, plan, capturedAt: now } },
        { upsert: true, setDefaultsOnInsert: true },
      ).exec();

      result.written.push(tenant.tenantId);
    } catch (err) {
      log.error({ err, tenantId: tenant.tenantId }, 'mrr-snapshot-job: write failed for tenant');
      result.failed.push({ tenantId: tenant.tenantId, error: (err as Error).message });
    }
  }

  log.info(
    { snapshotDate, tenantsChecked: result.tenantsChecked, written: result.written.length, failed: result.failed.length },
    'mrr-snapshot-job: complete',
  );
  return result;
}
