/**
 * slo-alerter — per-route SLO breach alerting for the myAI gateway.
 *
 * Complements the hot-path perf meter (perf-metrics.ts). Where perf-metrics
 * silently records every MCP tool call's latency and error flag, this module
 * turns that live registry into actionable alerts: for each route (tool) it
 * evaluates two Service Level Objectives —
 *
 *   • p95 latency (ms) at/over a threshold, and
 *   • error rate (%) over the recent sample window at/over a threshold,
 *
 * and fires a Telegram alert (via the same channel adapter the health-alerter
 * uses) when either is breached. A per-route cooldown prevents flapping: the
 * same route is not re-alerted within the cooldown window unless it recovers
 * and breaches again. Alerts self-clear because error rate is measured over the
 * bounded recent window (perf-metrics.windowErrorRatePct), not lifetime.
 *
 * Thresholds are configurable globally and per-route so a hot path
 * (tasks_claim, context_boot) can hold a tighter SLO than a cold admin tool.
 * State lives in-process — this is a live operational alerter, not a store.
 */
import { createChildLogger } from '../shared/logger.js';
import { getAdapter } from '../channels/registry.js';
import { getPerfStats, type ToolPerf } from './perf-metrics.js';

const log = createChildLogger({ module: 'slo-alerter' });

// ── Thresholds ────────────────────────────────────────────────

export interface SloThreshold {
  /** p95 latency (ms) at/over which the latency SLO is breached. */
  p95Ms: number;
  /** Error rate (%) over the recent window at/over which the error SLO is breached. */
  errorRatePct: number;
}

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Global default SLO, overridable per route. */
export const DEFAULT_SLO: SloThreshold = {
  p95Ms: envNum('MYAI_SLO_P95_MS', 2000),
  errorRatePct: envNum('MYAI_SLO_ERROR_RATE_PCT', 5),
};

/**
 * Minimum recent samples a route needs before it is eligible for an alert.
 * Guards against a single slow/errored call on a low-traffic route flapping an
 * alert off noise.
 */
export const MIN_SAMPLES = (() => {
  const raw = Number(process.env.MYAI_SLO_MIN_SAMPLES);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 20;
})();

/** Re-alert cooldown for a still-breached route (minutes). */
const DEFAULT_COOLDOWN_MINUTES = envNum('MYAI_SLO_COOLDOWN_MIN', 60);

/**
 * Parse per-route threshold overrides from MYAI_SLO_ROUTES, a JSON object keyed
 * by tool name, e.g. {"tasks_claim":{"p95Ms":300,"errorRatePct":2}}. Partial
 * overrides fall back to the global default per field. Never throws.
 */
export function parseRouteOverrides(raw: string | undefined): Record<string, SloThreshold> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, Partial<SloThreshold>>;
    const out: Record<string, SloThreshold> = {};
    for (const [tool, cfg] of Object.entries(parsed)) {
      if (!cfg || typeof cfg !== 'object') continue;
      out[tool] = {
        p95Ms: Number.isFinite(cfg.p95Ms) && (cfg.p95Ms as number) > 0 ? (cfg.p95Ms as number) : DEFAULT_SLO.p95Ms,
        errorRatePct:
          Number.isFinite(cfg.errorRatePct) && (cfg.errorRatePct as number) >= 0
            ? (cfg.errorRatePct as number)
            : DEFAULT_SLO.errorRatePct,
      };
    }
    return out;
  } catch (err) {
    log.warn({ err }, 'MYAI_SLO_ROUTES is not valid JSON — using global defaults only');
    return {};
  }
}

let routeOverrides: Record<string, SloThreshold> = parseRouteOverrides(process.env.MYAI_SLO_ROUTES);

/** Resolve the effective threshold for a route (per-route override else global). */
export function thresholdFor(tool: string): SloThreshold {
  return routeOverrides[tool] ?? DEFAULT_SLO;
}

// ── Breach evaluation ─────────────────────────────────────────

export type SloMetric = 'p95_latency' | 'error_rate';

export interface SloBreach {
  tool: string;
  metric: SloMetric;
  observed: number;
  threshold: number;
  samples: number;
}

/**
 * Evaluate every route in a perf snapshot against its SLO. A route can breach
 * both metrics — each is reported separately. Routes below MIN_SAMPLES are
 * skipped (not enough signal). Pure — no side effects.
 */
export function evaluateBreaches(tools: readonly ToolPerf[]): SloBreach[] {
  const breaches: SloBreach[] = [];
  for (const t of tools) {
    if (t.samples < MIN_SAMPLES) continue;
    const slo = thresholdFor(t.tool);
    if (t.p95Ms >= slo.p95Ms) {
      breaches.push({ tool: t.tool, metric: 'p95_latency', observed: t.p95Ms, threshold: slo.p95Ms, samples: t.samples });
    }
    if (t.windowErrorRatePct >= slo.errorRatePct && slo.errorRatePct > 0) {
      breaches.push({
        tool: t.tool,
        metric: 'error_rate',
        observed: t.windowErrorRatePct,
        threshold: slo.errorRatePct,
        samples: t.samples,
      });
    }
  }
  return breaches;
}

// ── Cooldown / flap suppression ───────────────────────────────

const lastAlerted = new Map<string, number>(); // key: `${tool}:${metric}` → epoch ms

/** Cooldown key for a breach. */
function breachKey(b: SloBreach): string {
  return `${b.tool}:${b.metric}`;
}

/** Clear cooldown state (test helper / manual reset). */
export function clearSloCooldowns(): void {
  lastAlerted.clear();
}

function cooldownMs(): number {
  return DEFAULT_COOLDOWN_MINUTES * 60 * 1000;
}

// ── Alert dispatch ────────────────────────────────────────────

function formatBreachMessage(b: SloBreach): string {
  const unit = b.metric === 'p95_latency' ? 'ms' : '%';
  const label = b.metric === 'p95_latency' ? 'p95 latency' : 'error rate';
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return [
    `\u{1F6A8} SLO Breach — ${b.tool}`,
    `Metric: ${label}`,
    `Observed: ${b.observed}${unit} (threshold ${b.threshold}${unit})`,
    `Over ${b.samples} recent calls`,
    '',
    `Detected at ${timestamp} UTC`,
  ].join('\n');
}

async function sendBreachAlert(b: SloBreach): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ tool: b.tool, metric: b.metric }, 'No enabled Telegram adapter — SLO alert not sent');
    return false;
  }

  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ tool: b.tool, metric: b.metric }, 'TELEGRAM_DEFAULT_CHAT not set — SLO alert not sent');
    return false;
  }

  try {
    await telegram.send(chatId, formatBreachMessage(b));
    log.info({ tool: b.tool, metric: b.metric, observed: b.observed, threshold: b.threshold }, 'SLO breach alert sent');
    return true;
  } catch (err) {
    log.error({ tool: b.tool, metric: b.metric, err }, 'Failed to send SLO breach alert');
    return false;
  }
}

// ── Main SLO check runner ─────────────────────────────────────

export interface SloCheckResult {
  ranAt: Date;
  breaches: SloBreach[];
  alertsSent: number;
}

/**
 * Snapshot the perf registry, evaluate SLOs, and fire alerts for newly-breached
 * (or cooldown-expired) routes. A route that recovers below threshold has its
 * cooldown cleared so the next breach alerts immediately. Never throws.
 *
 * @param now injectable clock (epoch ms) for deterministic tests.
 */
export async function runSloCheck(now: number = Date.now()): Promise<SloCheckResult> {
  const ranAt = new Date(now);
  const breaches = evaluateBreaches(getPerfStats().tools);
  const breachedKeys = new Set(breaches.map(breachKey));

  // Recovery: any previously-alerted route no longer breaching clears its
  // cooldown, so the next breach alerts without waiting out the window.
  for (const key of [...lastAlerted.keys()]) {
    if (!breachedKeys.has(key)) lastAlerted.delete(key);
  }

  let alertsSent = 0;
  for (const b of breaches) {
    const key = breachKey(b);
    const prev = lastAlerted.get(key);
    const cooling = prev !== undefined && now - prev < cooldownMs();
    if (cooling) continue;

    const sent = await sendBreachAlert(b);
    if (sent) {
      alertsSent++;
      lastAlerted.set(key, now);
    }
  }

  const result: SloCheckResult = { ranAt, breaches, alertsSent };
  latestResult = result;
  if (breaches.length > 0) {
    log.info({ breaches: breaches.length, alertsSent }, 'SLO check complete — breaches detected');
  }
  return result;
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: SloCheckResult | null = null;

/** Default SLO evaluation interval: 5 minutes (perf meter is live, cheap to read). */
const DEFAULT_INTERVAL_MINUTES = 5;

export function startSloAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('SLO alerts already running');
    return;
  }
  // Re-read overrides at start so a config change survives a restart.
  routeOverrides = parseRouteOverrides(process.env.MYAI_SLO_ROUTES);

  const intervalMs = intervalMinutes * 60 * 1000;
  log.info(
    { intervalMinutes, defaultP95Ms: DEFAULT_SLO.p95Ms, defaultErrorRatePct: DEFAULT_SLO.errorRatePct, routeOverrides: Object.keys(routeOverrides).length },
    'Starting SLO alerts',
  );

  intervalId = setInterval(() => {
    runSloCheck().catch(err => log.error({ err }, 'Periodic SLO check failed'));
  }, intervalMs);
}

export function stopSloAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('SLO alerts stopped');
  }
}

export function isSloAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestSloCheckResult(): SloCheckResult | null {
  return latestResult;
}

/** Current SLO alerting configuration + state for status queries. */
export function getSloAlertStatus(): {
  active: boolean;
  intervalMinutes: number;
  defaultP95Ms: number;
  defaultErrorRatePct: number;
  minSamples: number;
  cooldownMinutes: number;
  routeOverrides: Record<string, SloThreshold>;
  lastRun: Date | null;
  lastBreaches: number;
  trackedCooldowns: number;
} {
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    defaultP95Ms: DEFAULT_SLO.p95Ms,
    defaultErrorRatePct: DEFAULT_SLO.errorRatePct,
    minSamples: MIN_SAMPLES,
    cooldownMinutes: DEFAULT_COOLDOWN_MINUTES,
    routeOverrides: { ...routeOverrides },
    lastRun: latestResult?.ranAt ?? null,
    lastBreaches: latestResult?.breaches.length ?? 0,
    trackedCooldowns: lastAlerted.size,
  };
}
