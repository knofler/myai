import { randomUUID } from 'node:crypto';
import { TaskModel, isConnected } from '../shared/db.js';
import type { ITask, TaskPriority, TaskSource, TaskStatus } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOne, scopedFindOneAndUpdate, scopedAggregate, tenantScope } from '../shared/scoped-query.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { notifyLifecycleMilestone } from '../notifications/lifecycle-emails.js';
import type { NotificationLevel } from '../notifications/notifier.js';
import { recordUsage, usageEventId } from '../shared/usage-store.js';
import { preemptForUrgentTask, resumeTasksPreemptedBy } from './preemption.js';
import { recordSpan } from '../tracing/tracer.js';
import { isFleetPaused } from './fleet-maintenance-store.js';

const log = createChildLogger({ module: 'task-store' });

// Priority ordering: P0 = urgent, P3 = low.
const PRIORITY_ORDER: Record<TaskPriority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Map a task status to a notification level (blocked/paused/dead_letter = warning, else info). */
function statusLevel(status: TaskStatus): NotificationLevel {
  return status === 'blocked' || status === 'paused' || status === 'dead_letter' ? 'warning' : 'info';
}

// ── Bounded retry-with-backoff / dead-letter (runner failure path) ──────
// Mirrors the WebhookDelivery retry convention (webhooks/outbound-events.ts
// backoffMs/nextFailureState): deterministic exponential backoff, no jitter,
// so the schedule is exactly assertable in tests.
export const DEFAULT_MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 5 * 60_000;     // first retry ~5m after the initial failure
const MAX_RETRY_DELAY_MS = 6 * 3_600_000;   // cap backoff at 6h

/**
 * Exponential backoff for the delay before retry attempt N (1-indexed: the
 * delay *after* the Nth failure, before the task is claimable again):
 * 5m, 10m, 20m, 40m, … capped at 6h.
 */
export function retryBackoffMs(retryCount: number): number {
  const exp = BASE_RETRY_DELAY_MS * 2 ** Math.max(0, retryCount - 1);
  return Math.min(MAX_RETRY_DELAY_MS, exp);
}

/**
 * Given the retry count just recorded and the task's max, decide the next
 * state after a FAILED run: 'dead_letter' once retries are exhausted,
 * otherwise 'pending' with the computed next-claimable-at delay.
 */
export function nextFailureState(
  retryCountAfter: number,
  maxRetries: number,
): { status: 'dead_letter' } | { status: 'pending'; delayMs: number } {
  if (retryCountAfter >= maxRetries) return { status: 'dead_letter' };
  return { status: 'pending', delayMs: retryBackoffMs(retryCountAfter) };
}

export interface CreateTaskInput {
  repo: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignedAgent?: string;
  recommendedModel?: string;
  source?: TaskSource;
  sourceId?: string;
  notes?: string;
}

export interface UpdateTaskInput {
  taskId: string;
  /** Re-point a misfiled task to a different repo (e.g. old-name → new-name).
   *  Empty/whitespace is ignored so a blank value can never wipe the field. */
  repo?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedAgent?: string;
  recommendedModel?: string;
  prUrl?: string;
  notes?: string;
  telegramMessageId?: number;
}

export interface ListTasksFilter {
  repo?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  assignedAgent?: string;
  limit?: number;
}

export interface ClaimTaskInput {
  /** Identifies the runner/slot claiming the task, e.g. "runner-host/slot-0". */
  claimedBy: string;
  /** Claim a specific task by ID (used by --task-id runs). */
  taskId?: string;
  /** Restrict the claim to one repo (used by --repo runs). */
  repo?: string;
  /** Repos the runner refuses to work (no-autonomous-schedule consent list). */
  ignoreRepos?: string[];
  /** Lease TTL in seconds; a working task past leaseUntil is reclaimable. Default 3600. */
  leaseSeconds?: number;
}

export interface TaskView {
  taskId: string;
  repo: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedAgent?: string;
  recommendedModel?: string;
  source: TaskSource;
  sourceId?: string;
  prUrl?: string;
  notes?: string;
  telegramMessageId?: number;
  claimedBy?: string;
  claimedAt?: Date;
  leaseUntil?: Date;
  startedAt?: Date;
  completedAt?: Date;
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  deadLetteredAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

function toView(doc: ITask): TaskView {
  return {
    taskId: doc.taskId,
    repo: doc.repo,
    title: doc.title,
    description: doc.description,
    priority: doc.priority,
    status: doc.status,
    assignedAgent: doc.assignedAgent,
    recommendedModel: doc.recommendedModel,
    source: doc.source,
    sourceId: doc.sourceId,
    prUrl: doc.prUrl,
    notes: doc.notes,
    telegramMessageId: doc.telegramMessageId,
    claimedBy: doc.claimedBy,
    claimedAt: doc.claimedAt,
    leaseUntil: doc.leaseUntil,
    startedAt: doc.startedAt,
    completedAt: doc.completedAt,
    retryCount: doc.retryCount,
    maxRetries: doc.maxRetries,
    nextRetryAt: doc.nextRetryAt,
    deadLetteredAt: doc.deadLetteredAt,
    lastError: doc.lastError,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function requireDb(): void {
  if (!isConnected() || !TaskModel) {
    throw new Error('MongoDB not connected — task queue unavailable');
  }
}

export async function createTask(tenantId: string, input: CreateTaskInput): Promise<TaskView> {
  requireDb();
  const doc = await TaskModel.create({
    ...tenantScope(tenantId),
    taskId: `task-${randomUUID()}`,
    repo: input.repo,
    title: input.title,
    description: input.description ?? '',
    priority: input.priority ?? 'P2',
    status: 'pending',
    assignedAgent: input.assignedAgent,
    recommendedModel: input.recommendedModel,
    source: input.source ?? 'manual',
    sourceId: input.sourceId,
    notes: input.notes,
  });
  log.info({ taskId: doc.taskId, repo: doc.repo, priority: doc.priority }, 'Task created');
  emitNotifyEvent({
    type: 'task.created',
    tenantId,
    title: `New task: ${doc.title}`,
    message: `[${doc.repo}] queued at ${doc.priority}`,
    level: 'info',
    source: 'task-store',
    data: { taskId: doc.taskId, repo: doc.repo, priority: doc.priority, status: doc.status },
  });

  // Lifecycle email sequence (fire-and-forget, idempotent first-wins — see
  // notifications/lifecycle-emails.ts): the tenant's first queued task.
  void notifyLifecycleMilestone(tenantId, 'first_task', { repo: doc.repo, taskTitle: doc.title });

  // Priority preemption (ADR-011 follow-on): a freshly-arrived P0/P1 task may
  // need to bump a lower-priority in-flight task out of a busy runner-lease
  // slot. Never lets a preemption-check failure fail task creation.
  if (doc.priority === 'P0' || doc.priority === 'P1') {
    await preemptForUrgentTask(tenantId, { taskId: doc.taskId, priority: doc.priority }).catch((err) => {
      log.warn({ err, taskId: doc.taskId }, 'Preemption check failed on task creation');
    });
  }

  return toView(doc);
}

/**
 * Traced wrapper — records a `gateway.task_update` span (part of the
 * gateway→runner→agent trace chain, tracing/tracer.ts) around the real
 * implementation without touching its control flow.
 */
export async function updateTask(tenantId: string, input: UpdateTaskInput): Promise<TaskView | null> {
  const startMs = Date.now();
  try {
    const result = await updateTaskImpl(tenantId, input);
    if (result) {
      recordSpan({
        traceKey: result.taskId,
        name: 'gateway.task_update',
        service: 'gateway',
        startMs,
        endMs: Date.now(),
        status: 'ok',
        attributes: { taskId: result.taskId, repo: result.repo, status: result.status },
      });
    }
    return result;
  } catch (err) {
    recordSpan({
      traceKey: input.taskId,
      name: 'gateway.task_update',
      service: 'gateway',
      startMs,
      endMs: Date.now(),
      status: 'error',
      attributes: { taskId: input.taskId },
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function updateTaskImpl(tenantId: string, input: UpdateTaskInput): Promise<TaskView | null> {
  requireDb();
  // Scope by tenant: a leaked taskId from another tenant matches nothing
  // (cross-tenant update → "not found"), never a silent cross-tenant mutation.
  const existing = await scopedFindOne(TaskModel, tenantId, { taskId: input.taskId });
  if (!existing) return null;

  const prevStatus = existing.status;
  const prevPriority = existing.priority;
  const statusChanged = !!input.status && input.status !== existing.status;

  if (input.status && input.status !== existing.status) {
    if (input.status === 'working' && !existing.startedAt) {
      existing.startedAt = new Date();
    }
    if ((input.status === 'done' || input.status === 'blocked' || input.status === 'dead_letter') && !existing.completedAt) {
      existing.completedAt = new Date();
    }
    // Operator triage replay (mirrors WebhookDelivery.replayDelivery): manually
    // requeuing a blocked/dead-lettered task clears its retry ledger so it gets
    // a fresh attempt chain instead of dead-lettering again on the next failure.
    if (input.status === 'pending' && (existing.status === 'blocked' || existing.status === 'dead_letter')) {
      existing.retryCount = 0;
      existing.nextRetryAt = undefined;
      existing.deadLetteredAt = undefined;
    }
    existing.status = input.status;
  }
  // Re-point a misfiled task to a different repo. Guard against empty/whitespace so a
  // blank value can never blank out a required field (TaskModel.repo is required).
  if (typeof input.repo === 'string' && input.repo.trim()) existing.repo = input.repo.trim();
  if (input.priority) existing.priority = input.priority;
  if (input.assignedAgent !== undefined) existing.assignedAgent = input.assignedAgent;
  if (input.recommendedModel !== undefined) existing.recommendedModel = input.recommendedModel;
  if (input.prUrl !== undefined) existing.prUrl = input.prUrl;
  if (input.notes !== undefined) existing.notes = input.notes;
  if (input.telegramMessageId !== undefined) existing.telegramMessageId = input.telegramMessageId;

  await existing.save();
  log.info({ taskId: existing.taskId, status: existing.status }, 'Task updated');

  // Emit a real-time event only on a genuine status transition — field-only
  // edits (notes, priority, prUrl) don't warrant a notification.
  if (statusChanged) {
    emitNotifyEvent({
      type: existing.status === 'done' ? 'task.completed' : 'task.updated',
      tenantId,
      title: `Task ${existing.status}: ${existing.title}`,
      message: `[${existing.repo}] ${prevStatus} → ${existing.status}`,
      level: statusLevel(existing.status),
      source: 'task-store',
      data: {
        taskId: existing.taskId,
        repo: existing.repo,
        status: existing.status,
        prevStatus,
        prUrl: existing.prUrl,
        // Carried so the Telegram remote-approve listener (review-approval.ts)
        // can build its message without a task-store import of its own —
        // keeps that module a leaf dependency of the notify bus.
        taskTitle: existing.title,
        priority: existing.priority,
      },
    });

    // Lifecycle email sequence: the tenant's first shipped task.
    if (existing.status === 'done') {
      void notifyLifecycleMilestone(tenantId, 'first_ship', { repo: existing.repo, taskTitle: existing.title });
    }
  }

  // Product meter (ADR-014). Emit once on the transition edge OUT of `working`
  // into a terminal-ish state (review/done/blocked) — guard on the edge, not the
  // state, so a later field-only edit re-emits nothing. Deterministic eventId +
  // unique index make a double transition (retry / lease-reclaim) a no-op.
  // Fire-and-forget: recordUsage never throws.
  if (statusChanged && prevStatus === 'working'
      && (existing.status === 'review' || existing.status === 'done' || existing.status === 'blocked')) {
    const durationSec = existing.startedAt
      ? Math.max(0, Math.round((Date.now() - existing.startedAt.getTime()) / 1000))
      : undefined;
    await recordUsage(tenantId, {
      eventId: usageEventId('task.executed', existing.taskId),
      type: 'task.executed',
      source: 'gateway',
      repo: existing.repo,
      taskId: existing.taskId,
      metadata: { finalStatus: existing.status, ...(durationSec !== undefined ? { durationSec } : {}) },
    });
    // Off-hours minutes: only runner-claimed tasks consume metered wall-clock.
    if (existing.claimedAt && existing.startedAt) {
      const minutes = Math.max(1, Math.ceil((Date.now() - existing.startedAt.getTime()) / 60000));
      await recordUsage(tenantId, {
        eventId: usageEventId('offhours.minutes', existing.taskId),
        type: 'offhours.minutes',
        unit: 'minutes',
        quantity: minutes,
        source: 'runner',
        repo: existing.repo,
        taskId: existing.taskId,
      });
    }
  }

  // Priority preemption (ADR-011 follow-on): escalating a still-pending task
  // to P0/P1 is "arrival" just as much as creating a new one — re-run the
  // same check so it can bump a lower-priority in-flight task if needed.
  const priorityEscalated = !!input.priority && input.priority !== prevPriority
    && (existing.priority === 'P0' || existing.priority === 'P1');
  if (priorityEscalated && existing.status === 'pending') {
    await preemptForUrgentTask(tenantId, { taskId: existing.taskId, priority: existing.priority }).catch((err) => {
      log.warn({ err, taskId: existing.taskId }, 'Preemption check failed on priority escalation');
    });
  }

  // Resume any task paused in this one's favour once it clears — same edge
  // as the product-meter emission above (working → review/done/blocked).
  if (statusChanged && prevStatus === 'working'
      && (existing.status === 'review' || existing.status === 'done' || existing.status === 'blocked')) {
    await resumeTasksPreemptedBy(tenantId, existing.taskId).catch((err) => {
      log.warn({ err, taskId: existing.taskId }, 'Resume check failed');
    });
  }

  return toView(existing);
}

export async function listTasks(tenantId: string, filter: ListTasksFilter = {}): Promise<TaskView[]> {
  requireDb();
  const query: Record<string, unknown> = {};
  if (filter.repo) query.repo = filter.repo;
  if (filter.status) query.status = filter.status;
  if (filter.priority) query.priority = filter.priority;
  if (filter.assignedAgent) query.assignedAgent = filter.assignedAgent;

  const docs = await scopedFind(TaskModel, tenantId, query)
    .sort({ priority: 1, createdAt: 1 })
    .limit(filter.limit ?? 50)
    .exec();

  return docs.map(toView);
}

/** Single tenant-scoped lookup by taskId — null when missing or owned by another tenant. */
export async function getTask(tenantId: string, taskId: string): Promise<TaskView | null> {
  requireDb();
  const doc = await scopedFindOne(TaskModel, tenantId, { taskId }).exec();
  return doc ? toView(doc) : null;
}

export async function nextTask(tenantId: string, repo?: string): Promise<TaskView | null> {
  requireDb();
  const query: Record<string, unknown> = { status: 'pending', ...dueFilter(new Date()) };
  if (repo) query.repo = repo;

  const doc = await scopedFindOne(TaskModel, tenantId, query)
    .sort({ priority: 1, createdAt: 1 })
    .exec();

  return doc ? toView(doc) : null;
}

/** A retried task isn't claimable again until its backoff clears. */
function dueFilter(now: Date): Record<string, unknown> {
  return { $or: [{ nextRetryAt: { $exists: false } }, { nextRetryAt: { $lte: now } }] };
}

/**
 * Atomically claim the highest-priority pending task (ADR-011 slice 2).
 *
 * A single `findOneAndUpdate({status:'pending', …}, {$set:{status:'working', …}})`
 * with `{sort, new:true}` is atomic at the database, so when two runners on two
 * Macs fire concurrently against the same (Atlas) queue, exactly one wins the task
 * and the other gets the next one (or null). This REPLACES the old non-atomic
 * `tasks_list` + `tasks_update` read-then-write that could double-pick across
 * machines (the slot-offset trick only de-duped fires on a single machine).
 *
 * Sort matches `nextTask` (priority P0→P3, then oldest). Sets `claimedBy`,
 * `claimedAt`, `leaseUntil` (for stale-runner reclaim) and `startedAt`.
 */
/**
 * Traced wrapper — records a `gateway.task_claim` span (root of the
 * gateway→runner→agent trace chain, tracing/tracer.ts) around the real
 * implementation without touching its control flow. This is the exact
 * gateway↔runner boundary: the bash runner's `mcp tasks_claim` call lands here.
 */
export async function claimTask(tenantId: string, input: ClaimTaskInput): Promise<TaskView | null> {
  const startMs = Date.now();
  const result = await claimTaskImpl(tenantId, input);
  if (result) {
    recordSpan({
      traceKey: result.taskId,
      name: 'gateway.task_claim',
      service: 'gateway',
      startMs,
      endMs: Date.now(),
      status: 'ok',
      attributes: { taskId: result.taskId, repo: result.repo, claimedBy: input.claimedBy },
    });
  }
  return result;
}

async function claimTaskImpl(tenantId: string, input: ClaimTaskInput): Promise<TaskView | null> {
  requireDb();
  // Fleet-wide operator kill switch (fleet-maintenance-store.ts): while active,
  // every claim — including an explicit --task-id retry — reads as "nothing to
  // claim" so an operator can safely deploy the gateway or freeze autonomous
  // work without killing any runner process.
  if (await isFleetPaused(tenantId)) return null;
  const now = new Date();
  // A specific --task-id claim is an explicit operator/runner override — bypass
  // the backoff the same way pacing/off-hours guards are bypassed by --task-id
  // (cli_task_runner.sh), so a manual retry is never blocked by its own cooldown.
  const filter: Record<string, unknown> = input.taskId ? { status: 'pending' } : { status: 'pending', ...dueFilter(now) };
  if (input.taskId) filter.taskId = input.taskId;
  else if (input.repo) filter.repo = input.repo;
  if (input.ignoreRepos && input.ignoreRepos.length) filter.repo = { $nin: input.ignoreRepos };

  const leaseMs = (input.leaseSeconds ?? 3600) * 1000;
  const doc = await scopedFindOneAndUpdate(
    TaskModel, tenantId,
    filter,
    {
      $set: {
        status: 'working',
        claimedBy: input.claimedBy,
        claimedAt: now,
        leaseUntil: new Date(now.getTime() + leaseMs),
        startedAt: now,
      },
    },
    { sort: { priority: 1, createdAt: 1 }, new: true },
  );
  if (!doc) return null;
  const claimed = doc as ITask;
  log.info({ taskId: claimed.taskId, repo: claimed.repo, claimedBy: input.claimedBy }, 'Task claimed (atomic)');
  // Surface the pending→working transition on the dashboard, same as updateTask
  // does for a manual status flip — a claim is otherwise an invisible state change.
  emitNotifyEvent({
    type: 'task.updated',
    tenantId,
    title: `Task working: ${claimed.title}`,
    message: `[${claimed.repo}] pending → working (claimed by ${input.claimedBy})`,
    level: 'info',
    source: 'task-store',
    data: { taskId: claimed.taskId, repo: claimed.repo, status: claimed.status, prevStatus: 'pending', claimedBy: input.claimedBy },
  });
  return toView(claimed);
}

export interface FailTaskInput {
  taskId: string;
  /** Failure detail — stored as lastError and appended to notes. */
  error: string;
}

/**
 * Record a genuine runner failure (ADR: dead-letter queue + bounded retry).
 * Bumps `retryCount`; while under `maxRetries` releases the task back to
 * `pending` with `nextRetryAt` pushed out by exponential backoff (clearing the
 * stale claim so it reads as a fresh pickup, not a still-working task).
 * Once retries are exhausted, dead-letters it (`status: 'dead_letter'`,
 * `deadLetteredAt` stamped) instead of leaving it to loop or vanish — surfaced
 * on the dashboard's Dead Letter tab for operator triage.
 *
 * Call this from the runner's genuine-failure branch INSTEAD OF a direct
 * `tasks_update {status:'blocked'}` — it is the only path that advances the
 * retry ledger.
 */
/**
 * Traced wrapper — records a `gateway.task_fail` span (part of the
 * gateway→runner→agent trace chain, tracing/tracer.ts) around the real
 * implementation without touching its control flow.
 */
export async function failTask(tenantId: string, input: FailTaskInput, now: Date = new Date()): Promise<TaskView | null> {
  const startMs = Date.now();
  const result = await failTaskImpl(tenantId, input, now);
  if (result) {
    recordSpan({
      traceKey: result.taskId,
      name: 'gateway.task_fail',
      service: 'gateway',
      startMs,
      endMs: Date.now(),
      status: 'error',
      attributes: { taskId: result.taskId, repo: result.repo, status: result.status },
      error: input.error,
    });
  }
  return result;
}

async function failTaskImpl(tenantId: string, input: FailTaskInput, now: Date = new Date()): Promise<TaskView | null> {
  requireDb();
  const existing = await scopedFindOne(TaskModel, tenantId, { taskId: input.taskId });
  if (!existing) return null;

  const retryCountAfter = existing.retryCount + 1;
  const next = nextFailureState(retryCountAfter, existing.maxRetries);
  const errorNote = input.error.slice(0, 1800);

  existing.retryCount = retryCountAfter;
  existing.lastError = errorNote;
  existing.notes = errorNote;

  if (next.status === 'dead_letter') {
    existing.status = 'dead_letter';
    existing.deadLetteredAt = now;
    existing.nextRetryAt = undefined;
    if (!existing.completedAt) existing.completedAt = now;
  } else {
    // Release the claim — a retried task is a fresh pickup, not still working.
    existing.status = 'pending';
    existing.nextRetryAt = new Date(now.getTime() + next.delayMs);
    existing.claimedBy = undefined;
    existing.claimedAt = undefined;
    existing.leaseUntil = undefined;
  }

  await existing.save();
  log.info(
    { taskId: existing.taskId, retryCount: existing.retryCount, maxRetries: existing.maxRetries, status: existing.status },
    'Task failure recorded',
  );

  emitNotifyEvent({
    type: next.status === 'dead_letter' ? 'task.dead_letter' : 'task.updated',
    tenantId,
    title: next.status === 'dead_letter'
      ? `Task dead-lettered: ${existing.title}`
      : `Task retry ${retryCountAfter}/${existing.maxRetries} scheduled: ${existing.title}`,
    message: next.status === 'dead_letter'
      ? `[${existing.repo}] exhausted ${existing.maxRetries} retries — needs operator triage. ${errorNote}`
      : `[${existing.repo}] failed (attempt ${retryCountAfter}/${existing.maxRetries}) — retrying at ${existing.nextRetryAt?.toISOString()}`,
    level: 'warning',
    source: 'task-store',
    data: { taskId: existing.taskId, repo: existing.repo, status: existing.status, prevStatus: 'working', retryCount: retryCountAfter, maxRetries: existing.maxRetries },
  });

  return toView(existing);
}

export async function countTasks(tenantId: string, filter: ListTasksFilter = {}): Promise<Record<TaskStatus, number>> {
  requireDb();
  const match: Record<string, unknown> = {};
  if (filter.repo) match.repo = filter.repo;

  // scopedAggregate prepends a tenant-pinned $match; fold the repo filter into
  // that same leading match so the whole pipeline is tenant-scoped from stage 1.
  const agg = await scopedAggregate(TaskModel, tenantId, [
    ...(filter.repo ? [{ $match: { repo: filter.repo } }] : []),
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]) as Array<{ _id: TaskStatus; count: number }>;

  const result: Record<TaskStatus, number> = {
    pending: 0, working: 0, review: 0, done: 0, blocked: 0, paused: 0, dead_letter: 0,
  };
  for (const row of agg) result[row._id] = row.count;
  return result;
}

export { PRIORITY_ORDER };
