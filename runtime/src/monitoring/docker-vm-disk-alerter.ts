/**
 * docker-vm-disk-alerter — proactive Docker VM disk-pressure guard.
 *
 * RUNBOOK.md #1 ("Docker VM disk 100% full → local mongo WT_PANIC
 * crash-loop") documents a real incident (19 Jul 2026: disk hit 100%, 0 B
 * free of 125 GB, myai-mongo entered a 3,141-restart crash-loop before it
 * was caught) as a manual verify/fix/confirm recipe an operator runs BY
 * HAND *after* the crash already happened. Unlike the 2GB RAM-ceiling guard
 * (hooks/session/13-ram-guard.sh, CLAUDE.md "2 GB RAM ceiling check"), which
 * catches its failure mode BEFORE it bites, there was no proactive check for
 * disk pressure. This module closes that gap the same way
 * pool-capacity-alerter.ts / mongo-mirror-alerter.ts closed it for their
 * failure modes.
 *
 * Bridge: scripts/docker_vm_disk_snapshot.sh runs the runbook's own
 * read-only Verify step (`docker run --rm alpine df -P /` — disk INSIDE the
 * Docker VM, not the host's `df -h /`, which is a separate filesystem on
 * Docker Desktop) and writes state/docker-vm-disk-status.json. The gateway
 * runs in Docker and cannot itself `docker run` against the host's Docker
 * VM, so the host-side snapshot is the only way in — same bridge pattern as
 * runner_health.sh / pool_capacity_snapshot.sh / mongo_mirror_status_snapshot.sh.
 * Piggybacks on the runner's own fire loop (cli_task_runner.sh calls it
 * alongside the other snapshot scripts).
 *
 * Alert conditions (env-configurable):
 *   MYAI_DOCKER_DISK_ALERT_PCT           — warning when pctUsed >= this (default 80)
 *   MYAI_DOCKER_DISK_ALERT_PCT_CRITICAL  — critical when pctUsed >= this (default 90)
 *   MYAI_DOCKER_DISK_ALERT_STALE_HOURS   — skip artifacts older than this (default 6):
 *                                          a dead producer must not alert on stale numbers
 *
 * Dedup: status + time-based, same shape as health-alerter.ts — the same
 * severity is not re-alerted within a cooldown window (default 2h), but a
 * severity CHANGE (warning→critical, or a drop back to ok) always re-alerts
 * (or, for a drop to ok, simply clears the watermark so the next breach
 * alerts immediately). State lives in-process, same as the other alerters —
 * a live operational alerter, not a store.
 *
 * Delivery: Telegram (channels adapter + TELEGRAM_DEFAULT_CHAT) AND
 * emitNotifyEvent → dashboard bell/toast + durable history — the notify
 * event is in-process and always lands, so the dedup watermark advances even
 * when Telegram is unconfigured.
 */
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../shared/config.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'docker-vm-disk-alerter' });

// ── Artifact schema (written by scripts/docker_vm_disk_snapshot.sh) ───────

export interface DockerVmDiskStatusSnapshot {
  generatedAt: string;
  /** Docker unavailable when the snapshot ran (daemon down, no `docker` on PATH) → never alerts. */
  available: boolean;
  pctUsed: number | null;
  usedKb: number | null;
  totalKb: number | null;
  availableKb: number | null;
}

// ── Config ────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface DockerVmDiskAlertConfig {
  warnPct: number;
  criticalPct: number;
  staleHours: number;
}

/** Read thresholds from env at call time so tests (and a gateway restart) pick up changes. */
export function dockerVmDiskAlertConfig(): DockerVmDiskAlertConfig {
  return {
    warnPct: envNum('MYAI_DOCKER_DISK_ALERT_PCT', 80),
    criticalPct: envNum('MYAI_DOCKER_DISK_ALERT_PCT_CRITICAL', 90),
    staleHours: envNum('MYAI_DOCKER_DISK_ALERT_STALE_HOURS', 6),
  };
}

/** Re-alert cooldown for a still-breached status (minutes). */
const COOLDOWN_MINUTES = envNum('MYAI_DOCKER_DISK_ALERT_COOLDOWN_MIN', 120);

// ── Breach evaluation (pure) ──────────────────────────────────

export type DockerVmDiskSeverity = 'warning' | 'critical';

export interface DockerVmDiskBreach {
  severity: DockerVmDiskSeverity;
  pctUsed: number;
  thresholdPct: number;
}

/**
 * Evaluate the snapshot against the warn/critical thresholds. Never alerts
 * when Docker was unavailable at snapshot time or pctUsed is missing/absurd
 * (RUNBOOK.md #1's own Verify step is the source of truth; a malformed
 * reading must not fire). Pure — unit-testable without I/O.
 */
export function evaluateDockerVmDiskBreach(
  snapshot: DockerVmDiskStatusSnapshot,
  cfg: DockerVmDiskAlertConfig,
): DockerVmDiskBreach | null {
  if (!snapshot.available) return null;
  const pct = snapshot.pctUsed;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return null;
  if (pct < cfg.warnPct) return null;

  const severity: DockerVmDiskSeverity = pct >= cfg.criticalPct ? 'critical' : 'warning';
  return {
    severity,
    pctUsed: pct,
    thresholdPct: severity === 'critical' ? cfg.criticalPct : cfg.warnPct,
  };
}

// ── Artifact read ─────────────────────────────────────────────

/** Read + minimally validate the artifact. Null when missing/malformed — never throws. */
export async function readDockerVmDiskStatusSnapshot(): Promise<DockerVmDiskStatusSnapshot | null> {
  const file = resolve(getConfig().aiRoot, 'state', 'docker-vm-disk-status.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null; // producer hasn't run yet — normal on a fresh install
  }
  try {
    const parsed = JSON.parse(raw) as Partial<DockerVmDiskStatusSnapshot>;
    if (typeof parsed.generatedAt !== 'string' || typeof parsed.available !== 'boolean') {
      log.warn({ file }, 'docker-vm-disk-status artifact malformed — ignoring');
      return null;
    }
    return parsed as DockerVmDiskStatusSnapshot;
  } catch (err) {
    log.warn({ err, file }, 'docker-vm-disk-status artifact unparseable — ignoring');
    return null;
  }
}

// ── Dedup watermark (status + time, same shape as health-alerter) ─────────

const SEVERITY_RANK: Record<DockerVmDiskSeverity, number> = { warning: 1, critical: 2 };

interface Watermark {
  severity: DockerVmDiskSeverity;
  alertedAt: number;
}

let watermark: Watermark | null = null;

/** Clear dedup state (test helper / manual reset). */
export function clearDockerVmDiskWatermark(): void {
  watermark = null;
}

/**
 * True when this breach should fire now: no prior alert, a severity
 * escalation (warning→critical fires immediately), or the cooldown window
 * has elapsed since the last alert at this-or-higher severity.
 */
function shouldAlert(breach: DockerVmDiskBreach, now: number): boolean {
  if (!watermark) return true;
  if (SEVERITY_RANK[breach.severity] > SEVERITY_RANK[watermark.severity]) return true;
  return now - watermark.alertedAt >= COOLDOWN_MINUTES * 60 * 1000;
}

// ── Alert dispatch ────────────────────────────────────────────

function formatBreachMessage(b: DockerVmDiskBreach): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const icon = b.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
  const lines = [
    `${icon} Docker VM disk — ${b.pctUsed.toFixed(0)}% full (threshold ${b.thresholdPct}%)`,
    '',
    b.severity === 'critical'
      ? 'Close to RUNBOOK.md #1’s WT_PANIC crash-loop threshold (myai-mongo panics at 100%). Run `docker builder prune -af && docker image prune -af` now.'
      : 'Heads-up before RUNBOOK.md #1’s WT_PANIC crash-loop bites — consider `docker builder prune -af && docker image prune -af`.',
    `Detected at ${timestamp} UTC`,
  ];
  return lines.join('\n');
}

async function sendTelegram(b: DockerVmDiskBreach): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ severity: b.severity }, 'No enabled Telegram adapter — docker-vm-disk alert not sent to Telegram');
    return false;
  }
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ severity: b.severity }, 'TELEGRAM_DEFAULT_CHAT not set — docker-vm-disk alert not sent to Telegram');
    return false;
  }
  try {
    await telegram.send(chatId, formatBreachMessage(b));
    return true;
  } catch (err) {
    log.error({ severity: b.severity, err }, 'Failed to send docker-vm-disk Telegram alert');
    return false;
  }
}

// ── Main check runner ─────────────────────────────────────────

export interface DockerVmDiskCheckResult {
  ranAt: Date;
  snapshotAvailable: boolean;
  breach: DockerVmDiskBreach | null;
  alertsFired: number;
  telegramSent: number;
}

/**
 * Read the artifact, evaluate the disk-pressure threshold, and fire an
 * alert when newly breached (or escalated, or past the cooldown). A drop
 * back below the warn threshold clears the watermark so the next breach
 * alerts immediately rather than waiting out the cooldown. Never throws.
 *
 * @param now injectable clock (epoch ms) for deterministic staleness tests.
 */
export async function runDockerVmDiskCheck(now: number = Date.now()): Promise<DockerVmDiskCheckResult> {
  const ranAt = new Date(now);
  const empty: DockerVmDiskCheckResult = { ranAt, snapshotAvailable: false, breach: null, alertsFired: 0, telegramSent: 0 };

  try {
    const cfg = dockerVmDiskAlertConfig();
    const snapshot = await readDockerVmDiskStatusSnapshot();
    if (!snapshot) {
      latestResult = empty;
      return empty;
    }

    const ageHours = (now - new Date(snapshot.generatedAt).getTime()) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > cfg.staleHours) {
      log.debug({ generatedAt: snapshot.generatedAt, staleHours: cfg.staleHours }, 'docker-vm-disk-status artifact stale — skipping');
      latestResult = empty;
      return empty;
    }

    const breach = evaluateDockerVmDiskBreach(snapshot, cfg);

    let alertsFired = 0;
    let telegramSent = 0;
    if (!breach) {
      watermark = null; // recovered below warnPct — next breach alerts immediately
    } else if (shouldAlert(breach, now)) {
      watermark = { severity: breach.severity, alertedAt: now };
      alertsFired++;

      emitNotifyEvent({
        type: 'runner.docker_vm_disk',
        tenantId: DEFAULT_TENANT_ID,
        title: breach.severity === 'critical' ? 'Docker VM disk: CRITICAL' : 'Docker VM disk: warning',
        message: formatBreachMessage(breach),
        level: breach.severity,
        source: 'docker-vm-disk-alerter',
        data: { severity: breach.severity, pctUsed: breach.pctUsed, thresholdPct: breach.thresholdPct },
      });

      if (await sendTelegram(breach)) telegramSent++;
      log.info({ severity: breach.severity, pctUsed: breach.pctUsed }, 'Docker-vm-disk alert fired');
    }

    const result: DockerVmDiskCheckResult = { ranAt, snapshotAvailable: true, breach, alertsFired, telegramSent };
    latestResult = result;
    return result;
  } catch (err) {
    log.warn({ err }, 'Docker-vm-disk check failed (suppressed)');
    latestResult = empty;
    return empty;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: DockerVmDiskCheckResult | null = null;

/** The producer refreshes on each runner fire; 15 min here is plenty. */
const DEFAULT_INTERVAL_MINUTES = 15;

export function startDockerVmDiskAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Docker-vm-disk alerts already running');
    return;
  }
  log.info({ intervalMinutes }, 'Starting docker-vm-disk alerts');
  intervalId = setInterval(() => {
    runDockerVmDiskCheck().catch(err => log.error({ err }, 'Periodic docker-vm-disk check failed'));
  }, intervalMinutes * 60 * 1000);
}

export function stopDockerVmDiskAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Docker-vm-disk alerts stopped');
  }
}

export function isDockerVmDiskAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestDockerVmDiskCheckResult(): DockerVmDiskCheckResult | null {
  return latestResult;
}
