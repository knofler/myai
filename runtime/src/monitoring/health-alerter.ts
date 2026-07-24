/**
 * Proactive health alerting system for the myAI gateway.
 *
 * Periodically runs comprehensive health checks across all subsystems and
 * sends notifications via Telegram when anything degrades or goes unhealthy.
 * Alert deduplication prevents notification spam: the same check in the same
 * status is not re-alerted within 2 hours unless its status changes.
 */

import { execSync } from 'node:child_process';
import { createChildLogger } from '../shared/logger.js';
import { isConnected, DEFAULT_TENANT_ID } from '../shared/db.js';
import { getAllProviderHealth } from '../llm/provider.js';
import { listRepoPaths, prioritizeRepos } from '../repos/repo-registry.js';
import { getAdapter } from '../channels/registry.js';
import { listSchedules } from '../scheduler/schedule-store.js';
import { getRunnerLiveness } from '../tasks/runner-heartbeat-store.js';
import { recordSample } from './uptime.js';

const log = createChildLogger({ module: 'health-alerter' });

// ── Types ─────────────────────────────────────────────────────

export interface HealthCheck {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  message: string;
  details?: Record<string, unknown>;
}

export interface HealthCheckResult {
  ranAt: Date;
  overall: 'healthy' | 'degraded' | 'unhealthy';
  checks: HealthCheck[];
  alertsSent: number;
}

// ── Alert deduplication state ─────────────────────────────────

interface AlertRecord {
  status: string;
  alertedAt: Date;
}

const alertHistory = new Map<string, AlertRecord>();

/** Dedup window: 2 hours in milliseconds. */
const DEDUP_WINDOW_MS = 2 * 60 * 60 * 1000;

/** Clear all alert history (useful for testing). */
export function clearAlertHistory(): void {
  alertHistory.clear();
}

// ── Interval management ───────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: HealthCheckResult | null = null;

/** Default check interval: 30 minutes. */
const DEFAULT_INTERVAL_MINUTES = 30;

// ── Individual health probes ──────────────────────────────────

function checkGateway(): HealthCheck {
  const uptimeSeconds = Math.floor(process.uptime());
  return {
    name: 'gateway',
    status: 'healthy',
    message: `Gateway running for ${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m`,
    details: { uptimeSeconds },
  };
}

function checkMongodb(): HealthCheck {
  const connected = isConnected();
  return {
    name: 'mongodb',
    status: connected ? 'healthy' : 'unhealthy',
    message: connected ? 'MongoDB connected' : 'MongoDB disconnected',
    details: { connected },
  };
}

function checkLlmProviders(): HealthCheck {
  try {
    const providers = getAllProviderHealth();
    const openCircuits = providers.filter(p => p.circuit.state === 'open');

    if (openCircuits.length === 0) {
      return {
        name: 'llm_providers',
        status: 'healthy',
        message: `All ${providers.length} provider circuit breakers closed`,
        details: { providerCount: providers.length },
      };
    }

    const openNames = openCircuits.map(p => p.provider).join(', ');
    const allOpen = openCircuits.length === providers.length && providers.length > 0;

    return {
      name: 'llm_providers',
      status: allOpen ? 'unhealthy' : 'degraded',
      message: `Circuit breaker open for: ${openNames}`,
      details: {
        providerCount: providers.length,
        openCircuits: openCircuits.map(p => ({
          provider: p.provider,
          failures: p.circuit.failures,
          lastFailure: p.circuit.lastFailure,
        })),
      },
    };
  } catch (err) {
    return {
      name: 'llm_providers',
      status: 'degraded',
      message: `Failed to check providers: ${(err as Error).message}`,
    };
  }
}

function checkRepoHealth(): HealthCheck {
  try {
    const repos = listRepoPaths();
    const issues: string[] = [];

    for (const repo of repos) {
      if (!repo.exists) {
        issues.push(`${repo.name}: path missing`);
      } else if (!repo.hasAiFolder) {
        issues.push(`${repo.name}: no AI folder`);
      } else if (!repo.hasHandoffFile) {
        issues.push(`${repo.name}: no handoff file`);
      }
    }

    if (issues.length === 0) {
      return {
        name: 'repos',
        status: 'healthy',
        message: `All ${repos.length} managed repos healthy`,
        details: { repoCount: repos.length },
      };
    }

    return {
      name: 'repos',
      status: issues.length > repos.length / 2 ? 'unhealthy' : 'degraded',
      message: `${issues.length} repo issue(s): ${issues.slice(0, 3).join('; ')}${issues.length > 3 ? ` (+${issues.length - 3} more)` : ''}`,
      details: { repoCount: repos.length, issueCount: issues.length, issues },
    };
  } catch (err) {
    return {
      name: 'repos',
      status: 'degraded',
      message: `Failed to check repos: ${(err as Error).message}`,
    };
  }
}

async function checkSchedulerHealth(): Promise<HealthCheck> {
  try {
    const schedules = await listSchedules(DEFAULT_TENANT_ID, {});
    const errorSchedules = schedules.filter(s => s.lastStatus === 'error');

    if (errorSchedules.length === 0) {
      return {
        name: 'scheduler',
        status: 'healthy',
        message: `${schedules.length} schedule(s), none in error state`,
        details: { scheduleCount: schedules.length },
      };
    }

    const errorNames = errorSchedules.map(s => s.name).join(', ');
    return {
      name: 'scheduler',
      status: 'degraded',
      message: `${errorSchedules.length} schedule(s) in error: ${errorNames}`,
      details: {
        scheduleCount: schedules.length,
        errorCount: errorSchedules.length,
        errorSchedules: errorSchedules.map(s => ({
          name: s.name,
          scheduleId: s.scheduleId,
          lastError: s.lastError,
        })),
      },
    };
  } catch (err) {
    // Scheduler requires MongoDB — gracefully degrade
    const message = (err as Error).message;
    return {
      name: 'scheduler',
      status: message.includes('MongoDB') ? 'degraded' : 'unhealthy',
      message: `Scheduler check failed: ${message}`,
    };
  }
}

/**
 * "Is the off-hours runner alive" — distinct from checkSchedulerHealth (which
 * checks the scheduler subsystem, not the CLI runner process) and from the
 * runner-lease store (which only has a doc while a runner holds a work slot).
 * unhealthy once no machine has heartbeated within DEFAULT_LIVENESS_THRESHOLD_MINUTES.
 */
async function checkRunnerLiveness(): Promise<HealthCheck> {
  try {
    const liveness = await getRunnerLiveness(DEFAULT_TENANT_ID);
    if (liveness.machines.length === 0) {
      return {
        name: 'runner_liveness',
        status: 'degraded',
        message: 'No runner heartbeat recorded yet',
        details: { thresholdMinutes: liveness.thresholdMinutes },
      };
    }
    if (!liveness.alive) {
      const mins = liveness.machines[0].minutesSince;
      return {
        name: 'runner_liveness',
        status: 'unhealthy',
        message: `Runner down — no heartbeat in ${mins}m (last seen ${liveness.lastMachine} at ${liveness.lastHeartbeatAt?.toISOString()})`,
        details: { thresholdMinutes: liveness.thresholdMinutes, machines: liveness.machines },
      };
    }
    return {
      name: 'runner_liveness',
      status: 'healthy',
      message: `Runner alive — last heartbeat ${liveness.machines[0].minutesSince}m ago (${liveness.lastMachine})`,
      details: { thresholdMinutes: liveness.thresholdMinutes, machines: liveness.machines },
    };
  } catch (err) {
    // MongoDB unreachable is covered by checkMongodb(); don't double-alert.
    const message = (err as Error).message;
    return {
      name: 'runner_liveness',
      status: message.includes('MongoDB') ? 'degraded' : 'unhealthy',
      message: `Runner liveness check failed: ${message}`,
    };
  }
}

function checkDiskAndDocker(): HealthCheck {
  try {
    // Check if Docker is available
    const dockerVersion = execSync('docker --version 2>/dev/null', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();

    // Check container health
    let containerInfo: string;
    try {
      containerInfo = execSync(
        'docker ps --format "{{.Names}}:{{.Status}}" 2>/dev/null',
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 },
      ).trim();
    } catch {
      return {
        name: 'docker',
        status: 'degraded',
        message: 'Docker available but cannot list containers',
        details: { dockerVersion },
      };
    }

    const containers = containerInfo
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [name, ...statusParts] = line.split(':');
        return { name, status: statusParts.join(':') };
      });

    const unhealthyContainers = containers.filter(
      c => c.status.toLowerCase().includes('unhealthy') || c.status.toLowerCase().includes('restarting'),
    );

    if (unhealthyContainers.length > 0) {
      const names = unhealthyContainers.map(c => c.name).join(', ');
      return {
        name: 'docker',
        status: 'degraded',
        message: `Unhealthy containers: ${names}`,
        details: { containerCount: containers.length, unhealthy: unhealthyContainers },
      };
    }

    return {
      name: 'docker',
      status: 'healthy',
      message: `${containers.length} container(s) running`,
      details: { containerCount: containers.length, dockerVersion },
    };
  } catch {
    // Docker not available is acceptable — many environments don't have it
    return {
      name: 'docker',
      status: 'healthy',
      message: 'Docker not available (skipped)',
      details: { available: false },
    };
  }
}

// ── Alert dispatch ────────────────────────────────────────────

function shouldAlert(check: HealthCheck): boolean {
  if (check.status === 'healthy') return false;

  const prev = alertHistory.get(check.name);
  if (!prev) return true;

  // Status changed from last alert
  if (prev.status !== check.status) return true;

  // Same status but dedup window expired
  const elapsed = Date.now() - prev.alertedAt.getTime();
  return elapsed >= DEDUP_WINDOW_MS;
}

function formatAlertMessage(check: HealthCheck): string {
  const emoji = check.status === 'unhealthy' ? '\u{1F6A8}' : '\u{26A0}️';
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return [
    `${emoji} Health Alert — ${check.name}`,
    `Status: ${check.status}`,
    check.message,
    '',
    `Checked at ${timestamp} UTC`,
  ].join('\n');
}

async function sendAlert(check: HealthCheck): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ check: check.name }, 'No enabled Telegram adapter — alert not sent');
    return false;
  }

  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ check: check.name }, 'TELEGRAM_DEFAULT_CHAT not set — alert not sent');
    return false;
  }

  try {
    const message = formatAlertMessage(check);
    await telegram.send(chatId, message);
    log.info({ check: check.name, status: check.status, chatId }, 'Health alert sent');
    return true;
  } catch (err) {
    log.error({ check: check.name, err }, 'Failed to send health alert');
    return false;
  }
}

// ── Main health check runner ──────────────────────────────────

export async function runHealthCheck(): Promise<HealthCheckResult> {
  const ranAt = new Date();
  log.info('Running health check cycle');

  const checks: HealthCheck[] = [];

  // Run all probes
  checks.push(checkGateway());
  checks.push(checkMongodb());
  checks.push(checkLlmProviders());
  checks.push(checkRepoHealth());
  checks.push(await checkSchedulerHealth());
  checks.push(await checkRunnerLiveness());
  checks.push(checkDiskAndDocker());

  // Determine overall status
  let overall: HealthCheckResult['overall'] = 'healthy';
  if (checks.some(c => c.status === 'unhealthy')) {
    overall = 'unhealthy';
  } else if (checks.some(c => c.status === 'degraded')) {
    overall = 'degraded';
  }

  // Send alerts for non-healthy checks (with deduplication)
  let alertsSent = 0;
  for (const check of checks) {
    if (shouldAlert(check)) {
      const sent = await sendAlert(check);
      if (sent) {
        alertsSent++;
        alertHistory.set(check.name, { status: check.status, alertedAt: new Date() });
      }
    }
    // Clear alert history when a check recovers to healthy
    if (check.status === 'healthy' && alertHistory.has(check.name)) {
      alertHistory.delete(check.name);
    }
  }

  const result: HealthCheckResult = { ranAt, overall, checks, alertsSent };
  latestResult = result;

  // Feed the uptime tracker so the public status page can report rolling
  // availability without a second service.
  recordSample(overall, ranAt.getTime());

  log.info({ overall, alertsSent, checkCount: checks.length }, 'Health check complete');
  return result;
}

// ── Lifecycle ─────────────────────────────────────────────────

export function startHealthAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Health alerts already running');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  log.info({ intervalMinutes }, 'Starting health alerts');

  // Run immediately on startup, then periodically
  runHealthCheck().catch(err => log.error({ err }, 'Initial health check failed'));

  intervalId = setInterval(() => {
    runHealthCheck().catch(err => log.error({ err }, 'Periodic health check failed'));
  }, intervalMs);
}

export function stopHealthAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Health alerts stopped');
  }
}

export function isHealthAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestHealthCheckResult(): HealthCheckResult | null {
  return latestResult;
}

/** Return the current alerting configuration and state for status queries. */
export function getHealthAlertStatus(): {
  active: boolean;
  intervalMinutes: number;
  lastRun: Date | null;
  lastOverall: string | null;
  dedupWindowHours: number;
  trackedAlerts: number;
} {
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    lastRun: latestResult?.ranAt ?? null,
    lastOverall: latestResult?.overall ?? null,
    dedupWindowHours: DEDUP_WINDOW_MS / (60 * 60 * 1000),
    trackedAlerts: alertHistory.size,
  };
}
