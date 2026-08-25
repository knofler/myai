/**
 * Recurring-task sweep (task-b8ddab7d) — turns due recurring templates
 * (tasks/recurring-task-store.ts) into ordinary one-shot Task queue entries
 * (source='scheduler', sourceId=recurringId) for the launchd CLI runner.
 *
 * Runs as a seeded tool schedule (`recurring_task_sweep_5min` → target
 * recurring_tasks_sweep, seed-schedules.ts) — the same wiring every other
 * sweep uses (task_lease_reap, inline_execute) — or on demand via the
 * recurring_tasks_sweep / recurring_tasks_run_now MCP tools.
 *
 * Overlap policy 'skip' (the default): while the previously enqueued one-shot
 * is still open (any non-terminal status — pending/working/review/blocked/
 * paused), a due fire records 'skipped' and just advances nextFireAt, so a
 * slow week can never pile up five identical "nightly maintenance" tasks.
 * Only done/dead_letter release the next enqueue. 'stack' always enqueues.
 */
import {
  findDueRecurringTasks, recordFireResult,
} from '../tasks/recurring-task-store.js';
import type { RecurringTaskView } from '../tasks/recurring-task-store.js';
import { createTask, getTask } from '../tasks/task-store.js';
import { computeNextRun } from './scheduler.js';
import { createChildLogger } from '../shared/logger.js';
import type { TaskStatus } from '../shared/db.js';

const log = createChildLogger({ module: 'recurring-task-sweep' });

/** Statuses that still block a new enqueue under overlapPolicy='skip' —
 *  everything non-terminal. */
const OPEN_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'pending', 'working', 'review', 'blocked', 'paused',
]);

export interface RecurringSweepResult {
  due: number;
  enqueued: number;
  skipped: number;
  failed: number;
}

export type FireOutcome = 'enqueued' | 'skipped' | 'error';

/**
 * Fire ONE recurring template: enqueue its one-shot (or record a skip/error)
 * and persist the bookkeeping. `preserveNextFire` keeps the existing
 * nextFireAt (run-now semantics — the cron cadence is unaffected, mirroring
 * schedules_run_now); the sweep path always advances it past `now`.
 */
export async function fireRecurringTask(
  rt: RecurringTaskView,
  opts: { now?: Date; preserveNextFire?: boolean } = {},
): Promise<FireOutcome> {
  const now = opts.now ?? new Date();

  let nextFireAt: Date;
  if (opts.preserveNextFire && rt.nextFireAt) {
    nextFireAt = rt.nextFireAt;
  } else {
    try {
      nextFireAt = computeNextRun(rt.cronExpr, now);
    } catch (err) {
      // Park 1h to avoid a hot loop — same posture as scheduler.ts on invalid cron.
      log.error({ recurringId: rt.recurringId, cronExpr: rt.cronExpr, err }, 'Invalid cron — parking recurring task');
      await recordFireResult(rt.tenantId, {
        recurringId: rt.recurringId,
        status: 'error',
        error: `Invalid cron: ${(err as Error).message}`,
        nextFireAt: new Date(now.getTime() + 60 * 60 * 1000),
        firedAt: now,
      });
      return 'error';
    }
  }

  try {
    if (rt.overlapPolicy === 'skip' && rt.lastTaskId) {
      const prev = await getTask(rt.tenantId, rt.lastTaskId);
      if (prev && OPEN_TASK_STATUSES.has(prev.status)) {
        log.info(
          { recurringId: rt.recurringId, lastTaskId: rt.lastTaskId, prevStatus: prev.status },
          'Previous instance still open — skipping this fire',
        );
        await recordFireResult(rt.tenantId, {
          recurringId: rt.recurringId,
          status: 'skipped',
          nextFireAt,
          firedAt: now,
        });
        return 'skipped';
      }
    }

    const task = await createTask(rt.tenantId, {
      repo: rt.repo,
      title: rt.title,
      description: rt.description,
      priority: rt.priority,
      assignedAgent: rt.assignedAgent,
      recommendedModel: rt.recommendedModel,
      notes: rt.notes,
      source: 'scheduler',
      sourceId: rt.recurringId,
    });
    await recordFireResult(rt.tenantId, {
      recurringId: rt.recurringId,
      status: 'enqueued',
      taskId: task.taskId,
      nextFireAt,
      firedAt: now,
    });
    log.info({ recurringId: rt.recurringId, taskId: task.taskId, repo: rt.repo }, 'Recurring task enqueued');
    return 'enqueued';
  } catch (err) {
    log.error({ recurringId: rt.recurringId, err }, 'Recurring enqueue threw');
    await recordFireResult(rt.tenantId, {
      recurringId: rt.recurringId,
      status: 'error',
      error: (err as Error).message,
      nextFireAt,
      firedAt: now,
    });
    return 'error';
  }
}

/**
 * One sweep pass: find every due, enabled recurring template across all
 * tenants and fire each under ITS OWN tenant (the store views carry
 * tenantId — same cross-tenant sweep + per-tenant dispatch contract as
 * scheduler.ts). One template's failure never blocks the rest.
 */
export async function runRecurringTaskSweep(now: Date = new Date()): Promise<RecurringSweepResult> {
  const result: RecurringSweepResult = { due: 0, enqueued: 0, skipped: 0, failed: 0 };
  const due = await findDueRecurringTasks(now);
  result.due = due.length;
  if (!due.length) return result;

  log.info({ count: due.length }, 'Firing due recurring tasks');
  for (const rt of due) {
    let outcome: FireOutcome;
    try {
      outcome = await fireRecurringTask(rt, { now });
    } catch (err) {
      // fireRecurringTask records its own errors; this catches bookkeeping throws.
      log.error({ recurringId: rt.recurringId, err }, 'Recurring fire failed outside enqueue path');
      outcome = 'error';
    }
    if (outcome === 'enqueued') result.enqueued++;
    else if (outcome === 'skipped') result.skipped++;
    else result.failed++;
  }

  log.info(result, 'Recurring-task sweep complete');
  return result;
}
