/**
 * Daily usage-metering reconcile sweep (ADR-014 risk-table follow-up).
 *
 * ADR-014's risk table flagged this explicitly: `recordUsage` (shared/usage-
 * store.ts) is fire-and-forget — a write failure (Mongo blip, thrown error)
 * silently drops a billable unit with nothing but a `log.warn`. That was
 * accepted "pre-invoicing", with a note to "add a daily reconcile job (tasks
 * `done` without a matching event) when invoicing lands". Invoicing landed
 * (Stripe overage sweep, commit 24a756a, 2026-07-25) but the reconcile job
 * itself was never built — this is that job.
 *
 * Cross-checks every task that reached `done` inside the reconcile window
 * against the `task.executed` (every done task) / `offhours.minutes`
 * (runner-claimed tasks only) events it should have produced, using the same
 * deterministic `usageEventId()` the emission path in task-store.ts computes
 * — so the expected-ID logic can never drift from what actually gets
 * written. Surfaces a count + a bounded sample of task IDs so a silent
 * meter-write drop becomes visible before it under-bills a tenant.
 *
 * Detection only: this NEVER re-emits a missing event (a stale read here —
 * e.g. replica lag — re-emitting could double-count units that actually did
 * land) and never blocks or reverses a task's status. An operator/cron
 * invokes this on a daily cadence; same posture as quota-reset-sweep.ts and
 * account-erasure.ts's runErasureSweep — not wired to an in-process cron.
 */
import { TaskModel, UsageEventModel, isConnected } from '../shared/db.js';
import type { ITask } from '../shared/db.js';
import { usageEventId } from '../shared/usage-store.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'usage-reconcile-sweep' });

const DEFAULT_WINDOW_HOURS = 24;
// Tasks that completed inside this trailing grace window are excluded from
// the check. `recordUsage` is awaited synchronously within the same
// `updateTask` call that stamps `completedAt` (task-store.ts), so a genuine
// drop is visible almost immediately — this grace period only guards against
// flagging a task whose sweep read raced a write that is still landing
// (e.g. replication lag on a just-completed task).
const DEFAULT_GRACE_MINUTES = 5;
// Cap how many task IDs land in the result/log line — this is an alerting
// surface, not a full export; an operator who needs the full list re-queries.
const SAMPLE_LIMIT = 20;

type SweepTask = Pick<ITask, 'tenantId' | 'taskId' | 'repo' | 'completedAt' | 'claimedAt'>;

export type MissingUsageEventType = 'task.executed' | 'offhours.minutes';

export interface MissingUsageEvent {
  taskId: string;
  tenantId: string;
  repo: string;
  type: MissingUsageEventType;
}

export interface UsageReconcileSweepResult {
  ranAt: Date;
  windowStart: Date;
  windowEnd: Date;
  tasksChecked: number;
  missing: MissingUsageEvent[];   // every gap found, across both event types
  missingCount: number;
  sampleTaskIds: string[];        // first N distinct task IDs, for alert bodies
}

export interface UsageReconcileSweepOptions {
  windowHours?: number;
  graceMinutes?: number;
}

/**
 * Operator/cron-run sweep: find every task that transitioned to `done`
 * within the reconcile window and flag any missing its `task.executed` (and,
 * for runner-claimed tasks, `offhours.minutes`) usage event.
 */
export async function runUsageReconcileSweep(
  now: Date = new Date(),
  opts: UsageReconcileSweepOptions = {},
): Promise<UsageReconcileSweepResult> {
  const windowHours = opts.windowHours ?? DEFAULT_WINDOW_HOURS;
  const graceMinutes = opts.graceMinutes ?? DEFAULT_GRACE_MINUTES;
  const windowEnd = new Date(now.getTime() - graceMinutes * 60_000);
  const windowStart = new Date(windowEnd.getTime() - windowHours * 60 * 60_000);

  const result: UsageReconcileSweepResult = {
    ranAt: now,
    windowStart,
    windowEnd,
    tasksChecked: 0,
    missing: [],
    missingCount: 0,
    sampleTaskIds: [],
  };

  if (!isConnected() || !TaskModel || !UsageEventModel) {
    log.warn('usage-reconcile-sweep: MongoDB not connected — skipping sweep');
    return result;
  }

  // tenant-ok: cross-tenant BY DESIGN — this is the operator/cron usage-metering
  // reconcile sweep (see doc comment above). It scans every tenant's done-tasks
  // in the window to detect missing billing events; per-tenant provenance is
  // preserved (tenantId is carried into every expected/missing record below).
  // Not reachable from any tenant-facing route — sole callers are the cron
  // scheduler and its unit tests.
  const tasks = await TaskModel.find({
    status: 'done',
    completedAt: { $gte: windowStart, $lt: windowEnd },
  })
    .select('tenantId taskId repo completedAt claimedAt')
    .lean<SweepTask[]>()
    .exec();

  result.tasksChecked = tasks.length;
  if (tasks.length === 0) return result;

  // Expected eventId → provenance, keyed so a duplicate expectation (can't
  // happen here — taskId is unique — but keeps the shape a Map for O(1)
  // lookup against the found-events set below.
  const expected = new Map<string, { taskId: string; tenantId: string; repo: string; type: MissingUsageEventType }>();
  for (const t of tasks) {
    expected.set(usageEventId('task.executed', t.taskId), {
      taskId: t.taskId, tenantId: t.tenantId, repo: t.repo, type: 'task.executed',
    });
    // Only runner-claimed tasks emit offhours.minutes (task-store.ts mirrors
    // this exact condition: `if (existing.claimedAt && existing.startedAt)`).
    if (t.claimedAt) {
      expected.set(usageEventId('offhours.minutes', t.taskId), {
        taskId: t.taskId, tenantId: t.tenantId, repo: t.repo, type: 'offhours.minutes',
      });
    }
  }

  const found = await UsageEventModel.find({ eventId: { $in: [...expected.keys()] } })
    .select('eventId')
    .lean<Array<{ eventId: string }>>()
    .exec();
  const foundIds = new Set(found.map(f => f.eventId));

  for (const [eventId, meta] of expected) {
    if (!foundIds.has(eventId)) result.missing.push(meta);
  }

  result.missingCount = result.missing.length;
  result.sampleTaskIds = [...new Set(result.missing.map(m => m.taskId))].slice(0, SAMPLE_LIMIT);

  if (result.missingCount > 0) {
    log.warn(
      {
        tasksChecked: result.tasksChecked,
        missingCount: result.missingCount,
        sampleTaskIds: result.sampleTaskIds,
      },
      'usage-reconcile-sweep: done tasks missing a usage event — possible silent meter-write drop',
    );
  } else {
    log.info({ tasksChecked: result.tasksChecked }, 'usage-reconcile-sweep: complete, no gaps found');
  }

  return result;
}
