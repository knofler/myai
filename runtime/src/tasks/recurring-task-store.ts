/**
 * Recurring runner tasks (task-b8ddab7d) — cron-cadenced task TEMPLATES the
 * recurring sweep (scheduler/recurring-task-sweep.ts) re-enqueues into the
 * Task queue as ordinary one-shot entries for the launchd CLI runner.
 *
 * Distinct from:
 *  - schedule-store.ts (ISchedule) — a Schedule dispatches an MCP
 *    tool/agent/skill IN-GATEWAY at fire time; a RecurringTask schedules
 *    WORK: it creates a queue Task (source='scheduler', sourceId=recurringId)
 *    that the runner claims and executes in a repo worktree.
 *  - the launchd runner cadence — that fires the runner process itself; this
 *    decides WHAT lands in the queue for it (nightly state rotation, weekly
 *    dep-scan) so the operator stops re-adding the same one-shots by hand.
 *
 * Store shape mirrors schedule-store.ts: tenant-scoped CRUD + a deliberately
 * cross-tenant due sweep + per-fire bookkeeping.
 */
import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import { RecurringTaskModel, isConnected } from '../shared/db.js';
import type { IRecurringTask, RecurringOverlapPolicy, RecurringFireStatus, TaskPriority } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOne, scopedDeleteOne, tenantScope, resolveScopedModel } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'recurring-task-store' });

export interface CreateRecurringTaskInput {
  name: string;
  cronExpr: string;
  repo: string;
  title: string;
  description?: string;
  priority?: TaskPriority;
  assignedAgent?: string;
  recommendedModel?: string;
  notes?: string;
  overlapPolicy?: RecurringOverlapPolicy;
  enabled?: boolean;
  nextFireAt: Date;
}

export interface UpdateRecurringTaskInput {
  recurringId: string;
  name?: string;
  cronExpr?: string;
  repo?: string;
  title?: string;
  description?: string;
  priority?: TaskPriority;
  assignedAgent?: string;
  recommendedModel?: string;
  notes?: string;
  overlapPolicy?: RecurringOverlapPolicy;
  enabled?: boolean;
  nextFireAt?: Date;
}

export interface ListRecurringTasksFilter {
  enabled?: boolean;
  repo?: string;
  limit?: number;
}

export interface RecurringTaskView {
  tenantId: string;
  recurringId: string;
  name: string;
  cronExpr: string;
  repo: string;
  title: string;
  description: string;
  priority: TaskPriority;
  assignedAgent?: string;
  recommendedModel?: string;
  notes?: string;
  overlapPolicy: RecurringOverlapPolicy;
  enabled: boolean;
  nextFireAt?: Date;
  lastFiredAt?: Date;
  lastFireStatus: RecurringFireStatus;
  lastTaskId?: string;
  lastError?: string;
  enqueueCount: number;
  skipCount: number;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface FireResultInput {
  recurringId: string;
  status: Exclude<RecurringFireStatus, 'never'>;
  /** taskId of the enqueued one-shot (status='enqueued' only). */
  taskId?: string;
  error?: string;
  nextFireAt: Date;
  firedAt: Date;
}

function toView(doc: IRecurringTask): RecurringTaskView {
  return {
    tenantId: doc.tenantId,
    recurringId: doc.recurringId,
    name: doc.name,
    cronExpr: doc.cronExpr,
    repo: doc.repo,
    title: doc.title,
    description: doc.description,
    priority: doc.priority,
    assignedAgent: doc.assignedAgent,
    recommendedModel: doc.recommendedModel,
    notes: doc.notes,
    overlapPolicy: doc.overlapPolicy,
    enabled: doc.enabled,
    nextFireAt: doc.nextFireAt,
    lastFiredAt: doc.lastFiredAt,
    lastFireStatus: doc.lastFireStatus,
    lastTaskId: doc.lastTaskId,
    lastError: doc.lastError,
    enqueueCount: doc.enqueueCount,
    skipCount: doc.skipCount,
    errorCount: doc.errorCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function requireDb(): void {
  if (!isConnected() || !RecurringTaskModel) {
    throw new Error('MongoDB not connected — recurring tasks unavailable');
  }
}

export async function createRecurringTask(tenantId: string, input: CreateRecurringTaskInput, connection?: Connection): Promise<RecurringTaskView> {
  requireDb();
  const doc = await resolveScopedModel(RecurringTaskModel, connection).create({
    ...tenantScope(tenantId),
    recurringId: `rt-${randomUUID()}`,
    name: input.name,
    cronExpr: input.cronExpr,
    repo: input.repo,
    title: input.title,
    description: input.description ?? '',
    priority: input.priority ?? 'P2',
    assignedAgent: input.assignedAgent,
    recommendedModel: input.recommendedModel,
    notes: input.notes,
    overlapPolicy: input.overlapPolicy ?? 'skip',
    enabled: input.enabled ?? true,
    nextFireAt: input.nextFireAt,
    lastFireStatus: 'never',
    enqueueCount: 0,
    skipCount: 0,
    errorCount: 0,
  });
  log.info({ recurringId: doc.recurringId, cronExpr: doc.cronExpr, repo: doc.repo }, 'Recurring task created');
  return toView(doc);
}

export async function updateRecurringTask(tenantId: string, input: UpdateRecurringTaskInput, connection?: Connection): Promise<RecurringTaskView | null> {
  requireDb();
  const existing = await scopedFindOne(RecurringTaskModel, tenantId, { recurringId: input.recurringId }, connection);
  if (!existing) return null;

  if (input.name !== undefined) existing.name = input.name;
  if (input.cronExpr !== undefined) existing.cronExpr = input.cronExpr;
  if (input.repo !== undefined) existing.repo = input.repo;
  if (input.title !== undefined) existing.title = input.title;
  if (input.description !== undefined) existing.description = input.description;
  if (input.priority !== undefined) existing.priority = input.priority;
  if (input.assignedAgent !== undefined) existing.assignedAgent = input.assignedAgent;
  if (input.recommendedModel !== undefined) existing.recommendedModel = input.recommendedModel;
  if (input.notes !== undefined) existing.notes = input.notes;
  if (input.overlapPolicy !== undefined) existing.overlapPolicy = input.overlapPolicy;
  if (input.enabled !== undefined) existing.enabled = input.enabled;
  if (input.nextFireAt !== undefined) existing.nextFireAt = input.nextFireAt;

  await existing.save();
  log.info({ recurringId: existing.recurringId }, 'Recurring task updated');
  return toView(existing);
}

export async function getRecurringTask(tenantId: string, recurringId: string, connection?: Connection): Promise<RecurringTaskView | null> {
  requireDb();
  const doc = await scopedFindOne(RecurringTaskModel, tenantId, { recurringId }, connection);
  return doc ? toView(doc) : null;
}

export async function listRecurringTasks(tenantId: string, filter: ListRecurringTasksFilter = {}, connection?: Connection): Promise<RecurringTaskView[]> {
  requireDb();
  const query: Record<string, unknown> = {};
  if (filter.enabled !== undefined) query.enabled = filter.enabled;
  if (filter.repo) query.repo = filter.repo;

  const docs = await scopedFind(RecurringTaskModel, tenantId, query, connection)
    .sort({ nextFireAt: 1, createdAt: 1 })
    .limit(filter.limit ?? 100)
    .exec();

  return docs.map(toView);
}

/**
 * Find every DUE recurring task across ALL tenants. Same posture as
 * schedule-store's findDueSchedules: the sweep runs under SYSTEM_CONTEXT and
 * deliberately spans tenants so one gateway ticks the whole fleet. Each
 * returned view carries its own `tenantId`, and the sweep MUST enqueue each
 * due template's one-shot under that tenant (never cross-tenant). NOT a
 * tenant-scoped read; do not add a tenant filter here.
 */
export async function findDueRecurringTasks(now: Date): Promise<RecurringTaskView[]> {
  requireDb();
  const docs = await RecurringTaskModel.find({
    enabled: true,
    nextFireAt: { $lte: now },
  })
    .sort({ nextFireAt: 1 })
    .exec();
  return docs.map(toView);
}

export async function recordFireResult(tenantId: string, input: FireResultInput, connection?: Connection): Promise<RecurringTaskView | null> {
  requireDb();
  const existing = await scopedFindOne(RecurringTaskModel, tenantId, { recurringId: input.recurringId }, connection);
  if (!existing) return null;

  existing.lastFiredAt = input.firedAt;
  existing.lastFireStatus = input.status;
  existing.nextFireAt = input.nextFireAt;
  if (input.status === 'enqueued') {
    existing.lastTaskId = input.taskId;
    existing.lastError = undefined;
    existing.enqueueCount += 1;
  } else if (input.status === 'skipped') {
    // Keep lastTaskId — it still points at the open instance that caused the skip.
    existing.lastError = undefined;
    existing.skipCount += 1;
  } else {
    existing.lastError = input.error;
    existing.errorCount += 1;
  }
  await existing.save();
  return toView(existing);
}

export async function deleteRecurringTask(tenantId: string, recurringId: string, connection?: Connection): Promise<boolean> {
  requireDb();
  const result = await scopedDeleteOne(RecurringTaskModel, tenantId, { recurringId }, connection);
  return (result.deletedCount ?? 0) > 0;
}
