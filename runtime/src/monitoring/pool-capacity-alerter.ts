/**
 * pool-capacity-alerter — operator subscription-pool capacity floor alert.
 *
 * Watches the pool-capacity artifact (state/pool-capacity.json — written
 * host-side by scripts/pool_capacity_snapshot.sh from config/runner_budget.conf
 * + the runner's pacing ledger, same bridge pattern as runner_health.sh) and
 * pushes an alert when a pool's weekly consumption crosses a configurable
 * threshold, so a pool running dry reaches the operator (Telegram + dashboard
 * bell) instead of requiring someone to check the /schedule page.
 *
 * Distinct from the per-TENANT spend alert (llm/spend-alert.ts — a customer's
 * plan allowance) and from budget-guard (a USD execution cap on API calls):
 * this is the OPERATOR'S OWN subscription-pool token budget — the thing the
 * runner's pacing ledger paces — going low for the week.
 *
 * Thresholds (env-configurable):
 *   MYAI_POOL_ALERT_PCT           — warning when pctUsedWeekly ≥ this (default 80)
 *   MYAI_POOL_ALERT_PCT_CRITICAL  — critical when pctUsedWeekly ≥ this (default 95)
 *   MYAI_POOL_ALERT_FLOOR_TOKENS  — critical when weeklyRemainingTokens ≤ this
 *                                   absolute floor (default 0 = floor off)
 *   MYAI_POOL_ALERT_STALE_HOURS   — skip artifacts older than this (default 24):
 *                                   a dead producer must not alert on stale numbers
 *
 * Dedup: each pool fires AT MOST ONCE per severity per ISO week (the ledger
 * resets Monday, Sydney time — same week key as the runner's pace_week()). An
 * escalation warning→critical within the same week fires again; a repeat at
 * the same severity is suppressed. State lives in-process, same as
 * queue-wait-alerter/slo-alerter — a live operational alerter, not a store.
 *
 * Delivery: Telegram (channels adapter + TELEGRAM_DEFAULT_CHAT) AND
 * emitNotifyEvent → dashboard bell/toast + durable history. The notify event
 * is in-process and always lands, so the dedup watermark advances even when
 * Telegram is unconfigured.
 *
 * USD-denominated pools (task-f5897132): a pool entry that declares a
 * `period` ("daily" | "weekly") plus `capUsd`/`spentUsd`/`pctUsedUsd` is
 * evaluated against the SAME warn/critical pct thresholds as the token
 * pools, but dedups on the period it actually resets on — the non-Claude
 * agentic-fallback lane's day-ledger (scripts/lib/agentic_fallback.sh,
 * bridged in by pool_capacity_snapshot.sh) resets daily (Sydney), not
 * weekly, so it keys its watermark off the snapshot's `day` field instead
 * of `week`. This is the same "someone has to check the page" gap this file
 * already closed for the Claude subscription pools, closed for the
 * separately-billed fallback lane too — an operator no longer has to read
 * runner.out or the ledger file directly to learn the lane paused on its
 * cap.
 *
 * Lifetime USD reserve (task-d383b7e8): `period: "lifetime"` covers a pool
 * that never resets — the metered API-credit RESERVE (`claude-api-credit`,
 * task-874364a3), a fixed lifetime pot rather than a recurring budget. It
 * shares the same `capUsd`/`spentUsd`/`pctUsedUsd` evaluation path as the
 * daily/weekly USD pools (and dedups weekly, same as the token pools — a
 * standing reminder while breached, not a one-time-ever alert), but its
 * CRITICAL threshold is `MYAI_POOL_ALERT_PCT_CRITICAL_LIFETIME` (default
 * 100 — the hard cap itself, since `api_credit_budget_ok` in
 * scripts/lib/api_credit_pool.sh stops draws only at 100% spent) instead of
 * the periodic pools' early-warning `criticalPct` (default 95).
 */
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../shared/config.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'pool-capacity-alerter' });

// ── Artifact schema ───────────────────────────────────────────

/** One subscription pool's weekly capacity, as written by the snapshot script. */
export interface PoolCapacityEntry {
  /** Pool label, e.g. "claude-tech" (the paid shared tier the ledger paces). */
  pool: string;
  /** Runner's weekly token budget for this pool. 0/absent = no declared budget → never alerts. */
  weeklyBudgetTokens: number;
  weeklySpentTokens: number;
  weeklyRemainingTokens: number;
  /** weeklySpentTokens / weeklyBudgetTokens × 100. */
  pctUsedWeekly: number;
  /**
   * USD-denominated pools only (e.g. "agentic-fallback", "claude-api-credit"):
   * the reset period this entry's cap runs on. Presence of this field (not
   * `kind`, which is free-form/informational) is what routes evaluation to
   * the USD path below instead of the token path. `"lifetime"` is a fixed
   * pot that never resets — its CRITICAL threshold comes from
   * `lifetimeCriticalPct`, not `criticalPct` (see evaluatePoolCapacityBreaches).
   */
  period?: 'daily' | 'weekly' | 'lifetime';
  /** Master on/off switch for the pool (e.g. AGENTIC_FALLBACK=off) — false skips evaluation entirely. */
  enabled?: boolean;
  capUsd?: number;
  spentUsd?: number;
  remainingUsd?: number;
  /** spentUsd / capUsd × 100. */
  pctUsedUsd?: number;
}

export interface PoolCapacitySnapshot {
  generatedAt: string;
  /** ISO year-week key (Sydney), e.g. "2026-W30" — matches the runner's pace_week(). */
  week: string;
  /** Sydney calendar day key, e.g. "20260727" — matches the agentic-fallback ledger's day file. */
  day?: string;
  pools: PoolCapacityEntry[];
}

// ── Config ────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface PoolAlertConfig {
  warnPct: number;
  criticalPct: number;
  floorTokens: number;
  staleHours: number;
  /** CRITICAL threshold for `period: "lifetime"` USD pools (default 100 — the hard cap itself). */
  lifetimeCriticalPct: number;
}

/** Read thresholds from env at call time so tests (and a gateway restart) pick up changes. */
export function poolAlertConfig(): PoolAlertConfig {
  return {
    warnPct: envNum('MYAI_POOL_ALERT_PCT', 80),
    criticalPct: envNum('MYAI_POOL_ALERT_PCT_CRITICAL', 95),
    floorTokens: envNum('MYAI_POOL_ALERT_FLOOR_TOKENS', 0),
    staleHours: envNum('MYAI_POOL_ALERT_STALE_HOURS', 24),
    lifetimeCriticalPct: envNum('MYAI_POOL_ALERT_PCT_CRITICAL_LIFETIME', 100),
  };
}

// ── Breach evaluation (pure) ──────────────────────────────────

export type PoolAlertSeverity = 'warning' | 'critical';

export interface PoolCapacityBreach {
  pool: string;
  severity: PoolAlertSeverity;
  /** Which condition(s) tripped: pct threshold and/or absolute remaining floor. */
  reasons: Array<'pct' | 'floor'>;
  pctUsedWeekly: number;
  weeklyRemainingTokens: number;
  weeklySpentTokens: number;
  weeklyBudgetTokens: number;
  /** The pct threshold that fired (warn or critical), for the message. */
  thresholdPct: number;
  floorTokens: number;
  /**
   * Set only for USD-denominated pools (those declaring `period`) — when
   * present, message formatting and the dedup watermark key use this
   * instead of the token fields above (which are zeroed for USD breaches).
   */
  usd?: {
    period: 'daily' | 'weekly' | 'lifetime';
    spentUsd: number;
    capUsd: number;
    remainingUsd: number;
    pctUsedUsd: number;
  };
}

/**
 * Evaluate pools against the thresholds. A pool with no declared budget
 * (weeklyBudgetTokens ≤ 0) never alerts — same "gate off until configured"
 * stance as the runner's token gate. A USD pool (declares `period`) is
 * gated off by `enabled === false` or a non-positive `capUsd` the same way.
 * A `"lifetime"` USD pool uses `lifetimeCriticalPct` for its CRITICAL
 * threshold instead of the periodic pools' `criticalPct` — a fixed pot has
 * no early-warning cap, only the hard cap itself. Pure — unit-testable
 * without I/O.
 */
export function evaluatePoolCapacityBreaches(
  pools: readonly PoolCapacityEntry[],
  cfg: PoolAlertConfig,
): PoolCapacityBreach[] {
  const breaches: PoolCapacityBreach[] = [];
  for (const p of pools) {
    if (!p || typeof p.pool !== 'string') continue;

    if (p.period) {
      if (p.enabled === false) continue;
      const capUsd = p.capUsd ?? 0;
      if (!(capUsd > 0)) continue;
      const pctUsedUsd = p.pctUsedUsd ?? 0;
      if (pctUsedUsd < cfg.warnPct) continue;

      const criticalPct = p.period === 'lifetime' ? cfg.lifetimeCriticalPct : cfg.criticalPct;
      const severity: PoolAlertSeverity = pctUsedUsd >= criticalPct ? 'critical' : 'warning';
      const spentUsd = p.spentUsd ?? 0;
      breaches.push({
        pool: p.pool,
        severity,
        reasons: ['pct'],
        pctUsedWeekly: 0,
        weeklyRemainingTokens: 0,
        weeklySpentTokens: 0,
        weeklyBudgetTokens: 0,
        thresholdPct: severity === 'critical' ? criticalPct : cfg.warnPct,
        floorTokens: 0,
        usd: {
          period: p.period,
          spentUsd,
          capUsd,
          remainingUsd: p.remainingUsd ?? Math.max(0, capUsd - spentUsd),
          pctUsedUsd,
        },
      });
      continue;
    }

    if (!(p.weeklyBudgetTokens > 0)) continue;

    const reasons: Array<'pct' | 'floor'> = [];
    if (p.pctUsedWeekly >= cfg.warnPct) reasons.push('pct');
    if (cfg.floorTokens > 0 && p.weeklyRemainingTokens <= cfg.floorTokens) reasons.push('floor');
    if (reasons.length === 0) continue;

    // The absolute floor means queued work is about to stall — always critical.
    const severity: PoolAlertSeverity =
      p.pctUsedWeekly >= cfg.criticalPct || reasons.includes('floor') ? 'critical' : 'warning';

    breaches.push({
      pool: p.pool,
      severity,
      reasons,
      pctUsedWeekly: p.pctUsedWeekly,
      weeklyRemainingTokens: p.weeklyRemainingTokens,
      weeklySpentTokens: p.weeklySpentTokens,
      weeklyBudgetTokens: p.weeklyBudgetTokens,
      thresholdPct: severity === 'critical' && p.pctUsedWeekly >= cfg.criticalPct ? cfg.criticalPct : cfg.warnPct,
      floorTokens: cfg.floorTokens,
    });
  }
  return breaches;
}

// ── Artifact read ─────────────────────────────────────────────

/** Read + minimally validate the artifact. Null when missing/malformed — never throws. */
export async function readPoolCapacitySnapshot(): Promise<PoolCapacitySnapshot | null> {
  const file = resolve(getConfig().aiRoot, 'state', 'pool-capacity.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null; // producer hasn't run yet — normal on a fresh install
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PoolCapacitySnapshot>;
    if (typeof parsed.generatedAt !== 'string' || typeof parsed.week !== 'string' || !Array.isArray(parsed.pools)) {
      log.warn({ file }, 'pool-capacity artifact malformed — ignoring');
      return null;
    }
    return parsed as PoolCapacitySnapshot;
  } catch (err) {
    log.warn({ err, file }, 'pool-capacity artifact unparseable — ignoring');
    return null;
  }
}

// ── Weekly dedup watermark ────────────────────────────────────

const SEVERITY_RANK: Record<PoolAlertSeverity, number> = { warning: 1, critical: 2 };

/** key: `${pool}|${week}` → highest severity rank already alerted. */
const alerted = new Map<string, number>();

/** Clear dedup state (test helper / manual reset). */
export function clearPoolCapacityWatermarks(): void {
  alerted.clear();
}

/**
 * Drop watermarks from other periods so the map never grows unbounded. A
 * key ending in the current week OR the current day survives — token pools
 * key on week, USD pools key on whichever period they declare (most are
 * "daily" today, e.g. agentic-fallback), so both live keys must be preserved
 * in the same pass.
 */
function pruneStaleWatermarks(currentWeek: string, currentDay: string | null): void {
  for (const key of [...alerted.keys()]) {
    if (key.endsWith(`|${currentWeek}`)) continue;
    if (currentDay && key.endsWith(`|${currentDay}`)) continue;
    alerted.delete(key);
  }
}

// ── Alert dispatch ────────────────────────────────────────────

function formatBreachMessage(b: PoolCapacityBreach, periodKey: string): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const icon = b.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';

  if (b.usd?.period === 'lifetime') {
    return [
      `${icon} Pool Capacity — ${b.pool} at ${b.usd.pctUsedUsd.toFixed(1)}% of its lifetime USD cap`,
      `Spent: $${b.usd.spentUsd.toFixed(2)} of $${b.usd.capUsd.toFixed(2)} (lifetime hard cap)`,
      `Remaining: $${b.usd.remainingUsd.toFixed(2)}`,
      '',
      b.severity === 'critical'
        ? 'Hard cap reached — the runner stops drawing on this reserve until the operator adds more credit.'
        : 'Reserve nearing its lifetime hard cap — the fallback lane will stop working once it runs dry.',
      `Detected at ${timestamp} UTC`,
    ].join('\n');
  }

  if (b.usd) {
    const periodLabel = b.usd.period === 'daily' ? 'Day' : 'Week';
    return [
      `${icon} Pool Capacity — ${b.pool} at ${b.usd.pctUsedUsd.toFixed(1)}% of its ${b.usd.period} USD cap`,
      `${periodLabel}: ${periodKey}`,
      `Spent: $${b.usd.spentUsd.toFixed(2)} of $${b.usd.capUsd.toFixed(2)}`,
      `Remaining: $${b.usd.remainingUsd.toFixed(2)}`,
      '',
      b.severity === 'critical'
        ? 'The lane is paused for the rest of the period — it will resume once the ledger resets.'
        : `Heads-up before the ${b.usd.period} cap bites — the fallback lane may pause soon.`,
      `Detected at ${timestamp} UTC`,
    ].join('\n');
  }

  const lines = [
    `${icon} Pool Capacity — ${b.pool} at ${b.pctUsedWeekly.toFixed(1)}% of its weekly budget`,
    `Week: ${periodKey}`,
    `Spent: ${b.weeklySpentTokens.toLocaleString('en-US')} of ${b.weeklyBudgetTokens.toLocaleString('en-US')} tokens`,
    `Remaining: ${b.weeklyRemainingTokens.toLocaleString('en-US')} tokens`,
  ];
  if (b.reasons.includes('floor')) {
    lines.push(`Floor: ${b.floorTokens.toLocaleString('en-US')} tokens — BREACHED`);
  }
  lines.push(
    '',
    b.severity === 'critical'
      ? 'Runner pacing will throttle or stop autonomous work when this pool is exhausted.'
      : 'Heads-up before the pacing gate bites — consider deferring non-urgent queue work.',
    `Detected at ${timestamp} UTC`,
  );
  return lines.join('\n');
}

async function sendTelegram(b: PoolCapacityBreach, periodKey: string): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ pool: b.pool }, 'No enabled Telegram adapter — pool-capacity alert not sent to Telegram');
    return false;
  }
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ pool: b.pool }, 'TELEGRAM_DEFAULT_CHAT not set — pool-capacity alert not sent to Telegram');
    return false;
  }
  try {
    await telegram.send(chatId, formatBreachMessage(b, periodKey));
    return true;
  } catch (err) {
    log.error({ pool: b.pool, err }, 'Failed to send pool-capacity Telegram alert');
    return false;
  }
}

// ── Main check runner ─────────────────────────────────────────

export interface PoolCapacityCheckResult {
  ranAt: Date;
  /** Artifact present, parseable, and fresh. */
  snapshotAvailable: boolean;
  week: string | null;
  breaches: PoolCapacityBreach[];
  /** Breaches that fired this run (past the weekly watermark). */
  alertsFired: number;
  telegramSent: number;
}

/**
 * Read the artifact, evaluate thresholds, and fire alerts for pools newly at
 * or past a threshold this week. Never throws.
 *
 * @param now injectable clock (epoch ms) for deterministic staleness tests.
 */
export async function runPoolCapacityCheck(now: number = Date.now()): Promise<PoolCapacityCheckResult> {
  const ranAt = new Date(now);
  const empty: PoolCapacityCheckResult = {
    ranAt,
    snapshotAvailable: false,
    week: null,
    breaches: [],
    alertsFired: 0,
    telegramSent: 0,
  };

  try {
    const cfg = poolAlertConfig();
    const snapshot = await readPoolCapacitySnapshot();
    if (!snapshot) {
      latestResult = empty;
      return empty;
    }

    const ageHours = (now - new Date(snapshot.generatedAt).getTime()) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > cfg.staleHours) {
      log.debug({ generatedAt: snapshot.generatedAt, staleHours: cfg.staleHours }, 'pool-capacity artifact stale — skipping');
      latestResult = empty;
      return empty;
    }

    pruneStaleWatermarks(snapshot.week, snapshot.day ?? null);
    const breaches = evaluatePoolCapacityBreaches(snapshot.pools, cfg);

    let alertsFired = 0;
    let telegramSent = 0;
    for (const b of breaches) {
      // USD-daily pools (e.g. agentic-fallback) dedup on the day the ledger
      // resets, not the ISO week — otherwise a Monday critical alert would
      // suppress Wednesday's fresh breach even though the cap reset twice
      // in between.
      const periodKey = b.usd?.period === 'daily' ? (snapshot.day ?? snapshot.week) : snapshot.week;
      const key = `${b.pool}|${periodKey}`;
      const rank = SEVERITY_RANK[b.severity];
      if ((alerted.get(key) ?? 0) >= rank) continue; // already alerted at this severity (or higher) this period
      alerted.set(key, rank);
      alertsFired++;

      const pct = b.usd ? b.usd.pctUsedUsd : b.pctUsedWeekly;
      const budgetLabel = b.usd ? `${b.usd.period} USD cap` : 'weekly budget';

      // Dashboard bell/toast + durable history — in-process, always lands.
      emitNotifyEvent({
        type: 'runner.pool_capacity',
        tenantId: DEFAULT_TENANT_ID,
        title: `Pool ${b.pool} at ${pct.toFixed(0)}% of ${budgetLabel}`,
        message: formatBreachMessage(b, periodKey),
        level: b.severity,
        source: 'pool-capacity-alerter',
        data: {
          pool: b.pool,
          week: snapshot.week,
          day: snapshot.day ?? null,
          reasons: b.reasons,
          pctUsedWeekly: b.pctUsedWeekly,
          weeklyRemainingTokens: b.weeklyRemainingTokens,
          weeklyBudgetTokens: b.weeklyBudgetTokens,
          thresholdPct: b.thresholdPct,
          floorTokens: b.floorTokens,
          usd: b.usd ?? null,
        },
      });

      if (await sendTelegram(b, periodKey)) telegramSent++;
      log.info({ pool: b.pool, severity: b.severity, pct, remaining: b.usd?.remainingUsd ?? b.weeklyRemainingTokens }, 'Pool-capacity alert fired');
    }

    const result: PoolCapacityCheckResult = {
      ranAt,
      snapshotAvailable: true,
      week: snapshot.week,
      breaches,
      alertsFired,
      telegramSent,
    };
    latestResult = result;
    return result;
  } catch (err) {
    log.warn({ err }, 'Pool-capacity check failed (suppressed)');
    latestResult = empty;
    return empty;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: PoolCapacityCheckResult | null = null;

/** The producer refreshes on each runner fire (~10 min cadence); 15 min here is plenty. */
const DEFAULT_INTERVAL_MINUTES = 15;

export function startPoolCapacityAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Pool-capacity alerts already running');
    return;
  }
  const cfg = poolAlertConfig();
  log.info(
    {
      intervalMinutes,
      warnPct: cfg.warnPct,
      criticalPct: cfg.criticalPct,
      lifetimeCriticalPct: cfg.lifetimeCriticalPct,
      floorTokens: cfg.floorTokens,
    },
    'Starting pool-capacity alerts',
  );
  intervalId = setInterval(() => {
    runPoolCapacityCheck().catch(err => log.error({ err }, 'Periodic pool-capacity check failed'));
  }, intervalMinutes * 60 * 1000);
}

export function stopPoolCapacityAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Pool-capacity alerts stopped');
  }
}

export function isPoolCapacityAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestPoolCapacityCheckResult(): PoolCapacityCheckResult | null {
  return latestResult;
}

/** Current configuration + state for status queries. */
export function getPoolCapacityAlertStatus(): {
  active: boolean;
  intervalMinutes: number;
  warnPct: number;
  criticalPct: number;
  lifetimeCriticalPct: number;
  floorTokens: number;
  staleHours: number;
  lastRun: Date | null;
  lastBreaches: number;
  trackedWatermarks: number;
} {
  const cfg = poolAlertConfig();
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    warnPct: cfg.warnPct,
    criticalPct: cfg.criticalPct,
    lifetimeCriticalPct: cfg.lifetimeCriticalPct,
    floorTokens: cfg.floorTokens,
    staleHours: cfg.staleHours,
    lastRun: latestResult?.ranAt ?? null,
    lastBreaches: latestResult?.breaches.length ?? 0,
    trackedWatermarks: alerted.size,
  };
}
