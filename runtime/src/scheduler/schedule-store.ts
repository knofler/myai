import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import { ScheduleModel, isConnected } from '../shared/db.js';
import type { ISchedule, ScheduleKind, ScheduleStatus } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOne, scopedDeleteOne, tenantScope, resolveScopedModel } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'schedule-store' });

export interface CreateScheduleInput {
  name: string;
  cronExpr: string;
  kind: ScheduleKind;
  target: string;
  message: string;
  repo?: string;
  includeMemoryContext?: boolean;
  enabled?: boolean;
  nextRun: Date;
}

export interface UpdateScheduleInput {
  scheduleId: string;
  name?: string;
  cronExpr?: string;
  message?: string;
  repo?: string;
  includeMemoryContext?: boolean;
  enabled?: boolean;
  nextRun?: Date;
}

export interface ListSchedulesFilter {
  enabled?: boolean;
  kind?: ScheduleKind;
  status?: ScheduleStatus;
  limit?: number;
}

export interface ScheduleView {
  tenantId: string;
  scheduleId: string;
  name: string;
  cronExpr: string;
  kind: ScheduleKind;
  target: string;
  message: string;
  repo?: string;
  includeMemoryContext: boolean;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  lastStatus: ScheduleStatus;
  lastError?: string;
  lastResultSummary?: string;
  runCount: number;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RunResultInput {
  scheduleId: string;
  status: 'success' | 'error';
  summary?: string;
  error?: string;
  nextRun: Date;
  ranAt: Date;
}

function toView(doc: ISchedule): ScheduleView {
  return {
    tenantId: doc.tenantId,
    scheduleId: doc.scheduleId,
    name: doc.name,
    cronExpr: doc.cronExpr,
    kind: doc.kind,
    target: doc.target,
    message: doc.message,
    repo: doc.repo,
    includeMemoryContext: doc.includeMemoryContext,
    enabled: doc.enabled,
    lastRun: doc.lastRun,
    nextRun: doc.nextRun,
    lastStatus: doc.lastStatus,
    lastError: doc.lastError,
    lastResultSummary: doc.lastResultSummary,
    runCount: doc.runCount,
    errorCount: doc.errorCount,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function requireDb(): void {
  if (!isConnected() || !ScheduleModel) {
    throw new Error('MongoDB not connected — scheduler unavailable');
  }
}

export async function createSchedule(tenantId: string, input: CreateScheduleInput, connection?: Connection): Promise<ScheduleView> {
  requireDb();
  const doc = await resolveScopedModel(ScheduleModel, connection).create({
    ...tenantScope(tenantId),
    scheduleId: `sched-${randomUUID()}`,
    name: input.name,
    cronExpr: input.cronExpr,
    kind: input.kind,
    target: input.target,
    message: input.message,
    repo: input.repo,
    includeMemoryContext: input.includeMemoryContext ?? false,
    enabled: input.enabled ?? true,
    nextRun: input.nextRun,
    lastStatus: 'never',
    runCount: 0,
    errorCount: 0,
  });
  log.info({ scheduleId: doc.scheduleId, cronExpr: doc.cronExpr, target: doc.target }, 'Schedule created');
  return toView(doc);
}

export async function updateSchedule(tenantId: string, input: UpdateScheduleInput, connection?: Connection): Promise<ScheduleView | null> {
  requireDb();
  const existing = await scopedFindOne(ScheduleModel, tenantId, { scheduleId: input.scheduleId }, connection);
  if (!existing) return null;

  if (input.name !== undefined) existing.name = input.name;
  if (input.cronExpr !== undefined) existing.cronExpr = input.cronExpr;
  if (input.message !== undefined) existing.message = input.message;
  if (input.repo !== undefined) existing.repo = input.repo;
  if (input.includeMemoryContext !== undefined) existing.includeMemoryContext = input.includeMemoryContext;
  if (input.enabled !== undefined) existing.enabled = input.enabled;
  if (input.nextRun !== undefined) existing.nextRun = input.nextRun;

  await existing.save();
  log.info({ scheduleId: existing.scheduleId }, 'Schedule updated');
  return toView(existing);
}

export async function getSchedule(tenantId: string, scheduleId: string, connection?: Connection): Promise<ScheduleView | null> {
  requireDb();
  const doc = await scopedFindOne(ScheduleModel, tenantId, { scheduleId }, connection);
  return doc ? toView(doc) : null;
}

export async function listSchedules(tenantId: string, filter: ListSchedulesFilter = {}, connection?: Connection): Promise<ScheduleView[]> {
  requireDb();
  const query: Record<string, unknown> = {};
  if (filter.enabled !== undefined) query.enabled = filter.enabled;
  if (filter.kind) query.kind = filter.kind;
  if (filter.status) query.lastStatus = filter.status;

  const docs = await scopedFind(ScheduleModel, tenantId, query, connection)
    .sort({ nextRun: 1, createdAt: 1 })
    .limit(filter.limit ?? 100)
    .exec();

  return docs.map(toView);
}

/**
 * Find every DUE schedule across ALL tenants. This is the scheduler's per-minute
 * system sweep (runs under SYSTEM_CONTEXT, no single tenant) — it deliberately
 * spans tenants so one runner ticks the whole fleet. Each returned view carries
 * its own `tenantId`, and the dispatcher MUST execute each due schedule's tool
 * under that schedule's tenant context (never cross-tenant). NOT a tenant-scoped
 * read; do not add a tenant filter here.
 */
export async function findDueSchedules(now: Date): Promise<ScheduleView[]> {
  requireDb();
  const docs = await ScheduleModel.find({
    enabled: true,
    nextRun: { $lte: now },
  })
    .sort({ nextRun: 1 })
    .exec();
  return docs.map(toView);
}

export async function recordRunResult(tenantId: string, input: RunResultInput, connection?: Connection): Promise<ScheduleView | null> {
  requireDb();
  const existing = await scopedFindOne(ScheduleModel, tenantId, { scheduleId: input.scheduleId }, connection);
  if (!existing) return null;

  existing.lastRun = input.ranAt;
  existing.lastStatus = input.status;
  existing.nextRun = input.nextRun;
  existing.runCount += 1;
  if (input.status === 'success') {
    existing.lastResultSummary = input.summary;
    existing.lastError = undefined;
  } else {
    existing.lastError = input.error;
    existing.errorCount += 1;
  }
  await existing.save();
  return toView(existing);
}

export async function deleteSchedule(tenantId: string, scheduleId: string, connection?: Connection): Promise<boolean> {
  requireDb();
  const result = await scopedDeleteOne(ScheduleModel, tenantId, { scheduleId }, connection);
  return (result.deletedCount ?? 0) > 0;
}
