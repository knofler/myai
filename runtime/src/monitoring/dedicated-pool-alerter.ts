/**
 * dedicated-pool-alerter — connection-pool exhaustion ceiling + monitoring
 * for ADR-030 `dedicated-db` tenants (ADR-030 "Severity flags for
 * implementers", MEDIUM: "connection-pool exhaustion risk (§2) scales with
 * `dedicated`-tier tenant count — needs a documented ceiling and monitoring
 * before this tier is sold past a handful of design-partner customers").
 *
 * THE CEILING (documented, per the MEDIUM flag's own wording):
 * `tenant-db-registry.ts`'s `getConnectionForTenant` caches a `dedicated-db`
 * tenant's connection indefinitely once established (ADR-030 §2 — "Atlas
 * connection limits are cluster-wide and finite... cheap to hold open... so
 * it's cached indefinitely"). A `dedicated-db` tenant's connection lives on
 * the SAME shared Atlas cluster as every other tenant (shared or dedicated) —
 * unlike `dedicated-cluster`, which gets its own cluster and therefore its
 * own, separately-provisioned connection budget and is NOT counted here (see
 * `DEDICATED_CLUSTER_NOTE` below). Each held-open `dedicated-db` connection
 * costs the shared cluster up to `SHARED_CONNECTION_MAX_POOL_SIZE` (db.ts) —
 * the same per-connection pool size the base shared-tier connection already
 * uses, since a per-tenant connection is not spec'd to use a different size
 * (ADR-030 §2 gives it no options of its own).
 *
 * `MYAI_DEDICATED_POOL_SHARED_CLUSTER_BUDGET` (default 400) is the operator-
 * documented reservation, out of the shared Atlas cluster's total connection
 * limit, set aside for `dedicated-db` tenant pools — separate from the base
 * shared-tier pool (`SHARED_CONNECTION_MAX_POOL_SIZE` = 20) and Atlas's own
 * driver/admin overhead. The 400 default is a conservative placeholder sized
 * for a shared/M10-class Atlas tier (published connection limits for those
 * tiers run from several hundred up to ~1,500) — it is NOT self-discovered
 * from a live Atlas API call (this fleet has none wired in), so the operator
 * MUST set it explicitly once the actual provisioned cluster tier is known.
 * At the defaults (400 budget / 20 per tenant) the ceiling is 20 concurrently
 * `active`/`migrating` `dedicated-db` tenants — consistent with the ADR's own
 * "handful of design-partner customers" scale caveat; this alerter's job is
 * making sure nobody discovers that ceiling by exhausting it in production.
 *
 * `provisioning`-status bindings are NOT counted — ADR-030 §3 step 1 states
 * the tenant is still served from the shared connection during provisioning
 * ("zero customer-visible change at this phase"), so no dedicated connection
 * is open yet. `migrating` and `active` bindings both hold a live dedicated
 * connection (the dual-write phase opens the dedicated connection to fan
 * writes into it) and are counted. `suspended` bindings have their dedicated
 * connection torn down and are not counted.
 *
 * Delivery + dedup: reuses pool-capacity-alerter's channels (Telegram +
 * emitNotifyEvent dashboard bell/toast + durable history) and
 * pool-capacity-drift-alerter's watermark shape (single live gauge, not a
 * per-key weekly cycle — a held-open tenant-connection count changes rarely,
 * so cooldown + escalate-immediately + clear-on-recovery fits better than a
 * weekly dedup window).
 */
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { TenantDbBindingModel, DEFAULT_TENANT_ID, SHARED_CONNECTION_MAX_POOL_SIZE, isConnected } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'dedicated-pool-alerter' });

/** Bindings in these statuses hold a live, held-open dedicated connection. */
const LIVE_STATUSES = ['migrating', 'active'] as const;

// ── Config ────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface DedicatedPoolAlertConfig {
  warnPct: number;
  criticalPct: number;
  /** Per-tenant connection-pool size a held-open `dedicated-db` connection costs. */
  perTenantPoolSize: number;
  /** Total connections reserved on the shared Atlas cluster for `dedicated-db` tenant pools. */
  sharedClusterConnectionBudget: number;
  cooldownMinutes: number;
}

/** Read thresholds from env at call time so tests (and a gateway restart) pick up changes. */
export function dedicatedPoolAlertConfig(): DedicatedPoolAlertConfig {
  return {
    warnPct: envNum('MYAI_DEDICATED_POOL_ALERT_PCT', 80),
    criticalPct: envNum('MYAI_DEDICATED_POOL_ALERT_PCT_CRITICAL', 95),
    perTenantPoolSize: envNum('MYAI_DEDICATED_POOL_PER_TENANT_SIZE', SHARED_CONNECTION_MAX_POOL_SIZE),
    sharedClusterConnectionBudget: envNum('MYAI_DEDICATED_POOL_SHARED_CLUSTER_BUDGET', 400),
    cooldownMinutes: envNum('MYAI_DEDICATED_POOL_ALERT_COOLDOWN_MIN', 240),
  };
}

// ── Breach evaluation (pure) ──────────────────────────────────

export type DedicatedPoolAlertSeverity = 'warning' | 'critical';

export interface DedicatedPoolBreach {
  severity: DedicatedPoolAlertSeverity;
  dedicatedDbCount: number;
  estimatedConnections: number;
  budget: number;
  pctUsed: number;
  thresholdPct: number;
  maxDedicatedDbTenants: number;
}

/**
 * Evaluate live `dedicated-db` tenant count against the ceiling. A budget of
 * 0 (misconfiguration) or a non-positive per-tenant pool size gates
 * evaluation off entirely rather than dividing by zero or alerting on a
 * meaningless ceiling. Pure — unit-testable without I/O.
 */
export function evaluateDedicatedPoolBreach(
  dedicatedDbCount: number,
  cfg: DedicatedPoolAlertConfig,
): DedicatedPoolBreach | null {
  if (!(cfg.sharedClusterConnectionBudget > 0) || !(cfg.perTenantPoolSize > 0)) return null;

  const estimatedConnections = dedicatedDbCount * cfg.perTenantPoolSize;
  const pctUsed = (estimatedConnections / cfg.sharedClusterConnectionBudget) * 100;
  const maxDedicatedDbTenants = Math.floor(cfg.sharedClusterConnectionBudget / cfg.perTenantPoolSize);

  if (pctUsed < cfg.warnPct) return null;

  const severity: DedicatedPoolAlertSeverity = pctUsed >= cfg.criticalPct ? 'critical' : 'warning';
  return {
    severity,
    dedicatedDbCount,
    estimatedConnections,
    budget: cfg.sharedClusterConnectionBudget,
    pctUsed,
    thresholdPct: severity === 'critical' ? cfg.criticalPct : cfg.warnPct,
    maxDedicatedDbTenants,
  };
}

// ── Live count read ───────────────────────────────────────────

/**
 * Count `dedicated-db` bindings currently holding a live connection
 * (`migrating` or `active`). Never throws — a DB hiccup returns null so the
 * caller skips this cycle rather than alerting on a false zero.
 */
export async function countLiveDedicatedDbBindings(): Promise<number | null> {
  if (!isConnected()) return null;
  try {
    return await TenantDbBindingModel.countDocuments({
      isolationTier: 'dedicated-db',
      status: { $in: LIVE_STATUSES },
    });
  } catch (err) {
    log.warn({ err }, 'Failed to count dedicated-db bindings (suppressed)');
    return null;
  }
}

// ── Dedup watermark (status + cooldown, same shape as pool-capacity-drift-alerter) ─

const SEVERITY_RANK: Record<DedicatedPoolAlertSeverity, number> = { warning: 1, critical: 2 };

interface Watermark {
  severity: DedicatedPoolAlertSeverity;
  alertedAt: number;
}

let watermark: Watermark | null = null;

/** Clear dedup state (test helper / manual reset). */
export function clearDedicatedPoolWatermark(): void {
  watermark = null;
}

function shouldAlert(breach: DedicatedPoolBreach, cfg: DedicatedPoolAlertConfig, now: number): boolean {
  if (!watermark) return true;
  if (SEVERITY_RANK[breach.severity] > SEVERITY_RANK[watermark.severity]) return true;
  return now - watermark.alertedAt >= cfg.cooldownMinutes * 60 * 1000;
}

// ── Alert dispatch ────────────────────────────────────────────

function formatBreachMessage(b: DedicatedPoolBreach): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const icon = b.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
  return [
    `${icon} Dedicated-tier connection pool — ${b.pctUsed.toFixed(1)}% of the shared-cluster ceiling`,
    `dedicated-db tenants (live): ${b.dedicatedDbCount} of ${b.maxDedicatedDbTenants} max`,
    `Estimated held-open connections: ${b.estimatedConnections} of ${b.budget} budget`,
    '',
    b.severity === 'critical'
      ? 'Approaching the documented ceiling (ADR-030 MEDIUM flag) — stop selling/provisioning new dedicated-db tenants until the shared cluster is upgraded or MYAI_DEDICATED_POOL_SHARED_CLUSTER_BUDGET is revised upward against real Atlas headroom.'
      : 'Heads-up before the dedicated-tier connection-pool ceiling bites — plan a cluster upgrade or budget revision before selling more dedicated-db seats.',
    `Detected at ${timestamp} UTC`,
  ].join('\n');
}

async function sendTelegram(b: DedicatedPoolBreach): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ severity: b.severity }, 'No enabled Telegram adapter — dedicated-pool alert not sent to Telegram');
    return false;
  }
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ severity: b.severity }, 'TELEGRAM_DEFAULT_CHAT not set — dedicated-pool alert not sent to Telegram');
    return false;
  }
  try {
    await telegram.send(chatId, formatBreachMessage(b));
    return true;
  } catch (err) {
    log.error({ severity: b.severity, err }, 'Failed to send dedicated-pool Telegram alert');
    return false;
  }
}

// ── Main check runner ─────────────────────────────────────────

export interface DedicatedPoolCheckResult {
  ranAt: Date;
  countAvailable: boolean;
  dedicatedDbCount: number | null;
  breach: DedicatedPoolBreach | null;
  alertsFired: number;
  telegramSent: number;
}

/**
 * Read the live `dedicated-db` count, evaluate against the ceiling, and fire
 * an alert when newly breached (or escalated, or past cooldown). A drop back
 * under the warn threshold clears the watermark so the next breach alerts
 * immediately rather than waiting out the cooldown. Never throws.
 *
 * @param now injectable clock (epoch ms) for deterministic cooldown tests.
 */
export async function runDedicatedPoolCheck(now: number = Date.now()): Promise<DedicatedPoolCheckResult> {
  const ranAt = new Date(now);
  const empty: DedicatedPoolCheckResult = {
    ranAt,
    countAvailable: false,
    dedicatedDbCount: null,
    breach: null,
    alertsFired: 0,
    telegramSent: 0,
  };

  try {
    const cfg = dedicatedPoolAlertConfig();
    const dedicatedDbCount = await countLiveDedicatedDbBindings();
    if (dedicatedDbCount === null) {
      latestResult = empty;
      return empty;
    }

    const breach = evaluateDedicatedPoolBreach(dedicatedDbCount, cfg);

    let alertsFired = 0;
    let telegramSent = 0;
    if (!breach) {
      watermark = null; // recovered / under threshold this run — next breach alerts immediately
    } else if (shouldAlert(breach, cfg, now)) {
      watermark = { severity: breach.severity, alertedAt: now };
      alertsFired++;

      emitNotifyEvent({
        type: 'runner.dedicated_pool_capacity',
        tenantId: DEFAULT_TENANT_ID,
        title: `Dedicated-tier connection pool at ${breach.pctUsed.toFixed(0)}% of ceiling`,
        message: formatBreachMessage(breach),
        level: breach.severity,
        source: 'dedicated-pool-alerter',
        data: {
          dedicatedDbCount: breach.dedicatedDbCount,
          estimatedConnections: breach.estimatedConnections,
          budget: breach.budget,
          pctUsed: breach.pctUsed,
          thresholdPct: breach.thresholdPct,
          maxDedicatedDbTenants: breach.maxDedicatedDbTenants,
        },
      });

      if (await sendTelegram(breach)) telegramSent++;
      log.warn(
        { severity: breach.severity, dedicatedDbCount, pctUsed: breach.pctUsed },
        'Dedicated-pool capacity alert fired',
      );
    }

    const result: DedicatedPoolCheckResult = {
      ranAt,
      countAvailable: true,
      dedicatedDbCount,
      breach,
      alertsFired,
      telegramSent,
    };
    latestResult = result;
    return result;
  } catch (err) {
    log.warn({ err }, 'Dedicated-pool check failed (suppressed)');
    latestResult = empty;
    return empty;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: DedicatedPoolCheckResult | null = null;

/** Tenant-db-binding status changes are rare (provisioning/migration events, not high-frequency); 15 min matches the other pool alerters. */
const DEFAULT_INTERVAL_MINUTES = 15;

export function startDedicatedPoolAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Dedicated-pool alerts already running');
    return;
  }
  const cfg = dedicatedPoolAlertConfig();
  log.info(
    {
      intervalMinutes,
      warnPct: cfg.warnPct,
      criticalPct: cfg.criticalPct,
      perTenantPoolSize: cfg.perTenantPoolSize,
      sharedClusterConnectionBudget: cfg.sharedClusterConnectionBudget,
    },
    'Starting dedicated-pool alerts',
  );
  intervalId = setInterval(() => {
    runDedicatedPoolCheck().catch(err => log.error({ err }, 'Periodic dedicated-pool check failed'));
  }, intervalMinutes * 60 * 1000);
}

export function stopDedicatedPoolAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Dedicated-pool alerts stopped');
  }
}

export function isDedicatedPoolAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestDedicatedPoolCheckResult(): DedicatedPoolCheckResult | null {
  return latestResult;
}

/** Current configuration + state for status queries. */
export function getDedicatedPoolAlertStatus(): {
  active: boolean;
  intervalMinutes: number;
  warnPct: number;
  criticalPct: number;
  perTenantPoolSize: number;
  sharedClusterConnectionBudget: number;
  maxDedicatedDbTenants: number;
  cooldownMinutes: number;
  lastRun: Date | null;
  lastDedicatedDbCount: number | null;
} {
  const cfg = dedicatedPoolAlertConfig();
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    warnPct: cfg.warnPct,
    criticalPct: cfg.criticalPct,
    perTenantPoolSize: cfg.perTenantPoolSize,
    sharedClusterConnectionBudget: cfg.sharedClusterConnectionBudget,
    maxDedicatedDbTenants: cfg.perTenantPoolSize > 0 ? Math.floor(cfg.sharedClusterConnectionBudget / cfg.perTenantPoolSize) : 0,
    cooldownMinutes: cfg.cooldownMinutes,
    lastRun: latestResult?.ranAt ?? null,
    lastDedicatedDbCount: latestResult?.dedicatedDbCount ?? null,
  };
}
