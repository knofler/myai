/**
 * task-defer-alerter — per-task consecutive router-exhaustion-defer alert.
 *
 * Commit e161ff6 fixed route_task_model's hard exhaustion case (every pool —
 * tech and Fable — out of headroom for an already-claimed task) to DEFER the
 * task back to `pending` instead of stalling it working forever or misrouting
 * it onto an exhausted pool. That fix raises `route_exhaustion_alert` (Telegram
 * + notifications_send) on every single occurrence — a fleet-wide "a pool went
 * dark" signal.
 *
 * What that alert does NOT surface: the SAME task deferred over and over,
 * never making it past routing into a real run. A tenant whose task keeps
 * getting claimed and immediately deferred is exactly the starvation the
 * e161ff6 fix was meant to prevent — just invisible instead of loud, because
 * each individual defer looks like routine pacing noise rather than a stuck
 * task. This module closes that gap: it counts CONSECUTIVE defers for the
 * same task and fires a distinct starvation alert once the count crosses a
 * threshold, escalating again every `repeatEvery` defers past that so a task
 * stuck for hours doesn't alert once and go quiet.
 *
 * Reuses monitoring/pool-capacity-alerter.ts's shape: env-configurable
 * thresholds, a pure evaluate function for unit-testing without I/O, in-process
 * counter state (same as that file's dedup watermark — a live operational
 * alerter, not a store), and the same Telegram + emitNotifyEvent dual dispatch
 * so the bell always lands even when Telegram is unconfigured.
 *
 * Caller: task-store.ts's updateTaskImpl calls recordTaskDefer() when a
 * `pending` update carries `routeExhausted: true` (the runner's defer branch,
 * scripts/cli_task_runner.sh), and clearTaskDeferCount() when the task is
 * re-stamped `working` with a real routed model — a successful routing
 * attempt breaks the consecutive-defer streak.
 */
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'task-defer-alerter' });

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface TaskDeferAlertConfig {
  /** Consecutive defers before the first alert fires (default 3). */
  threshold: number;
  /** Fire again every this many additional consecutive defers past threshold (default 3; 0 disables re-alerting). */
  repeatEvery: number;
}

/** Read thresholds from env at call time so tests (and a gateway restart) pick up changes. */
export function taskDeferAlertConfig(): TaskDeferAlertConfig {
  return {
    threshold: envNum('TASK_DEFER_ALERT_THRESHOLD', 3),
    repeatEvery: envNum('TASK_DEFER_ALERT_REPEAT_EVERY', 3),
  };
}

// ── Breach evaluation (pure) ──────────────────────────────────

/**
 * Decide whether THIS crossing (the count just recorded) warrants firing,
 * given the count at which the last alert fired (0 = never alerted yet).
 * Pure — unit-testable without touching the in-process counter map.
 */
export function evaluateTaskDeferBreach(
  count: number,
  lastAlertedAtCount: number,
  cfg: TaskDeferAlertConfig,
): boolean {
  if (count < cfg.threshold) return false;
  if (lastAlertedAtCount === 0) return true; // first crossing of the threshold
  if (cfg.repeatEvery <= 0) return false; // re-alerting disabled — one-shot
  return count - lastAlertedAtCount >= cfg.repeatEvery;
}

// ── In-process consecutive-defer counters ─────────────────────

interface DeferState {
  count: number;
  firstAt: number;
  lastAt: number;
  /** Count at which the alert last fired for this key; 0 = never. */
  lastAlertedAtCount: number;
}

/** key: `${tenantId}|${taskId}` → consecutive-defer state. */
const deferCounts = new Map<string, DeferState>();

function keyFor(tenantId: string, taskId: string): string {
  return `${tenantId}|${taskId}`;
}

/** Reset a task's consecutive-defer streak — call when it routes successfully. */
export function clearTaskDeferCount(input: { taskId: string; tenantId: string }): void {
  deferCounts.delete(keyFor(input.tenantId, input.taskId));
}

/** Clear all tracked counters (test helper / manual reset). */
export function clearAllTaskDeferCounts(): void {
  deferCounts.clear();
}

/** Current consecutive-defer count for a task (0 if untracked). */
export function getTaskDeferCount(input: { taskId: string; tenantId: string }): number {
  return deferCounts.get(keyFor(input.tenantId, input.taskId))?.count ?? 0;
}

// ── Alert dispatch ─────────────────────────────────────────────

export interface TaskDeferBreach {
  taskId: string;
  tenantId: string;
  repo: string;
  count: number;
  reason: string;
}

function formatMessage(b: TaskDeferBreach, now: number): string {
  const timestamp = new Date(now).toISOString().replace('T', ' ').slice(0, 19);
  return [
    `\u{1F6A8} Task Starvation — [${b.repo}] ${b.taskId} deferred ${b.count}× in a row`,
    `Reason: ${b.reason}`,
    '',
    'The router has been unable to route this task to any pool for multiple consecutive attempts — ' +
      'it is stuck, not just caught in a single pool blip. Investigate pool capacity or the task itself.',
    `Detected at ${timestamp} UTC`,
  ].join('\n');
}

async function sendTelegram(b: TaskDeferBreach, now: number): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ taskId: b.taskId }, 'No enabled Telegram adapter — task-defer alert not sent to Telegram');
    return false;
  }
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ taskId: b.taskId }, 'TELEGRAM_DEFAULT_CHAT not set — task-defer alert not sent to Telegram');
    return false;
  }
  try {
    await telegram.send(chatId, formatMessage(b, now));
    return true;
  } catch (err) {
    log.error({ taskId: b.taskId, err }, 'Failed to send task-defer Telegram alert');
    return false;
  }
}

export interface RecordTaskDeferResult {
  count: number;
  alerted: boolean;
}

export interface TaskDeferInput {
  taskId: string;
  tenantId: string;
  repo: string;
  /** route_task_model's ROUTE_REASON / the runner's defer note — carried into the alert message. */
  reason: string;
}

/**
 * Record one exhaustion-defer for a task and fire a starvation alert once the
 * consecutive count crosses the threshold — and again every `repeatEvery`
 * defers past that, an escalating reminder for a task still stuck.
 *
 * Never throws — a missed alert must not affect the caller's revert-to-pending
 * (same "best-effort" stance as route_exhaustion_alert in cli_task_runner.sh).
 *
 * @param now injectable clock (epoch ms) for deterministic tests.
 */
export async function recordTaskDefer(input: TaskDeferInput, now: number = Date.now()): Promise<RecordTaskDeferResult> {
  try {
    const key = keyFor(input.tenantId, input.taskId);
    const cfg = taskDeferAlertConfig();
    const prev = deferCounts.get(key);
    const count = (prev?.count ?? 0) + 1;
    const state: DeferState = {
      count,
      firstAt: prev?.firstAt ?? now,
      lastAt: now,
      lastAlertedAtCount: prev?.lastAlertedAtCount ?? 0,
    };
    deferCounts.set(key, state);

    if (!evaluateTaskDeferBreach(count, state.lastAlertedAtCount, cfg)) {
      return { count, alerted: false };
    }
    state.lastAlertedAtCount = count;

    const breach: TaskDeferBreach = { taskId: input.taskId, tenantId: input.tenantId, repo: input.repo, count, reason: input.reason };

    // Dashboard bell/toast + durable history — in-process, always lands.
    emitNotifyEvent({
      type: 'runner.task_defer_starvation',
      tenantId: input.tenantId,
      title: `Task ${input.taskId} deferred ${count}× in a row`,
      message: formatMessage(breach, now),
      level: 'critical',
      source: 'task-defer-alerter',
      data: { taskId: input.taskId, repo: input.repo, count, reason: input.reason },
    });

    const telegramSent = await sendTelegram(breach, now);
    log.info({ taskId: input.taskId, repo: input.repo, count, telegramSent }, 'Task-defer starvation alert fired');
    return { count, alerted: true };
  } catch (err) {
    log.warn({ err, taskId: input.taskId }, 'recordTaskDefer failed (suppressed)');
    return { count: getTaskDeferCount({ taskId: input.taskId, tenantId: input.tenantId }), alerted: false };
  }
}
