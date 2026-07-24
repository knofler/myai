/**
 * queue-wait-alerter — pre-claim starvation SLO for the runner task queue.
 *
 * Distinct from age-based priority auto-escalation (tasks/priority-aging.ts —
 * which bumps a stale task's priority so it eventually outranks its
 * queue-mates) and the stale-review reminder (a post-run nag for tasks stuck
 * in `review`): this measures enqueue→claim latency on the queue itself, per
 * priority, and fires a Telegram alert when a P0/P1 task has waited beyond
 * its SLO budget without any runner claiming it. A P2/P3 task queued a long
 * time is not a starvation signal by itself — it's meant to sit behind
 * urgent work — so only P0/P1 carry an enforced budget.
 *
 * State lives in-process (cooldown map), same as slo-alerter/health-alerter —
 * this is a live operational alerter, not a persisted store.
 */
import { TaskModel, isConnected, DEFAULT_TENANT_ID } from '../shared/db.js';
import type { ITask } from '../shared/db.js';
import { scopedFind } from '../shared/scoped-query.js';
import { createChildLogger } from '../shared/logger.js';
import { getAdapter } from '../channels/registry.js';

const log = createChildLogger({ module: 'queue-wait-alerter' });

function envMinutes(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Per-priority queue-wait SLO (enqueue→claim), in minutes. Only P0/P1 are
 * enforced — a P2/P3 task queued behind urgent work is by design.
 */
export const QUEUE_SLO_MINUTES: Record<'P0' | 'P1', number> = {
  P0: envMinutes('MYAI_QUEUE_SLO_P0_MIN', 5),
  P1: envMinutes('MYAI_QUEUE_SLO_P1_MIN', 30),
};

/** Re-alert cooldown for a task still waiting past its budget (minutes). */
const COOLDOWN_MINUTES = envMinutes('MYAI_QUEUE_SLO_COOLDOWN_MIN', 30);

// ── Breach evaluation ─────────────────────────────────────────

export type QueueWaitTask = Pick<ITask, 'taskId' | 'repo' | 'title' | 'priority' | 'createdAt'>;

export interface QueueWaitBreach {
  taskId: string;
  repo: string;
  title: string;
  priority: 'P0' | 'P1';
  waitMinutes: number;
  budgetMinutes: number;
}

/**
 * Evaluate pending tasks against their priority's queue-wait SLO. Tasks below
 * P1 are ignored — no enforced budget. Pure — no I/O — so the decision is
 * unit-testable without a database.
 */
export function evaluateQueueWaitBreaches(tasks: readonly QueueWaitTask[], now: number): QueueWaitBreach[] {
  const breaches: QueueWaitBreach[] = [];
  for (const t of tasks) {
    if (t.priority !== 'P0' && t.priority !== 'P1') continue;
    const budgetMinutes = QUEUE_SLO_MINUTES[t.priority];
    const waitMinutes = (now - t.createdAt.getTime()) / 60_000;
    if (waitMinutes >= budgetMinutes) {
      breaches.push({
        taskId: t.taskId,
        repo: t.repo,
        title: t.title,
        priority: t.priority,
        waitMinutes: Math.round(waitMinutes),
        budgetMinutes,
      });
    }
  }
  return breaches;
}

// ── Cooldown / flap suppression ───────────────────────────────

const lastAlerted = new Map<string, number>(); // key: taskId → epoch ms

/** Clear cooldown state (test helper / manual reset). */
export function clearQueueWaitCooldowns(): void {
  lastAlerted.clear();
}

function cooldownMs(): number {
  return COOLDOWN_MINUTES * 60 * 1000;
}

// ── Alert dispatch ────────────────────────────────────────────

function formatBreachMessage(b: QueueWaitBreach): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return [
    `\u{1F6A8} Queue Starvation — ${b.priority} task waiting ${b.waitMinutes}m`,
    `Task: ${b.title} (${b.taskId})`,
    `Repo: ${b.repo}`,
    `Budget: ${b.budgetMinutes}m — still pending, no runner has claimed it`,
    '',
    `Detected at ${timestamp} UTC`,
  ].join('\n');
}

async function sendBreachAlert(b: QueueWaitBreach): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ taskId: b.taskId }, 'No enabled Telegram adapter — queue-wait alert not sent');
    return false;
  }

  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ taskId: b.taskId }, 'TELEGRAM_DEFAULT_CHAT not set — queue-wait alert not sent');
    return false;
  }

  try {
    await telegram.send(chatId, formatBreachMessage(b));
    log.info({ taskId: b.taskId, priority: b.priority, waitMinutes: b.waitMinutes }, 'Queue-wait SLO alert sent');
    return true;
  } catch (err) {
    log.error({ taskId: b.taskId, err }, 'Failed to send queue-wait SLO alert');
    return false;
  }
}

// ── Main check runner ─────────────────────────────────────────

export interface QueueWaitCheckResult {
  ranAt: Date;
  breaches: QueueWaitBreach[];
  alertsSent: number;
}

function requireDb(): void {
  if (!isConnected() || !TaskModel) {
    throw new Error('MongoDB not connected — task queue unavailable');
  }
}

/**
 * Snapshot pending P0/P1 tasks, evaluate the queue-wait SLO, and fire alerts
 * for newly-breaching (or cooldown-expired) tasks. A task that clears the
 * queue (claimed, or de-escalated below P1) has its cooldown reset so a
 * future breach on a reused taskId alerts immediately. Never throws.
 *
 * @param now injectable clock (epoch ms) for deterministic tests.
 */
export async function runQueueWaitCheck(now: number = Date.now()): Promise<QueueWaitCheckResult> {
  const ranAt = new Date(now);

  let tasks: QueueWaitTask[];
  try {
    requireDb();
    const docs = (await scopedFind(TaskModel, DEFAULT_TENANT_ID, {
      status: 'pending',
      priority: { $in: ['P0', 'P1'] },
    }).exec()) as ITask[];
    tasks = docs.map(d => ({ taskId: d.taskId, repo: d.repo, title: d.title, priority: d.priority, createdAt: d.createdAt }));
  } catch (err) {
    log.warn({ err }, 'Queue-wait check skipped — DB unavailable');
    const result: QueueWaitCheckResult = { ranAt, breaches: [], alertsSent: 0 };
    latestResult = result;
    return result;
  }

  const breaches = evaluateQueueWaitBreaches(tasks, now);
  const breachedIds = new Set(breaches.map(b => b.taskId));

  // Recovery: any previously-alerted task no longer breaching (claimed, or
  // fell below the P1 floor) clears its cooldown.
  for (const key of [...lastAlerted.keys()]) {
    if (!breachedIds.has(key)) lastAlerted.delete(key);
  }

  let alertsSent = 0;
  for (const b of breaches) {
    const prev = lastAlerted.get(b.taskId);
    const cooling = prev !== undefined && now - prev < cooldownMs();
    if (cooling) continue;

    const sent = await sendBreachAlert(b);
    if (sent) {
      alertsSent++;
      lastAlerted.set(b.taskId, now);
    }
  }

  const result: QueueWaitCheckResult = { ranAt, breaches, alertsSent };
  latestResult = result;
  if (breaches.length > 0) {
    log.info({ breaches: breaches.length, alertsSent }, 'Queue-wait check complete — starvation detected');
  }
  return result;
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: QueueWaitCheckResult | null = null;

/** Default check interval: 2 minutes — tighter than the perf-route SLO since a
 *  starved P0 is time-critical and the underlying budgets are minutes, not hours. */
const DEFAULT_INTERVAL_MINUTES = 2;

export function startQueueWaitAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Queue-wait alerts already running');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  log.info(
    { intervalMinutes, p0BudgetMin: QUEUE_SLO_MINUTES.P0, p1BudgetMin: QUEUE_SLO_MINUTES.P1 },
    'Starting queue-wait alerts',
  );

  intervalId = setInterval(() => {
    runQueueWaitCheck().catch(err => log.error({ err }, 'Periodic queue-wait check failed'));
  }, intervalMs);
}

export function stopQueueWaitAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Queue-wait alerts stopped');
  }
}

export function isQueueWaitAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestQueueWaitCheckResult(): QueueWaitCheckResult | null {
  return latestResult;
}

/** Current queue-wait SLO configuration + state for status queries. */
export function getQueueWaitAlertStatus(): {
  active: boolean;
  intervalMinutes: number;
  p0BudgetMinutes: number;
  p1BudgetMinutes: number;
  cooldownMinutes: number;
  lastRun: Date | null;
  lastBreaches: number;
  trackedCooldowns: number;
} {
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    p0BudgetMinutes: QUEUE_SLO_MINUTES.P0,
    p1BudgetMinutes: QUEUE_SLO_MINUTES.P1,
    cooldownMinutes: COOLDOWN_MINUTES,
    lastRun: latestResult?.ranAt ?? null,
    lastBreaches: latestResult?.breaches.length ?? 0,
    trackedCooldowns: lastAlerted.size,
  };
}
