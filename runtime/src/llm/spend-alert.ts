/**
 * FINOPS — tenant-facing LLM spend alert.
 *
 * Notifies a tenant admin (email + in-dashboard banner/toast) when their
 * billing-period LLM/generation spend crosses 80% then 100% of their plan's
 * included spend allowance (`planLimits(plan).includedSpendUsd`, core/billing.ts).
 *
 * Distinct from two other spend-related mechanisms in this codebase:
 *   - `llm/budget-guard.ts` — an INTERNAL, deployment-wide execution cap that
 *     throttles/downgrades/blocks calls (`budgets.monthlyHardCapUsd`). That
 *     guard can trip with this alert never firing (or vice versa) — they read
 *     different numbers (a global operator cap vs. a per-tenant plan allowance).
 *   - the cost-anomaly detector — flags fraud/runaway spend spikes.
 * This module is purely a customer-facing heads-up to prevent bill-shock; it
 * never blocks a call.
 *
 * "Billing period" is approximated as the calendar month (UTC), matching the
 * MTD convention `budget-guard.ts`/`budget-stats.ts` already use for spend
 * aggregation — there is no per-tenant Stripe period start stored today.
 *
 * Delivery: this module only computes the crossing and emits a `NotifyEvent`
 * via `emitNotifyEvent`. The existing notification service
 * (notifications/service.ts) fans that out to the tenant's live dashboard (SSE
 * toast + persisted history, i.e. the in-dashboard banner) and, when the
 * tenant is inactive and has email enabled, to their inbox
 * (notifications/email-notify.ts) — no new delivery plumbing needed here.
 *
 * A per-tenant-per-period watermark (`SpendAlertStateModel`) ensures each
 * threshold fires AT MOST ONCE per billing period, even though the check runs
 * on every LLM call.
 */

import { SpendAlertStateModel, TenantModel, isConnected } from '../shared/db.js';
import { planLimits } from '../core/billing.js';
import { getBudgetStatus } from './budget-stats.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { createChildLogger } from '../shared/logger.js';
import type { TenantPlan } from '../shared/db.js';

const log = createChildLogger({ module: 'spend-alert' });

/** Alert thresholds, checked highest-first so a call that jumps straight past
 *  100% doesn't fire the 80% alert instead. */
export const SPEND_ALERT_THRESHOLDS = [100, 80] as const;
export type SpendAlertThreshold = (typeof SPEND_ALERT_THRESHOLDS)[number];

export interface SpendAlertStatus {
  plan: TenantPlan;
  /** Plan's included spend allowance in USD (-1 = unlimited). */
  includedUsd: number;
  /** Current billing-period (calendar-month UTC) spend in USD. */
  spentUsd: number;
  /** `spentUsd / includedUsd * 100`, or null when unlimited/no allowance. */
  pct: number | null;
  /** Highest threshold currently crossed, or null. */
  alertLevel: SpendAlertThreshold | null;
  /** True when the plan has no included-spend ceiling (never alerts). */
  unlimited: boolean;
}

// ── Pure ──────────────────────────────────────────────────

/** Highest threshold `spentUsd` has crossed relative to `includedUsd`, or
 *  null when under 80% or when the allowance is unlimited/non-positive. Pure. */
export function crossedThreshold(spentUsd: number, includedUsd: number): SpendAlertThreshold | null {
  if (includedUsd <= 0) return null;
  for (const threshold of SPEND_ALERT_THRESHOLDS) {
    if (spentUsd >= includedUsd * (threshold / 100)) return threshold;
  }
  return null;
}

/** 'YYYY-MM' in UTC — the billing-period key used to dedupe alerts. Pure. */
export function currentPeriodKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

// ── Read: current status (no side effects) ───────────────

/**
 * Compute a tenant's current spend-alert status without emitting anything or
 * touching the dedup watermark. Used by the read-side (tenant-facing REST
 * endpoint / dashboard banner poll). Never throws — returns a safe "no plan
 * found" default when the tenant or DB is unavailable.
 */
export async function getSpendAlertStatus(tenantId: string): Promise<SpendAlertStatus> {
  const fallback: SpendAlertStatus = {
    plan: 'free',
    includedUsd: planLimits('free').includedSpendUsd,
    spentUsd: 0,
    pct: null,
    alertLevel: null,
    unlimited: false,
  };

  if (!isConnected() || !TenantModel) return fallback;

  let plan: TenantPlan = 'free';
  try {
    const tenant = await TenantModel.findOne({ tenantId }).select('plan').lean<{ plan?: TenantPlan }>();
    if (tenant?.plan) plan = tenant.plan;
  } catch (err) {
    log.warn({ err, tenantId }, 'spend-alert: tenant lookup failed — defaulting to free plan');
  }

  const includedUsd = planLimits(plan).includedSpendUsd;
  const unlimited = includedUsd < 0;

  const { mtd: spentUsd } = await getBudgetStatus(tenantId);
  const pct = unlimited ? null : includedUsd > 0 ? (spentUsd / includedUsd) * 100 : null;
  const alertLevel = unlimited ? null : crossedThreshold(spentUsd, includedUsd);

  return { plan, includedUsd, spentUsd, pct, alertLevel, unlimited };
}

// ── Write: check + emit (dedup'd per tenant per period) ──

/**
 * Check a tenant's spend against their plan's included allowance and emit a
 * `billing.spend_alert` notification the first time each threshold (80, then
 * 100) is crossed within the current billing period. Idempotent per
 * tenant+period+threshold — safe to call on every LLM call's post-call hook.
 *
 * Never throws: a DB hiccup here must not affect the LLM call it rides along
 * with. Failures are logged and swallowed.
 */
export async function checkAndEmitSpendAlert(tenantId: string): Promise<void> {
  try {
    const status = await getSpendAlertStatus(tenantId);
    if (status.unlimited || status.alertLevel === null) return;

    if (!isConnected() || !SpendAlertStateModel) {
      log.debug({ tenantId }, 'spend-alert: MongoDB not connected — skipping (no durable dedup)');
      return;
    }

    const period = currentPeriodKey();
    const existing = await SpendAlertStateModel.findOne({ tenantId, period }).lean<{ maxThresholdSent?: number }>();
    const alreadySent = existing?.maxThresholdSent ?? 0;
    if (status.alertLevel <= alreadySent) return; // already alerted at this level (or higher) this period

    await SpendAlertStateModel.findOneAndUpdate(
      { tenantId, period },
      { $max: { maxThresholdSent: status.alertLevel } },
      { upsert: true },
    );

    const pctLabel = status.alertLevel;
    const level = status.alertLevel >= 100 ? 'critical' : 'warning';
    const title =
      status.alertLevel >= 100
        ? `You've used 100% of your included ${status.plan} plan spend`
        : `You've used ${pctLabel}% of your included ${status.plan} plan spend`;
    const message =
      `$${status.spentUsd.toFixed(2)} of $${status.includedUsd.toFixed(2)} included LLM spend used this billing ` +
      `period. ${status.alertLevel >= 100
        ? 'Further usage may incur overage charges.'
        : 'You are approaching your plan allowance.'}`;

    emitNotifyEvent({
      type: 'billing.spend_alert',
      tenantId,
      title,
      message,
      level,
      source: 'spend-alert',
      data: {
        plan: status.plan,
        threshold: status.alertLevel,
        spentUsd: status.spentUsd,
        includedUsd: status.includedUsd,
        period,
      },
    });
  } catch (err) {
    log.warn({ err, tenantId }, 'spend-alert: check failed (suppressed)');
  }
}

/** Test-only reset — clears the in-process dedup watermark by removing this
 *  tenant's current-period row so a test can re-trigger a fresh check. */
export async function _resetSpendAlertStateForTests(tenantId: string): Promise<void> {
  if (!isConnected() || !SpendAlertStateModel) return;
  await SpendAlertStateModel.deleteMany({ tenantId, period: currentPeriodKey() });
}
