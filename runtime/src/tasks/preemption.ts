/**
 * Priority preemption within the task queue (ADR-011 follow-on).
 *
 * Distinct from fair-share scheduling (which prevents starvation ACROSS
 * tenants sharing the fleet's runner-lease slots): this operates WITHIN one
 * tenant's queue. When a P0/P1 task arrives (created, or escalated via a
 * priority update) and every runner-lease slot is already busy on P2/P3
 * work, the lowest-priority eligible in-flight task is paused so a runner
 * picks up the urgent one next fire, then resumed once the urgent task
 * clears (review/done/blocked).
 *
 * Thrash guard: a `working` task is only preemptible after running for at
 * least `minRunTimeMs` — otherwise a burst of urgent tasks could bounce the
 * same low-priority task in and out of `working` indefinitely, making no
 * forward progress on anything.
 *
 * This module only decides + records the pause/resume in the task queue.
 * Actually interrupting the runner process holding the paused task's lease
 * is a separate, not-yet-built piece (the runner would need to notice its
 * claimed task went `paused` and release its lease early) — see ADR-011.
 */
import { TaskModel, isConnected } from '../shared/db.js';
import type { ITask, TaskPriority } from '../shared/db.js';
import { scopedFind, scopedFindOneAndUpdate } from '../shared/scoped-query.js';
import { listLeases, DEFAULT_LEASE_SLOTS } from './runner-lease-store.js';
import { createChildLogger } from '../shared/logger.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';

const log = createChildLogger({ module: 'preemption' });

const PRIORITY_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };
const URGENT_PRIORITIES: readonly TaskPriority[] = ['P0', 'P1'];

/** Thrash guard: a working task must have run this long before it's preemptible. */
export const MIN_RUN_TIME_MS = 5 * 60 * 1000; // 5 minutes

export interface PreemptOptions {
  /** Fleet-wide lease slot count; defaults to the runner-lease default. */
  slots?: number;
  /** Override the thrash-guard window (tests only; default MIN_RUN_TIME_MS). */
  minRunTimeMs?: number;
}

export interface PreemptResult {
  preempted: boolean;
  reason: string;
  candidate?: { taskId: string; repo: string; priority: TaskPriority };
}

export interface ResumedTask {
  taskId: string;
  repo: string;
}

type CandidateTask = Pick<ITask, 'taskId' | 'repo' | 'priority' | 'startedAt'>;

function requireDb(): void {
  if (!isConnected() || !TaskModel) {
    throw new Error('MongoDB not connected — task queue unavailable');
  }
}

/**
 * Pick the best in-flight task to preempt out of `workingTasks`: strictly
 * lower priority than the urgent task, running at least `minRunTimeMs`.
 * Among eligible candidates, prefer the lowest priority (P3 before P2), then
 * the most-recently-started — preempting the newest run sacrifices the
 * least sunk work. Pure function — no I/O — so the decision is unit-testable
 * without a database.
 */
export function pickPreemptionCandidate(
  workingTasks: CandidateTask[],
  urgentPriority: TaskPriority,
  now: Date,
  minRunTimeMs: number = MIN_RUN_TIME_MS,
): CandidateTask | null {
  const urgentRank = PRIORITY_ORDER[urgentPriority];
  const eligible = workingTasks.filter((t) => {
    if (PRIORITY_ORDER[t.priority] <= urgentRank) return false; // not strictly lower priority
    if (!t.startedAt) return false; // no start timestamp — treat as not-yet-preemptible
    return now.getTime() - t.startedAt.getTime() >= minRunTimeMs;
  });
  if (eligible.length === 0) return null;

  eligible.sort((a, b) => {
    const byPriority = PRIORITY_ORDER[b.priority] - PRIORITY_ORDER[a.priority]; // higher rank number (lower priority) first
    if (byPriority !== 0) return byPriority;
    return b.startedAt!.getTime() - a.startedAt!.getTime(); // most-recently-started first
  });
  return eligible[0];
}

/**
 * Called when a P0/P1 task arrives (new creation, or a pending task escalated
 * to P0/P1). If a runner-lease slot is already free, no preemption is needed
 * — the next fire simply claims the urgent task. Otherwise, pauses the best
 * eligible in-flight task so a slot frees up in its favour.
 *
 * Never throws — callers (task creation/update) must not fail because a
 * preemption check failed; the urgent task still gets queued at its priority
 * and picked up as soon as any slot frees naturally.
 */
export async function preemptForUrgentTask(
  tenantId: string,
  urgentTask: { taskId: string; priority: TaskPriority },
  opts: PreemptOptions = {},
): Promise<PreemptResult> {
  if (!URGENT_PRIORITIES.includes(urgentTask.priority)) {
    return { preempted: false, reason: 'task is not P0/P1' };
  }

  try {
    requireDb();
  } catch (err) {
    log.warn({ err, taskId: urgentTask.taskId }, 'Preemption check skipped — DB unavailable');
    return { preempted: false, reason: 'db unavailable' };
  }

  const minRunTimeMs = opts.minRunTimeMs ?? MIN_RUN_TIME_MS;
  const slots = opts.slots ?? DEFAULT_LEASE_SLOTS;

  try {
    const { maxSlots, activeSlots } = await listLeases(tenantId, slots);
    if (activeSlots < maxSlots) {
      return { preempted: false, reason: 'a runner-lease slot is free — no preemption needed' };
    }

    const working = (await scopedFind(TaskModel, tenantId, {
      status: 'working',
      taskId: { $ne: urgentTask.taskId },
    }).exec()) as ITask[];

    const now = new Date();
    const candidate = pickPreemptionCandidate(working, urgentTask.priority, now, minRunTimeMs);
    if (!candidate) {
      return { preempted: false, reason: 'no preemptible lower-priority task (thrash guard, or none in flight)' };
    }

    const checkpointNote = `Paused ${now.toISOString()} — preempted by urgent task ${urgentTask.taskId} (${urgentTask.priority}). Resumes once it clears.`;
    const doc = (await scopedFindOneAndUpdate(
      TaskModel, tenantId,
      { taskId: candidate.taskId, status: 'working' },
      {
        $set: {
          status: 'paused',
          preemptedBy: urgentTask.taskId,
          preemptedAt: now,
          notes: checkpointNote,
        },
      },
      { new: true },
    )) as ITask | null;

    if (!doc) {
      return { preempted: false, reason: 'candidate changed status before preemption could apply' };
    }

    log.info({ taskId: doc.taskId, urgentTaskId: urgentTask.taskId }, 'Task preempted for urgent work');
    emitNotifyEvent({
      type: 'task.updated',
      tenantId,
      title: `Task paused: ${doc.title}`,
      message: `[${doc.repo}] working → paused (preempted by ${urgentTask.taskId})`,
      level: 'warning',
      source: 'preemption',
      data: {
        taskId: doc.taskId,
        repo: doc.repo,
        status: 'paused',
        prevStatus: 'working',
        preemptedBy: urgentTask.taskId,
      },
    });

    return {
      preempted: true,
      reason: 'preempted lowest-priority eligible in-flight task',
      candidate: { taskId: doc.taskId, repo: doc.repo, priority: doc.priority },
    };
  } catch (err) {
    log.warn({ err, taskId: urgentTask.taskId }, 'Preemption check failed');
    return { preempted: false, reason: 'preemption check errored' };
  }
}

/**
 * Resume every task paused in favour of `urgentTaskId`. Requeues
 * paused→pending so the normal claimTask priority/createdAt ordering picks
 * it back up — the task's original createdAt keeps it ahead of same-priority
 * tasks queued after it, no priority boost needed.
 *
 * Never throws — callers (task completion) must not fail because a resume
 * check failed; a paused task left behind is still visible in the queue and
 * can be manually requeued.
 */
export async function resumeTasksPreemptedBy(
  tenantId: string,
  urgentTaskId: string,
): Promise<ResumedTask[]> {
  try {
    requireDb();
  } catch (err) {
    log.warn({ err, urgentTaskId }, 'Resume check skipped — DB unavailable');
    return [];
  }

  try {
    const paused = (await scopedFind(TaskModel, tenantId, {
      status: 'paused',
      preemptedBy: urgentTaskId,
    }).exec()) as ITask[];

    const resumed: ResumedTask[] = [];
    for (const task of paused) {
      const doc = (await scopedFindOneAndUpdate(
        TaskModel, tenantId,
        { taskId: task.taskId, status: 'paused' },
        { $set: { status: 'pending' }, $unset: { preemptedBy: '', preemptedAt: '' } },
        { new: true },
      )) as ITask | null;
      if (!doc) continue;

      resumed.push({ taskId: doc.taskId, repo: doc.repo });
      log.info({ taskId: doc.taskId, urgentTaskId }, 'Preempted task resumed');
      emitNotifyEvent({
        type: 'task.updated',
        tenantId,
        title: `Task resumed: ${doc.title}`,
        message: `[${doc.repo}] paused → pending (urgent task ${urgentTaskId} cleared)`,
        level: 'info',
        source: 'preemption',
        data: { taskId: doc.taskId, repo: doc.repo, status: 'pending', prevStatus: 'paused' },
      });
    }
    return resumed;
  } catch (err) {
    log.warn({ err, urgentTaskId }, 'Resume check failed');
    return [];
  }
}
