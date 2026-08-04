/**
 * mongo-mirror-alerter — pushes an alert when the scheduled Atlas→local mongo
 * mirror silently starts failing, instead of requiring someone to run
 * `myai doctor` to find out (task-906c973f).
 *
 * `myai doctor`'s "mongo mirror schedule" check (task-b4c58215, commit
 * 2a2813c) already computes not-scheduled/never-run/last-run-FAILED/stale
 * states from $MYAI_HOME/mongo-mirror.last, but it's on-demand only — exactly
 * the "someone has to check the page" gap pool-capacity-alerter.ts closed for
 * subscription-pool budgets. This module closes it for the mirror.
 *
 * Bridge: scripts/mongo_mirror_status_snapshot.sh runs the same host-side
 * status derivation as `myai doctor` (mirrorScheduleStatus() in bin/myai.cjs)
 * and writes state/mongo-mirror-status.json INTO the repo — the gateway runs
 * in Docker and cannot see $MYAI_HOME on the host, same bridge pattern as
 * runner_health.sh / pool_capacity_snapshot.sh. Piggybacks on the runner's
 * own fire loop (cli_task_runner.sh calls it alongside pool_capacity_snapshot.sh).
 *
 * Alert conditions (only when a schedule is actually installed — "not
 * scheduled" is an accepted, opt-in default per MONGO_MIRROR.md and never
 * alerts):
 *   - failed: the last recorded run's rc !== 0
 *   - stale:  the last successful run is older than 2 missed fires (mirrors
 *             doctor's mirrorStaleMin: max(interval*2, 120min); unknown
 *             interval (cron) → 26h)
 *
 * Dedup: keyed on `${condition}:${lastRunEpoch}` — a repeat check against the
 * SAME last-run record (stale, ticking every runner fire) alerts once; a NEW
 * run landing (success or a fresh failure, new epoch) is eligible to alert
 * again. State lives in-process, same as pool-capacity-alerter/queue-wait-alerter.
 *
 * Delivery: Telegram (channels adapter + TELEGRAM_DEFAULT_CHAT) AND
 * emitNotifyEvent → dashboard bell/toast + durable history — the notify event
 * is in-process and always lands, so the dedup watermark advances even when
 * Telegram is unconfigured.
 */
import { promises as fs } from 'fs';
import { resolve } from 'path';
import { getConfig } from '../shared/config.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'mongo-mirror-alerter' });

// ── Artifact schema (written by scripts/mongo_mirror_status_snapshot.sh) ──

export interface MongoMirrorStatusSnapshot {
  generatedAt: string;
  /** Whether a launchd plist (macOS) / tagged crontab line (Linux) is installed. */
  installed: boolean;
  /** Fire cadence in seconds, when known (launchd StartInterval; cron → null). */
  intervalSec: number | null;
  /** Last recorded run from $MYAI_HOME/mongo-mirror.last, or null if none yet. */
  last: { epoch: number; rc: number; direction: string; db: string } | null;
}

// ── Config ────────────────────────────────────────────────────

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface MongoMirrorAlertConfig {
  /** Skip artifacts older than this (default 26h — a dead producer must not alert on stale numbers). */
  staleHours: number;
}

export function mongoMirrorAlertConfig(): MongoMirrorAlertConfig {
  return {
    staleHours: envNum('MYAI_MIRROR_ALERT_STALE_HOURS', 26),
  };
}

// ── Breach evaluation (pure) ──────────────────────────────────

export type MongoMirrorCondition = 'failed' | 'stale';

export interface MongoMirrorBreach {
  condition: MongoMirrorCondition;
  lastRunEpoch: number;
  rc: number;
  ageMinutes: number;
}

/**
 * Mirrors doctor's mirrorStaleMin: two missed fires (floor 2h); unknown
 * interval (cron) → 26h.
 */
function staleMinutesFor(intervalSec: number | null): number {
  return intervalSec ? Math.max((intervalSec / 60) * 2, 120) : 26 * 60;
}

/**
 * Evaluate the snapshot for a breach. Never alerts when no schedule is
 * installed (opt-in, expected default) or when there's no run recorded yet
 * (freshly installed — not a failure). Pure — unit-testable without I/O.
 */
export function evaluateMongoMirrorBreach(
  snapshot: MongoMirrorStatusSnapshot,
  now: number,
): MongoMirrorBreach | null {
  if (!snapshot.installed || !snapshot.last) return null;

  const ageMinutes = (now - snapshot.last.epoch * 1000) / 60_000;

  if (snapshot.last.rc !== 0) {
    return { condition: 'failed', lastRunEpoch: snapshot.last.epoch, rc: snapshot.last.rc, ageMinutes };
  }

  const staleMin = staleMinutesFor(snapshot.intervalSec);
  if (ageMinutes > staleMin) {
    return { condition: 'stale', lastRunEpoch: snapshot.last.epoch, rc: snapshot.last.rc, ageMinutes };
  }

  return null;
}

// ── Artifact read ─────────────────────────────────────────────

/** Read + minimally validate the artifact. Null when missing/malformed — never throws. */
export async function readMongoMirrorStatusSnapshot(): Promise<MongoMirrorStatusSnapshot | null> {
  const file = resolve(getConfig().aiRoot, 'state', 'mongo-mirror-status.json');
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return null; // producer hasn't run yet — normal on a fresh install
  }
  try {
    const parsed = JSON.parse(raw) as Partial<MongoMirrorStatusSnapshot>;
    if (typeof parsed.generatedAt !== 'string' || typeof parsed.installed !== 'boolean') {
      log.warn({ file }, 'mongo-mirror-status artifact malformed — ignoring');
      return null;
    }
    return parsed as MongoMirrorStatusSnapshot;
  } catch (err) {
    log.warn({ err, file }, 'mongo-mirror-status artifact unparseable — ignoring');
    return null;
  }
}

// ── Per-condition dedup watermark ──────────────────────────────

/** key: `${condition}:${lastRunEpoch}` → already alerted. */
const alerted = new Set<string>();

/** Clear dedup state (test helper / manual reset). */
export function clearMongoMirrorWatermarks(): void {
  alerted.clear();
}

// ── Alert dispatch ────────────────────────────────────────────

function formatBreachMessage(b: MongoMirrorBreach): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const ageStr = b.ageMinutes < 120 ? `${Math.round(b.ageMinutes)}m` : `${Math.round(b.ageMinutes / 60)}h`;
  const lines =
    b.condition === 'failed'
      ? [
          `\u{1F6A8} Mongo mirror — last scheduled run FAILED (rc=${b.rc})`,
          `Ran: ${ageStr} ago`,
          'The Atlas→local mirror is not producing a fresh local copy; see ~/.myai/logs/mongo-mirror.err',
        ]
      : [
          `\u{26A0}\u{FE0F} Mongo mirror — schedule appears STALE`,
          `Last successful run: ${ageStr} ago (more than 2 missed fires)`,
          'The scheduled job may have stopped firing — check `myai mirror --schedule-status`',
        ];
  lines.push('', `Detected at ${timestamp} UTC`);
  return lines.join('\n');
}

async function sendTelegram(b: MongoMirrorBreach): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ condition: b.condition }, 'No enabled Telegram adapter — mongo-mirror alert not sent to Telegram');
    return false;
  }
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ condition: b.condition }, 'TELEGRAM_DEFAULT_CHAT not set — mongo-mirror alert not sent to Telegram');
    return false;
  }
  try {
    await telegram.send(chatId, formatBreachMessage(b));
    return true;
  } catch (err) {
    log.error({ condition: b.condition, err }, 'Failed to send mongo-mirror Telegram alert');
    return false;
  }
}

// ── Main check runner ─────────────────────────────────────────

export interface MongoMirrorCheckResult {
  ranAt: Date;
  snapshotAvailable: boolean;
  breach: MongoMirrorBreach | null;
  alertsFired: number;
  telegramSent: number;
}

/**
 * Read the artifact, evaluate the mirror's schedule health, and fire an
 * alert when it's newly failed/stale past the dedup watermark. Never throws.
 *
 * @param now injectable clock (epoch ms) for deterministic staleness tests.
 */
export async function runMongoMirrorCheck(now: number = Date.now()): Promise<MongoMirrorCheckResult> {
  const ranAt = new Date(now);
  const empty: MongoMirrorCheckResult = { ranAt, snapshotAvailable: false, breach: null, alertsFired: 0, telegramSent: 0 };

  try {
    const cfg = mongoMirrorAlertConfig();
    const snapshot = await readMongoMirrorStatusSnapshot();
    if (!snapshot) {
      latestResult = empty;
      return empty;
    }

    const ageHours = (now - new Date(snapshot.generatedAt).getTime()) / 3_600_000;
    if (!Number.isFinite(ageHours) || ageHours > cfg.staleHours) {
      log.debug({ generatedAt: snapshot.generatedAt, staleHours: cfg.staleHours }, 'mongo-mirror-status artifact stale — skipping');
      latestResult = empty;
      return empty;
    }

    const breach = evaluateMongoMirrorBreach(snapshot, now);

    let alertsFired = 0;
    let telegramSent = 0;
    if (breach) {
      const key = `${breach.condition}:${breach.lastRunEpoch}`;
      if (!alerted.has(key)) {
        alerted.add(key);
        alertsFired++;

        emitNotifyEvent({
          type: 'runner.mongo_mirror',
          tenantId: DEFAULT_TENANT_ID,
          title: breach.condition === 'failed' ? 'Mongo mirror: last run FAILED' : 'Mongo mirror: schedule stale',
          message: formatBreachMessage(breach),
          level: breach.condition === 'failed' ? 'critical' : 'warning',
          source: 'mongo-mirror-alerter',
          data: {
            condition: breach.condition,
            lastRunEpoch: breach.lastRunEpoch,
            rc: breach.rc,
            ageMinutes: breach.ageMinutes,
          },
        });

        if (await sendTelegram(breach)) telegramSent++;
        log.info({ condition: breach.condition, ageMinutes: breach.ageMinutes, rc: breach.rc }, 'Mongo-mirror alert fired');
      }
    }

    const result: MongoMirrorCheckResult = { ranAt, snapshotAvailable: true, breach, alertsFired, telegramSent };
    latestResult = result;
    return result;
  } catch (err) {
    log.warn({ err }, 'Mongo-mirror check failed (suppressed)');
    latestResult = empty;
    return empty;
  }
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: MongoMirrorCheckResult | null = null;

/** The producer refreshes on each runner fire; 15 min here is plenty. */
const DEFAULT_INTERVAL_MINUTES = 15;

export function startMongoMirrorAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Mongo-mirror alerts already running');
    return;
  }
  log.info({ intervalMinutes }, 'Starting mongo-mirror alerts');
  intervalId = setInterval(() => {
    runMongoMirrorCheck().catch(err => log.error({ err }, 'Periodic mongo-mirror check failed'));
  }, intervalMinutes * 60 * 1000);
}

export function stopMongoMirrorAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Mongo-mirror alerts stopped');
  }
}

export function isMongoMirrorAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestMongoMirrorCheckResult(): MongoMirrorCheckResult | null {
  return latestResult;
}
