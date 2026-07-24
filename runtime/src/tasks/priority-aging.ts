/**
 * Age-based priority auto-escalation (GATEWAY task) — bumps a task's priority
 * the longer it sits `pending`, so a low-priority task never starves
 * indefinitely at the bottom of the queue behind a steady stream of
 * same-or-higher-priority arrivals.
 *
 * Distinct from two other queue-fairness mechanisms:
 *  - fair-share scheduling (preemption.ts header) — prevents starvation
 *    ACROSS tenants sharing the fleet's runner-lease slots; this operates
 *    within a single tenant's own pending queue.
 *  - the stale-review reminder — a post-run nag for tasks stuck in `review`
 *    after a runner already finished them; this only ever looks at `pending`
 *    tasks that haven't been claimed yet.
 *
 * Config-driven aging curve: cumulative hours-since-created thresholds, each
 * mapped to the priority a task should be AT by that age. A task is only ever
 * escalated UP (P3→P2→P1→P0) — a task created directly at P0/P1, or one
 * already at/above the priority its age has earned, is left untouched. Like
 * queue-wait-alerter.ts, age is measured from `createdAt` (not a separate
 * "time spent pending" clock) — the same simplification that module already
 * makes, so a task that cycles pending→working→failed→pending ages on its
 * total lifetime, not just its queued time. Escalating a task into P0/P1
 * territory is "arrival" just like a fresh urgent create or a manual
 * escalation (task-store.ts) — it re-runs the same preemption check so a busy
 * runner-lease slot can be freed for it.
 */
import { TaskModel, isConnected, DEFAULT_TENANT_ID } from '../shared/db.js';
import type { ITask, TaskPriority } from '../shared/db.js';
import { scopedFind, scopedFindOneAndUpdate } from '../shared/scoped-query.js';
import { preemptForUrgentTask } from './preemption.js';
import { createChildLogger } from '../shared/logger.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';

const log = createChildLogger({ module: 'priority-aging' });

const PRIORITY_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const PRIORITY_RANK: readonly TaskPriority[] = ['P0', 'P1', 'P2', 'P3'];

function envHours(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Aging curve: hours-pending thresholds mapped to the priority a task should
 * be at by that age. Order doesn't matter for the escalation decision (see
 * computeEscalatedPriority) but is written ascending for readability.
 */
export const AGING_CURVE: ReadonlyArray<{ hours: number; priority: TaskPriority }> = [
  { hours: envHours('MYAI_AGING_TO_P2_HOURS', 4), priority: 'P2' },
  { hours: envHours('MYAI_AGING_TO_P1_HOURS', 12), priority: 'P1' },
  { hours: envHours('MYAI_AGING_TO_P0_HOURS', 24), priority: 'P0' },
];

export type AgingCandidate = Pick<ITask, 'taskId' | 'repo' | 'priority' | 'createdAt'>;

export interface AgingEscalation {
  taskId: string;
  repo: string;
  fromPriority: TaskPriority;
  toPriority: TaskPriority;
  ageHours: number;
}

/**
 * Pure decision: given a task's current priority and age, what should its
 * priority become (or undefined if no escalation is due)? Walks every rung
 * the task's age has crossed and picks the highest priority (lowest rank)
 * among them, so a task aged past several rungs at once (e.g. the sweep was
 * paused, or the curve was tightened) jumps straight to the highest one
 * earned rather than climbing one rung per sweep. Never returns a priority
 * lower (worse) than the current one.
 */
export function computeEscalatedPriority(
  currentPriority: TaskPriority,
  ageHours: number,
  curve: ReadonlyArray<{ hours: number; priority: TaskPriority }> = AGING_CURVE,
): TaskPriority | undefined {
  const currentRank = PRIORITY_ORDER[currentPriority];
  let bestRank = currentRank;
  for (const rung of curve) {
    if (ageHours < rung.hours) continue;
    const rungRank = PRIORITY_ORDER[rung.priority];
    if (rungRank < bestRank) bestRank = rungRank;
  }
  return bestRank < currentRank ? PRIORITY_RANK[bestRank] : undefined;
}

function requireDb(): void {
  if (!isConnected() || !TaskModel) {
    throw new Error('MongoDB not connected — task queue unavailable');
  }
}

export interface PriorityAgingResult {
  ranAt: Date;
  escalations: AgingEscalation[];
}

let latestResult: PriorityAgingResult | null = null;

/**
 * Snapshot pending, non-P0 tasks, evaluate each against the aging curve, and
 * apply any escalations due. Never throws — this runs on an unattended
 * interval, same contract as queue-wait-alerter's runQueueWaitCheck.
 *
 * @param now injectable clock (epoch ms) for deterministic tests.
 */
export async function runPriorityAgingSweep(now: number = Date.now()): Promise<PriorityAgingResult> {
  const ranAt = new Date(now);
  const result: PriorityAgingResult = { ranAt, escalations: [] };

  let candidates: AgingCandidate[];
  try {
    requireDb();
    // P0 is already the ceiling — excluding it up front keeps the sweep from
    // scanning tasks it could never escalate.
    const docs = (await scopedFind(TaskModel, DEFAULT_TENANT_ID, {
      status: 'pending',
      priority: { $ne: 'P0' },
    }).exec()) as ITask[];
    candidates = docs.map(d => ({ taskId: d.taskId, repo: d.repo, priority: d.priority, createdAt: d.createdAt }));
  } catch (err) {
    log.warn({ err }, 'Priority aging sweep skipped — DB unavailable');
    latestResult = result;
    return result;
  }

  for (const candidate of candidates) {
    const ageHours = (now - candidate.createdAt.getTime()) / 3_600_000;
    const target = computeEscalatedPriority(candidate.priority, ageHours);
    if (!target) continue;

    try {
      // Guard the update on the priority we snapshotted: if it changed since
      // (manual edit, or another sweep tick) this update simply misses the
      // task instead of clobbering a concurrent change — it's picked up fresh
      // (or found already-escalated) on the next tick.
      const doc = (await scopedFindOneAndUpdate(
        TaskModel, DEFAULT_TENANT_ID,
        { taskId: candidate.taskId, status: 'pending', priority: candidate.priority },
        { $set: { priority: target } },
        { new: true },
      )) as ITask | null;
      if (!doc) continue;

      const escalation: AgingEscalation = {
        taskId: candidate.taskId,
        repo: candidate.repo,
        fromPriority: candidate.priority,
        toPriority: target,
        ageHours: Math.round(ageHours),
      };
      result.escalations.push(escalation);
      log.info(escalation, 'Task priority auto-escalated by age');
      emitNotifyEvent({
        type: 'task.updated',
        tenantId: DEFAULT_TENANT_ID,
        title: `Task priority escalated: ${doc.title}`,
        message: `[${doc.repo}] ${escalation.fromPriority} → ${escalation.toPriority} — pending ${escalation.ageHours}h`,
        level: 'info',
        source: 'priority-aging',
        data: { taskId: doc.taskId, repo: doc.repo, priority: escalation.toPriority, prevPriority: escalation.fromPriority },
      });

      // Escalating into urgent territory is "arrival" just like a fresh
      // P0/P1 create or a manual escalation (task-store.ts) — may need to
      // preempt a busy runner-lease slot held by lower-priority in-flight
      // work. Never lets a preemption-check failure fail the sweep.
      if (target === 'P0' || target === 'P1') {
        await preemptForUrgentTask(DEFAULT_TENANT_ID, { taskId: doc.taskId, priority: target }).catch((err) => {
          log.warn({ err, taskId: doc.taskId }, 'Preemption check failed on priority-aging escalation');
        });
      }
    } catch (err) {
      log.warn({ err, taskId: candidate.taskId }, 'Priority aging escalation failed for task');
    }
  }

  latestResult = result;
  if (result.escalations.length > 0) {
    log.info({ count: result.escalations.length }, 'Priority aging sweep complete — escalations applied');
  }
  return result;
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

/** Default check interval: 15 minutes — the aging budgets are hours, so this
 *  doesn't need queue-wait-alerter's tighter 2-minute cadence. */
const DEFAULT_INTERVAL_MINUTES = 15;

export function startPriorityAgingSweep(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Priority aging sweep already running');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  log.info({ intervalMinutes, curve: AGING_CURVE }, 'Starting priority aging sweep');

  intervalId = setInterval(() => {
    runPriorityAgingSweep().catch(err => log.error({ err }, 'Periodic priority aging sweep failed'));
  }, intervalMs);
}

export function stopPriorityAgingSweep(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Priority aging sweep stopped');
  }
}

export function isPriorityAgingSweepRunning(): boolean {
  return intervalId !== null;
}

export function getLatestPriorityAgingResult(): PriorityAgingResult | null {
  return latestResult;
}

/** Current aging-curve configuration + state for status queries. */
export function getPriorityAgingStatus(): {
  active: boolean;
  intervalMinutes: number;
  curve: ReadonlyArray<{ hours: number; priority: TaskPriority }>;
  lastRun: Date | null;
  lastEscalations: number;
} {
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    curve: AGING_CURVE,
    lastRun: latestResult?.ranAt ?? null,
    lastEscalations: latestResult?.escalations.length ?? 0,
  };
}
