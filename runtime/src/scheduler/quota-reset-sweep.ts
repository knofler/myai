/**
 * Per-tenant monthly quota-reset scheduler — rolls each tenant's
 * `TenantRequestQuotaModel` usage/quota counter on THEIR OWN billing-anchor
 * day, not a global UTC calendar-month boundary (GATEWAY task).
 *
 * Distinct from two other tenant-quota mechanisms that stay exactly as-is:
 *  - the per-request burst rate limiter (core/tenant-quota.ts `checkRate`) —
 *    an in-memory sliding window, untouched by this sweep.
 *  - the metering event write-path (shared/usage-store.ts `recordUsage`) —
 *    an append-only ledger (invoice evidence) that is never reset.
 *
 * "Billing anchor day" is the day-of-month a tenant's usage/quota counters
 * should roll over. It prefers the Stripe renewal date (`currentPeriodEnd`)
 * — its day-of-month recurs every cycle by construction — and falls back to
 * the signup date (`createdAt`) for tenants with no active subscription (free
 * plan, never-subscribed). There is no separate stored anchor field: both
 * signals already live on the tenant doc (spend-alert.ts's header notes "no
 * per-tenant Stripe period start stored today" — this derives one instead of
 * adding a new field).
 *
 * Idempotent: rolling a tenant whose anchor-period counter row already
 * exists is a no-op (`$setOnInsert` upsert on the same unique {tenantId,
 * period} key `core/tenant-quota.ts` already enforces) — safe to run the
 * sweep more than once on the anchor day, or to re-run it after a crash.
 *
 * Not wired to an automatic in-process cron — an operator/cron invokes this
 * on a daily cadence, same as `scheduler/evening-sweep.ts` and
 * `core/account-erasure.ts`'s `runErasureSweep`.
 */
import { TenantModel, TenantRequestQuotaModel, isConnected } from '../shared/db.js';
import type { ITenant } from '../shared/db.js';
import { planLimits } from '../core/billing.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'quota-reset-sweep' });

/** Minimal shape needed to compute a tenant's billing anchor. Pure input. */
export interface BillingAnchorSource {
  createdAt: Date;
  currentPeriodEnd?: Date;
}

/** Days in a given UTC year/month (`month0` is 0-indexed, JS Date convention). */
export function daysInUTCMonth(year: number, month0: number): number {
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

/**
 * The day-of-month (1-31) a tenant's billing cycle rolls over. Prefers
 * `currentPeriodEnd` (Stripe's paid-through date) over `createdAt` (signup).
 */
export function billingAnchorDay(tenant: BillingAnchorSource): number {
  return (tenant.currentPeriodEnd ?? tenant.createdAt).getUTCDate();
}

/**
 * Is `anchorDay` due "today" (UTC) relative to `now`? Short months clamp the
 * anchor to the LAST day of the month (e.g. anchor day 31 fires on Feb 28/29)
 * rather than skipping the month entirely — every tenant rolls exactly once
 * per UTC calendar month.
 */
export function isBillingAnchorDueToday(anchorDay: number, now: Date): boolean {
  const effective = Math.min(anchorDay, daysInUTCMonth(now.getUTCFullYear(), now.getUTCMonth()));
  return now.getUTCDate() === effective;
}

/**
 * Stable period key (`YYYY-MM-DD`) for the tenant's CURRENT anchor-based
 * billing cycle — the UTC date of the most recent anchor occurrence on or
 * before `now`. Unlike `core/tenant-quota.ts`'s `monthKey` (always the 1st),
 * this shifts with the tenant's own anchor day.
 */
export function anchorPeriodKey(anchorDay: number, now: Date): string {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const effectiveThisMonth = Math.min(anchorDay, daysInUTCMonth(year, month));

  if (now.getUTCDate() >= effectiveThisMonth) {
    return new Date(Date.UTC(year, month, effectiveThisMonth)).toISOString().slice(0, 10);
  }

  // The current cycle started last month.
  const prevMonth0 = ((month - 1) % 12 + 12) % 12;
  const prevYear = month === 0 ? year - 1 : year;
  const effectivePrevMonth = Math.min(anchorDay, daysInUTCMonth(prevYear, prevMonth0));
  return new Date(Date.UTC(prevYear, prevMonth0, effectivePrevMonth)).toISOString().slice(0, 10);
}

export interface QuotaResetSweepResult {
  ranAt: Date;
  tenantsChecked: number;
  rolled: string[];                                  // tenantIds rolled to a fresh counter row today
  skipped: string[];                                 // tenantIds not due today (or unlimited plan)
  failed: Array<{ tenantId: string; error: string }>;
}

type SweepTenant = Pick<ITenant, 'tenantId' | 'plan' | 'createdAt' | 'currentPeriodEnd'>;

/**
 * Operator/cron-run sweep: for every active tenant whose billing-anchor day
 * is "today" (UTC), ensure a fresh usage/quota counter row exists for their
 * new anchor-based cycle. Each tenant is handled independently — a failure on
 * one never blocks the rest (mirrors `core/account-erasure.ts`'s
 * `runErasureSweep`).
 */
export async function runQuotaResetSweep(now: Date = new Date()): Promise<QuotaResetSweepResult> {
  const result: QuotaResetSweepResult = { ranAt: now, tenantsChecked: 0, rolled: [], skipped: [], failed: [] };

  if (!isConnected() || !TenantModel || !TenantRequestQuotaModel) {
    log.warn('quota-reset-sweep: MongoDB not connected — skipping sweep');
    return result;
  }

  const tenants = await TenantModel.find({ status: 'active' })
    .select('tenantId plan createdAt currentPeriodEnd')
    .lean<SweepTenant[]>()
    .exec();

  result.tenantsChecked = tenants.length;

  for (const tenant of tenants) {
    try {
      // Unlimited (-1) plans never write a quota counter (core/tenant-quota.ts
      // tenantQuota() middleware) — nothing to roll.
      if (planLimits(tenant.plan ?? 'free').monthlyRequests < 0) {
        result.skipped.push(tenant.tenantId);
        continue;
      }

      const anchorDay = billingAnchorDay(tenant);
      if (!isBillingAnchorDueToday(anchorDay, now)) {
        result.skipped.push(tenant.tenantId);
        continue;
      }

      const period = anchorPeriodKey(anchorDay, now);
      // $setOnInsert-only upsert against the same unique {tenantId, period}
      // index `incrementMonthlyUsage` uses — a row already present for this
      // period (re-run same day, or the tenant already made a request this
      // cycle) is left untouched, making the roll idempotent by construction.
      await TenantRequestQuotaModel.findOneAndUpdate(
        { tenantId: tenant.tenantId, period },
        { $setOnInsert: { count: 0 } },
        { upsert: true, setDefaultsOnInsert: true },
      ).exec();

      log.info({ tenantId: tenant.tenantId, anchorDay, period }, 'quota-reset-sweep: rolled tenant counter');
      result.rolled.push(tenant.tenantId);
    } catch (err) {
      log.error({ err, tenantId: tenant.tenantId }, 'quota-reset-sweep: roll failed for tenant');
      result.failed.push({ tenantId: tenant.tenantId, error: (err as Error).message });
    }
  }

  log.info(
    {
      tenantsChecked: result.tenantsChecked,
      rolled: result.rolled.length,
      skipped: result.skipped.length,
      failed: result.failed.length,
    },
    'quota-reset-sweep: complete',
  );
  return result;
}
