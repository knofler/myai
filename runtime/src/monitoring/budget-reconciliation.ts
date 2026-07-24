/**
 * budget-reconciliation — provider invoice drift alerting (Phase 5b
 * follow-up, plan/PHASE_5B_BUDGET_GUARDS.md §7/§8).
 *
 * `cost-estimator.ts` prices every LLM call from a hand-maintained per-model
 * rate table (`BudgetUsageModel.costUsd`). That table can silently drift from
 * what a provider actually bills. This job closes the loop: once a day it
 * reconciles the *previous* UTC day's estimated spend, grouped by provider,
 * against the actual invoiced USD (`provider-invoice.ts`), and fires a
 * Telegram alert when the two disagree by more than the configured drift
 * budget.
 *
 * Reconciles the previous *closed* day only — today is still accumulating,
 * so diffing it against an invoice would always show a partial-day drift.
 *
 * Same shape as the other `monitoring/*-alerter.ts` modules: a pure
 * evaluation function, a DB-backed check runner that never throws, an
 * in-process alert-history set (a closed day's numbers never change, so
 * unlike the other alerters there is no "recovery" case to reset — a
 * provider+period alerts at most once, ever), and start/stop/status
 * lifecycle helpers.
 */
import { BudgetUsageModel, isConnected, DEFAULT_TENANT_ID } from '../shared/db.js';
import { tenantScope } from '../shared/scoped-query.js';
import { createChildLogger } from '../shared/logger.js';
import { getAdapter } from '../channels/registry.js';
import { getActualInvoiceUsd } from '../llm/provider-invoice.js';
import type { InvoiceSource } from '../llm/provider-invoice.js';

const log = createChildLogger({ module: 'budget-reconciliation' });

/** Providers that never bill — never worth reconciling. Mirrors cost-estimator's FREE_PROVIDERS. */
const FREE_PROVIDERS = new Set(['ollama', 'claude-cli', 'claude-bridge']);

function envNumber(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

/** Relative drift threshold (fraction of actual spend). Default 15%. */
const DRIFT_THRESHOLD_PCT = envNumber('BUDGET_RECONCILE_DRIFT_PCT', 0.15);
/** Absolute drift floor in USD — below this, percentage drift is noise on a low-spend day. Default $2. */
const DRIFT_FLOOR_USD = envNumber('BUDGET_RECONCILE_DRIFT_FLOOR_USD', 2);

// ── Pure drift evaluation ─────────────────────────────────

export interface ProviderSpend {
  provider: string;
  estimatedUsd: number;
}

export interface DriftBreach {
  provider: string;
  estimatedUsd: number;
  actualUsd: number;
  diffUsd: number;
  diffPct: number;
  source: InvoiceSource;
}

/**
 * Compare estimated vs. actual spend for one provider. Breaches only when
 * the absolute diff clears `floorUsd` AND the relative diff (against actual
 * spend) clears `thresholdPct` — both gates avoid alert noise on trivially
 * small spend days (e.g. $0.01 estimated vs $0.03 actual is a 200% relative
 * drift but a 2-cent diff). Pure — no I/O — so exhaustively unit-testable.
 */
export function evaluateDrift(
  estimatedUsd: number,
  actualUsd: number,
  thresholdPct: number = DRIFT_THRESHOLD_PCT,
  floorUsd: number = DRIFT_FLOOR_USD,
): { diffUsd: number; diffPct: number } | null {
  const diffUsd = Math.abs(estimatedUsd - actualUsd);
  if (diffUsd < floorUsd) return null;

  // Relative to actual spend (what really got billed); if actual is 0 (and
  // diff still cleared the floor, i.e. estimator invented spend out of
  // nothing) fall back to relative-to-estimated so the divide-by-zero case
  // still reports a meaningful percentage instead of Infinity.
  const denominator = actualUsd > 0 ? actualUsd : estimatedUsd;
  const diffPct = denominator > 0 ? diffUsd / denominator : 0;
  if (diffPct < thresholdPct) return null;

  return { diffUsd, diffPct };
}

// ── Time helpers (UTC) — previous closed day ─────────────

function startOfDayUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** [start, end) of the UTC day immediately before `now`, plus its 'YYYY-MM-DD' key. */
export function previousUtcDayWindow(now: Date): { start: Date; end: Date; period: string } {
  const todayStart = startOfDayUTC(now);
  const start = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000);
  return { start, end: todayStart, period: start.toISOString().slice(0, 10) };
}

// ── Alert history (alert-once-per-provider-per-period) ──

const alerted = new Set<string>(); // `${provider}:${period}`

/** Test hook / manual reset — clears the in-memory alert-history set. */
export function clearBudgetReconciliationAlertHistory(): void {
  alerted.clear();
}

// ── Alert dispatch ────────────────────────────────────────

function formatBreachMessage(period: string, b: DriftBreach): string {
  const pct = (b.diffPct * 100).toFixed(1);
  return [
    `\u{1F4CA} Budget Reconciliation Drift — ${b.provider} (${period})`,
    `Estimated: $${b.estimatedUsd.toFixed(2)}  |  Actual (${b.source}): $${b.actualUsd.toFixed(2)}`,
    `Diff: $${b.diffUsd.toFixed(2)} (${pct}%) — exceeds the reconciliation threshold`,
    '',
    'Estimator pricing table may be stale — check documentation/COST_AWARE_ROUTING.md.',
  ].join('\n');
}

async function sendBreachAlert(period: string, b: DriftBreach): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ provider: b.provider, period }, 'No enabled Telegram adapter — reconciliation alert not sent');
    return false;
  }

  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ provider: b.provider, period }, 'TELEGRAM_DEFAULT_CHAT not set — reconciliation alert not sent');
    return false;
  }

  try {
    await telegram.send(chatId, formatBreachMessage(period, b));
    log.info(
      { provider: b.provider, period, diffUsd: b.diffUsd, diffPct: b.diffPct },
      'Budget reconciliation drift alert sent',
    );
    return true;
  } catch (err) {
    log.error({ provider: b.provider, period, err }, 'Failed to send budget reconciliation alert');
    return false;
  }
}

// ── Main check runner ─────────────────────────────────────

export interface BudgetReconciliationCheckResult {
  ranAt: Date;
  period: string;
  checked: number;
  skippedNoInvoice: string[];
  breaches: DriftBreach[];
  alertsSent: number;
}

/**
 * Reconcile the previous closed UTC day: aggregate estimated per-provider
 * spend from `BudgetUsageModel`, resolve each provider's actual invoiced
 * cost, and alert on drift beyond the configured budget. Never throws — DB
 * or invoice-source failures degrade to an empty/partial result.
 *
 * @param now injectable clock (epoch ms) for deterministic tests.
 */
export async function runBudgetReconciliationCheck(now: number = Date.now()): Promise<BudgetReconciliationCheckResult> {
  const ranAt = new Date(now);
  const { start, end, period } = previousUtcDayWindow(ranAt);

  let spends: ProviderSpend[] = [];
  if (isConnected() && BudgetUsageModel) {
    try {
      const rows = await BudgetUsageModel.aggregate<{ _id: string; total: number }>([
        { $match: { ...tenantScope(DEFAULT_TENANT_ID), createdAt: { $gte: start, $lt: end } } },
        { $group: { _id: '$provider', total: { $sum: '$costUsd' } } },
      ]);
      spends = rows.filter(r => !FREE_PROVIDERS.has(r._id)).map(r => ({ provider: r._id, estimatedUsd: r.total }));
    } catch (err) {
      log.warn({ err }, 'Budget reconciliation check: aggregation failed — skipping this run');
    }
  } else {
    log.warn('Budget reconciliation check skipped — DB unavailable');
  }

  const breaches: DriftBreach[] = [];
  const skippedNoInvoice: string[] = [];

  for (const s of spends) {
    const invoice = await getActualInvoiceUsd(s.provider, start, end);
    if (!invoice) {
      skippedNoInvoice.push(s.provider);
      continue;
    }
    const drift = evaluateDrift(s.estimatedUsd, invoice.costUsd);
    if (drift) {
      breaches.push({
        provider: s.provider,
        estimatedUsd: s.estimatedUsd,
        actualUsd: invoice.costUsd,
        diffUsd: drift.diffUsd,
        diffPct: drift.diffPct,
        source: invoice.source,
      });
    }
  }

  let alertsSent = 0;
  for (const b of breaches) {
    const key = `${b.provider}:${period}`;
    if (alerted.has(key)) continue;
    const sent = await sendBreachAlert(period, b);
    if (sent) {
      alertsSent++;
      alerted.add(key);
    }
  }

  const result: BudgetReconciliationCheckResult = {
    ranAt,
    period,
    checked: spends.length,
    skippedNoInvoice,
    breaches,
    alertsSent,
  };
  latestResult = result;
  if (breaches.length > 0) {
    log.info({ period, breaches: breaches.length, alertsSent }, 'Budget reconciliation complete — drift detected');
  }
  return result;
}

// ── Lifecycle ─────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: BudgetReconciliationCheckResult | null = null;

/** Default check interval: once a day — reconciling the same closed day more often is a no-op. */
const DEFAULT_INTERVAL_MINUTES = 24 * 60;

export function startBudgetReconciliation(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Budget reconciliation already running');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  log.info(
    { intervalMinutes, driftThresholdPct: DRIFT_THRESHOLD_PCT, driftFloorUsd: DRIFT_FLOOR_USD },
    'Starting budget reconciliation',
  );

  intervalId = setInterval(() => {
    runBudgetReconciliationCheck().catch(err => log.error({ err }, 'Periodic budget reconciliation check failed'));
  }, intervalMs);
}

export function stopBudgetReconciliation(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Budget reconciliation stopped');
  }
}

export function isBudgetReconciliationRunning(): boolean {
  return intervalId !== null;
}

export function getLatestBudgetReconciliationResult(): BudgetReconciliationCheckResult | null {
  return latestResult;
}

/** Current reconciliation configuration + state for status queries. */
export function getBudgetReconciliationStatus(): {
  active: boolean;
  intervalMinutes: number;
  driftThresholdPct: number;
  driftFloorUsd: number;
  lastRun: Date | null;
  lastPeriod: string | null;
  lastBreaches: number;
} {
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    driftThresholdPct: DRIFT_THRESHOLD_PCT,
    driftFloorUsd: DRIFT_FLOOR_USD,
    lastRun: latestResult?.ranAt ?? null,
    lastPeriod: latestResult?.period ?? null,
    lastBreaches: latestResult?.breaches.length ?? 0,
  };
}
