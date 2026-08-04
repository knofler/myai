/**
 * pool-capacity-drift-alerter — alert bridge for the pool-capacity
 * ground-truth self-check (task-0824a68e / task-05526048).
 *
 * scripts/lib/pool_capacity_drift.py + scripts/pool_capacity_drift_check.sh
 * re-derive claude-tech's daily/weekly spent-token figures directly from the
 * Claude Code transcripts and compare them against
 * state/pool-capacity.json's INCREMENTAL-ledger numbers (the same figures
 * pool-capacity-alerter.ts above alerts on for budget exhaustion). Until
 * this module, a detected drift only ever reached
 * ~/.ai-cli-runner/pool-capacity-drift.log — a bug in the snapshot writer (a
 * missed transcript, a lost snapshot marker across a runner restart, a
 * CLAUDE_CONFIG_DIR mismatch) could silently mis-route the
 * capability×cost×availability router (task-21dc2746) and the API-credit
 * reserve (task-874364a3) for days before a human happened to tail that log.
 *
 * Bridge: the wrapper script also writes
 * state/pool-capacity-drift-status.json on every run (checkedAt/
 * generatedAt/anyDrift/windows[]) — same bridge pattern as
 * pool_capacity_snapshot.sh -> pool-capacity-alerter.ts and
 * docker_vm_disk_snapshot.sh -> docker-vm-disk-alerter.ts. This module reads
 * that artifact and pushes the SAME alert channel pool-capacity-alerter.ts
 * uses (Telegram + dashboard bell/toast via emitNotifyEvent) instead of
 * drift staying log-only.
 *
 * Severity: a single window (day OR week) in DRIFT is a warning; BOTH
 * windows drifting simultaneously is a systemic signal (not just one
 * in-flight session's timing) and escalates to critical.
 *
 * Dedup: status + time cooldown, same shape as docker-vm-disk-alerter — a
 * still-breached status doesn't re-alert until the cooldown elapses (default
 * 4h; the producer fires every ~10min runner cycle, so without a cooldown a
 * persistent drift would spam every cycle). An escalation (warning->critical)
 * always fires immediately. Recovery to no-drift clears the watermark.
 */
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../shared/config.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'pool-capacity-drift-alerter' });

// ── Artifact schema (written by scripts/pool_capacity_drift_check.sh) ─────

export interface PoolCapacityDriftWindow {
  label: 'day' | 'week' | string;
  status: 'OK' | 'DRIFT' | string;
  recorded: number;
  actual: number;
  diff: number;
  diffPct: number;
  tolPct: number;
  tolFloor: number;
  windowStart: string;
  windowEnd: string;
}

export interface PoolCapacityDriftStatusSnapshot {
  checkedAt: string;
  generatedAt?: string;
  pool?: string;
  /** Non-null when the check couldn't run (no snapshot, missing pool, bad timestamp) — never alerts. */
  skipped?: string | null;
  anyDrift: boolean;
  windows: PoolCapacityDriftWindow[];
}

// ── Config ────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface PoolCapacityDriftAlertConfig {
  staleHours: number;
  cooldownMinutes: number;
}

/** Read thresholds from env at call time so tests (and a gateway restart) pick up changes. */
export function poolCapacityDriftAlertConfig(): PoolCapacityDriftAlertConfig {
  return {
    staleHours: envNum('MYAI_POOL_DRIFT_ALERT_STALE_HOURS', 6),
    cooldownMinutes: envNum('MYAI_POOL_DRIFT_ALERT_COOLDOWN_MIN', 240),
  };
}

// ── Breach evaluation (pure) ──────────────────────────────────

export type PoolCapacityDriftSeverity = 'warning' | 'critical';

export interface PoolCapacityDriftBreach {
  severity: PoolCapacityDriftSeverity;
  windows: PoolCapacityDriftWindow[];
}

/**
 * Evaluate the snapshot for a drift breach. Never alerts when the check was
 * skipped or reported no drift. Both windows breached at once escalates to
 * critical — a single-window drift may just be an in-flight session's
 * not-yet-charged tokens near a boundary, but agreement failing on BOTH the
 * day and week windows simultaneously points at a real ledger bug. Pure —
 * unit-testable without I/O.
 */
export function evaluatePoolCapacityDriftBreach(
  snapshot: PoolCapacityDriftStatusSnapshot,
): PoolCapacityDriftBreach | null {
  if (snapshot.skipped || !snapshot.anyDrift) return null;
  const drifted = (snapshot.windows || []).filter(w => w.status === 'DRIFT');
  if (drifted.length === 0) return null;
  const severity: PoolCapacityDriftSeverity = drifted.length >= 2 ? 'critical' : 'warning';
  return { severity, windows: drifted };
}

// ── Artifact read ─────────────────────────────────────────────

/** Read + minimally validate the artifact. Null when missing/malformed — never throws. */
export async function readPoolCapacityDriftStatusSnapshot(): Promise<PoolCapacityDriftStatusSnapshot | null> {
  const file = resolve(getConfig().aiRoot, 'state', 'pool-capacity-drift-status.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null; // producer hasn't run yet — normal on a fresh install
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PoolCapacityDriftStatusSnapshot>;
    if (typeof parsed.checkedAt !== 'string' || typeof parsed.anyDrift !== 'boolean' || !Array.isArray(parsed.windows)) {
      log.warn({ file }, 'pool-capacity-drift-status artifact malformed — ignoring');
      return null;
    }
    return parsed as PoolCapacityDriftStatusSnapshot;
  } catch (err) {
    log.warn({ err, file }, 'pool-capacity-drift-status artifact unparseable — ignoring');
    return null;
  }
}

// ── Dedup watermark (status + time, same shape as docker-vm-disk-alerter) ─

const SEVERITY_RANK: Record<PoolCapacityDriftSeverity, number> = { warning: 1, critical: 2 };

interface Watermark {
  severity: PoolCapacityDriftSeverity;
  alertedAt: number;
}

let watermark: Watermark | null = null;

/** Clear dedup state (test helper / manual reset). */
export function clearPoolCapacityDriftWatermark(): void {
  watermark = null;
}

/**
 * True when this breach should fire now: no prior alert, a severity
 * escalation (warning->critical fires immediately), or the cooldown window
 * has elapsed since the last alert at this-or-higher severity.
 */
function shouldAlert(breach: PoolCapacityDriftBreach, cfg: PoolCapacityDriftAlertConfig, now: number): boolean {
  if (!watermark) return true;
  if (SEVERITY_RANK[breach.severity] > SEVERITY_RANK[watermark.severity]) return true;
  return now - watermark.alertedAt >= cfg.cooldownMinutes * 60 * 1000;
}

// ── Alert dispatch ────────────────────────────────────────────

function formatBreachMessage(b: PoolCapacityDriftBreach): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const icon = b.severity === 'critical' ? '\u{1F6A8}' : '\u{26A0}\u{FE0F}';
  const lines = [
    `${icon} Pool Capacity Drift — claude-tech ledger disagrees with transcripts`,
    ...b.windows.map(
      w =>
        `${w.label}: recorded=${w.recorded.toLocaleString('en-US')} actual=${w.actual.toLocaleString(
          'en-US',
        )} diff=${w.diff.toLocaleString('en-US')} (${w.diffPct.toFixed(1)}%, tol ${w.tolPct}%/${w.tolFloor.toLocaleString('en-US')} tok)`,
    ),
    '',
    b.severity === 'critical'
      ? 'Both day and week windows drifted at once — the incremental ledger (scripts/lib/session_tokens.py) likely lost a snapshot marker or missed a transcript. The router and API-credit reserve trust this ledger as ground truth.'
      : 'One window drifted beyond tolerance — may self-resolve as the window rolls, but check ~/.ai-cli-runner/pool-capacity-drift.log if it persists.',
    `Detected at ${timestamp} UTC`,
  ];
  return lines.join('\n');
}

async function sendTelegram(b: PoolCapacityDriftBreach): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ severity: b.severity }, 'No enabled Telegram adapter — pool-capacity-drift alert not sent to Telegram');
    return false;
  }
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ severity: b.severity }, 'TELEGRAM_DEFAULT_CHAT not set — pool-capacity-drift alert not sent to Telegram');
    return false;
  }
  try {
    await telegram.send(chatId, formatBreachMessage(b));
    return true;
  } catch (err) {
    log.error({ severity: b.severity, err }, 'Failed to send pool-capacity-drift Telegram alert');
    return false;
  }
}

// ── Main check runner ─────────────────────────────────────────

export interface PoolCapacityDriftCheckResult {
  ranAt: Date;
  snapshotAvailable: boolean;
  breach: PoolCapacityDriftBreach | null;
  alertsFired: number;
  telegramSent: number;
}

/**
 * Read the artifact, evaluate for drift, and fire an alert when newly
 * breached (or escalated, or past the cooldown). A drop back to no-drift
 * clears the watermark so the next breach alerts immediately rather than
 * waiting out the cooldown. Never throws.
 *
 * @param now injectable clock (epoch ms) for deterministic staleness tests.
 */
export async function runPoolCapacityDriftCheck(now: number = Date.now()): Promise<PoolCapacityDriftCheckResult> {
  const ranAt = new Date(now);
  const empty: PoolCapacityDriftCheckResult = { ranAt, snapshotAvailable: false, breach: null, alertsFired: 0, telegramSent: 0 };

  try {
    const cfg = poolCapacityDriftAlertConfig();
    const snapshot = await readPoolCapacityDriftStatusSnapshot();
    if (!snapshot) {
      latestResult = empty;
      return empty;
    }

    const ageHours = (now - new Date(snapshot.checkedAt).getTime()) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > cfg.staleHours) {
      log.debug({ checkedAt: snapshot.checkedAt, staleHours: cfg.staleHours }, 'pool-capacity-drift-status artifact stale — skipping');
      latestResult = empty;
      return empty;
    }

    const breach = evaluatePoolCapacityDriftBreach(snapshot);

    let alertsFired = 0;
    let telegramSent = 0;
    if (!breach) {
      watermark = null; // recovered / no drift this run — next breach alerts immediately
    } else if (shouldAlert(breach, cfg, now)) {
      watermark = { severity: breach.severity, alertedAt: now };
      alertsFired++;

      emitNotifyEvent({
        type: 'runner.pool_capacity_drift',
        tenantId: DEFAULT_TENANT_ID,
        title: breach.severity === 'critical' ? 'Pool-capacity drift: CRITICAL' : 'Pool-capacity drift: warning',
        message: formatBreachMessage(breach),
        level: breach.severity,
        source: 'pool-capacity-drift-alerter',
        data: {
          severity: breach.severity,
          windows: breach.windows,
        },
      });

      if (await sendTelegram(breach)) telegramSent++;
      log.info({ severity: breach.severity, windows: breach.windows.map(w => w.label) }, 'Pool-capacity-drift alert fired');
    }

    const result: PoolCapacityDriftCheckResult = { ranAt, snapshotAvailable: true, breach, alertsFired, telegramSent };
    latestResult = result;
    return result;
  } catch (err) {
    log.warn({ err }, 'Pool-capacity-drift check failed (suppressed)');
    latestResult = empty;
    return empty;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: PoolCapacityDriftCheckResult | null = null;

/** The producer refreshes on each runner fire (~10 min cadence); 15 min here is plenty. */
const DEFAULT_INTERVAL_MINUTES = 15;

export function startPoolCapacityDriftAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Pool-capacity-drift alerts already running');
    return;
  }
  const cfg = poolCapacityDriftAlertConfig();
  log.info({ intervalMinutes, staleHours: cfg.staleHours, cooldownMinutes: cfg.cooldownMinutes }, 'Starting pool-capacity-drift alerts');
  intervalId = setInterval(() => {
    runPoolCapacityDriftCheck().catch(err => log.error({ err }, 'Periodic pool-capacity-drift check failed'));
  }, intervalMinutes * 60 * 1000);
}

export function stopPoolCapacityDriftAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Pool-capacity-drift alerts stopped');
  }
}

export function isPoolCapacityDriftAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestPoolCapacityDriftCheckResult(): PoolCapacityDriftCheckResult | null {
  return latestResult;
}

/** Current configuration + state for status queries. */
export function getPoolCapacityDriftAlertStatus(): {
  active: boolean;
  intervalMinutes: number;
  staleHours: number;
  cooldownMinutes: number;
  lastRun: Date | null;
  lastBreach: PoolCapacityDriftSeverity | null;
} {
  const cfg = poolCapacityDriftAlertConfig();
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    staleHours: cfg.staleHours,
    cooldownMinutes: cfg.cooldownMinutes,
    lastRun: latestResult?.ranAt ?? null,
    lastBreach: latestResult?.breach?.severity ?? null,
  };
}
