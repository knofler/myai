/**
 * Trash bin — soft delete + restore for Tasks and PlanDays (recover instead
 * of hard delete).
 *
 * Deleting a task (tasks_delete) or a repo's plan (plan_delete /
 * plan_set replace:true) no longer destroys the docs: full snapshots move
 * into the tenant-scoped TrashEntry collection and the originals are removed
 * from the live collection. Within the retention window
 * (TRASH_RETENTION_DAYS, default 30) the delete is reversible via
 * tasks_restore / plan_restore, which re-insert the snapshots verbatim.
 * data-retention.ts's recurring purge hard-deletes entries past the window
 * (legal-hold tenants excluded, same as every other retention collection).
 *
 * Design: a dedicated trash collection, NOT an in-place `deletedAt` flag on
 * Task/PlanDay. The flag variant requires every live query — claimTask's
 * atomic pickup, the DAG dependency gates, list/count, the monitoring
 * sweeps — to remember an exclusion filter; one forgotten filter and a
 * runner claims a deleted task. Moving the doc out of the live collection
 * makes that failure mode impossible by construction (same rationale as
 * ADR-010's scoped-query chokepoint).
 *
 * Audit: the store records `task.trash` / `task.restore` / `plan.trash` /
 * `plan.restore` itself (actor supplied by the caller via
 * auditActorFromCtx), so every surface that reaches it is logged — a caller
 * cannot delete un-audited.
 */
import { randomUUID } from 'node:crypto';
import type { Connection } from 'mongoose';
import { TaskModel, PlanDayModel, TrashEntryModel, isConnected } from '../shared/db.js';
import type { ITask, IPlanDay, ITrashEntry, TrashKind } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import {
  scopedFind, scopedFindOne, scopedDeleteOne, scopedDeleteMany, scopedCountDocuments,
  tenantScope, resolveScopedModel,
} from '../shared/scoped-query.js';
import { recordAuditEvent } from './audit-log.js';
import type { AuditActor } from './audit-log.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';

const log = createChildLogger({ module: 'trash-bin' });

/** How long a trashed task/plan stays recoverable before the retention purge. */
export const TRASH_RETENTION_DAYS = Number(process.env.TRASH_RETENTION_DAYS) || 30;

const DAY_MS = 86_400_000;

/** System actor for internal call sites with no resolved ToolContext. */
export const SYSTEM_ACTOR: AuditActor = { role: 'system', via: 'system' };

export interface TrashEntryView {
  trashId: string;
  kind: TrashKind;
  label: string;
  repo: string;
  sourceId?: string;
  itemCount: number;
  deletedBy?: string;
  reason?: string;
  deletedAt: Date;
  /** When the retention purge becomes eligible to hard-delete this entry. */
  purgeAfter: Date;
}

function toView(doc: ITrashEntry): TrashEntryView {
  return {
    trashId: doc.trashId,
    kind: doc.kind,
    label: doc.label,
    repo: doc.repo,
    sourceId: doc.sourceId,
    itemCount: doc.snapshots.length,
    deletedBy: doc.deletedBy,
    reason: doc.reason,
    deletedAt: doc.deletedAt,
    purgeAfter: new Date(doc.deletedAt.getTime() + TRASH_RETENTION_DAYS * DAY_MS),
  };
}

function requireDb(): void {
  if (!isConnected() || !TrashEntryModel) {
    throw new Error('MongoDB not connected — trash bin unavailable');
  }
}

/** Full-fidelity doc snapshot: everything except Mongo's own _id/__v. */
function snapshotOf(doc: { toObject(): Record<string, unknown> }): Record<string, unknown> {
  const raw = doc.toObject();
  delete raw._id;
  delete raw.__v;
  return raw;
}

function actorLabel(actor: AuditActor): string {
  return actor.userId ?? actor.via;
}

export interface TrashTaskInput {
  taskId: string;
  reason?: string;
}

export interface TrashTaskResult {
  trash: TrashEntryView;
  /** The deleted task's snapshot, echoed so the caller sees what was removed. */
  task: Record<string, unknown>;
}

/**
 * Soft-delete one task: snapshot → TrashEntry, then remove the live doc.
 * Tenant-scoped (a leaked cross-tenant taskId reads as "not found"). A
 * `working` task is refused — it is held by a live runner lease; deleting it
 * mid-run would strand the runner's completion update. Release it first
 * (tasks_fail / tasks_update).
 */
export async function trashTask(
  tenantId: string,
  input: TrashTaskInput,
  actor: AuditActor = SYSTEM_ACTOR,
  connection?: Connection,
): Promise<TrashTaskResult | null> {
  requireDb();
  const existing = await scopedFindOne(TaskModel, tenantId, { taskId: input.taskId }, connection);
  if (!existing) return null;
  const task = existing as ITask;
  if (task.status === 'working') {
    throw new Error(
      `Task ${task.taskId} is status 'working' (claimed by ${task.claimedBy ?? 'unknown'}) — ` +
      'release it first (tasks_fail or tasks_update) before deleting.',
    );
  }

  const snapshot = snapshotOf(existing);
  const now = new Date();
  const entry = await resolveScopedModel(TrashEntryModel, connection).create({
    ...tenantScope(tenantId),
    trashId: `trash-${randomUUID()}`,
    kind: 'task',
    label: task.title,
    repo: task.repo,
    sourceId: task.taskId,
    snapshots: [snapshot],
    deletedBy: actorLabel(actor),
    reason: input.reason,
    deletedAt: now,
  });
  await scopedDeleteOne(TaskModel, tenantId, { taskId: task.taskId }, connection);

  log.info({ taskId: task.taskId, trashId: entry.trashId, repo: task.repo }, 'Task moved to trash');
  recordAuditEvent({
    tenantId,
    actor,
    action: 'task.trash',
    target: task.taskId,
    detail: { trashId: entry.trashId, repo: task.repo, title: task.title, status: task.status, reason: input.reason },
  });
  emitNotifyEvent({
    type: 'task.deleted',
    tenantId,
    title: `Task deleted: ${task.title}`,
    message: `[${task.repo}] moved to trash — recoverable for ${TRASH_RETENTION_DAYS}d (tasks_restore ${entry.trashId})`,
    level: 'info',
    source: 'trash-bin',
    data: { taskId: task.taskId, repo: task.repo, trashId: entry.trashId },
  });

  return { trash: toView(entry as ITrashEntry), task: snapshot };
}

export interface RestoreTaskInput {
  /** The trash entry handle, or omit and pass the original taskId instead. */
  trashId?: string;
  taskId?: string;
}

/**
 * Restore a trashed task: re-insert the snapshot into the live collection and
 * consume the trash entry. Addressable by trashId or by the original taskId.
 */
export async function restoreTask(
  tenantId: string,
  input: RestoreTaskInput,
  actor: AuditActor = SYSTEM_ACTOR,
  connection?: Connection,
): Promise<Record<string, unknown> | null> {
  requireDb();
  if (!input.trashId && !input.taskId) throw new Error('trashId or taskId is required');
  const filter: Record<string, unknown> = { kind: 'task' };
  if (input.trashId) filter.trashId = input.trashId;
  else filter.sourceId = input.taskId;
  const entry = await scopedFindOne(TrashEntryModel, tenantId, filter, connection) as ITrashEntry | null;
  if (!entry || !entry.snapshots.length) return null;

  const snapshot = entry.snapshots[0];
  // taskId is globally unique — a live doc under the same id (recreated since
  // the delete) makes the restore ambiguous; surface it rather than clobber.
  const live = await scopedFindOne(TaskModel, tenantId, { taskId: entry.sourceId }, connection);
  if (live) {
    throw new Error(
      `Cannot restore ${entry.sourceId}: an active task with that id already exists ` +
      '(recreated since the delete). Delete or re-point it first.',
    );
  }

  await resolveScopedModel(TaskModel, connection).create({ ...snapshot, ...tenantScope(tenantId) });
  await scopedDeleteOne(TrashEntryModel, tenantId, { trashId: entry.trashId }, connection);

  log.info({ taskId: entry.sourceId, trashId: entry.trashId }, 'Task restored from trash');
  recordAuditEvent({
    tenantId,
    actor,
    action: 'task.restore',
    target: entry.sourceId,
    detail: { trashId: entry.trashId, repo: entry.repo, title: entry.label },
  });
  emitNotifyEvent({
    type: 'task.restored',
    tenantId,
    title: `Task restored: ${entry.label}`,
    message: `[${entry.repo}] recovered from trash`,
    level: 'info',
    source: 'trash-bin',
    data: { taskId: entry.sourceId, repo: entry.repo, trashId: entry.trashId },
  });

  return snapshot;
}

export interface TrashPlanInput {
  repo: string;
  reason?: string;
}

export interface TrashPlanResult {
  trash: TrashEntryView;
  dayCount: number;
}

/**
 * Soft-delete a repo's entire plan: snapshot every PlanDay into ONE trash
 * entry, then remove the live docs. Called by the plan_delete tool AND by
 * setPlan(replace:true) — the historical hard-wipe path — so an accidental
 * plan replace is recoverable too. No days → null (nothing to trash).
 */
export async function trashPlanDays(
  tenantId: string,
  input: TrashPlanInput,
  actor: AuditActor = SYSTEM_ACTOR,
  connection?: Connection,
): Promise<TrashPlanResult | null> {
  requireDb();
  const days = await scopedFind(PlanDayModel, tenantId, { repo: input.repo }, connection).sort({ day: 1 }).exec() as unknown as IPlanDay[];
  if (!days.length) return null;

  const now = new Date();
  const entry = await resolveScopedModel(TrashEntryModel, connection).create({
    ...tenantScope(tenantId),
    trashId: `trash-${randomUUID()}`,
    kind: 'plan',
    label: `${input.repo} plan (${days.length} day${days.length === 1 ? '' : 's'})`,
    repo: input.repo,
    snapshots: days.map((d) => snapshotOf(d as unknown as { toObject(): Record<string, unknown> })),
    deletedBy: actorLabel(actor),
    reason: input.reason,
    deletedAt: now,
  });
  await scopedDeleteMany(PlanDayModel, tenantId, { repo: input.repo }, connection);

  log.info({ repo: input.repo, days: days.length, trashId: entry.trashId }, 'Plan moved to trash');
  recordAuditEvent({
    tenantId,
    actor,
    action: 'plan.trash',
    target: input.repo,
    detail: { trashId: entry.trashId, days: days.length, reason: input.reason },
  });
  emitNotifyEvent({
    type: 'plan.updated',
    tenantId,
    title: `Plan deleted: ${input.repo}`,
    message: `${days.length} day(s) moved to trash — recoverable for ${TRASH_RETENTION_DAYS}d (plan_restore ${entry.trashId})`,
    level: 'info',
    source: 'trash-bin',
    data: { repo: input.repo, days: days.length, trashId: entry.trashId },
  });

  return { trash: toView(entry as ITrashEntry), dayCount: days.length };
}

export interface RestorePlanInput {
  /** The trash entry handle, or omit and pass repo to restore its NEWEST trashed plan. */
  trashId?: string;
  repo?: string;
}

export interface RestorePlanResult {
  repo: string;
  trashId: string;
  restoredDays: number[];
  /** Days that now conflict with a live plan row ({repo, day} is unique) —
   *  kept in the trash entry, never silently dropped. */
  skippedConflicts: number[];
  /** True when the entry was fully consumed (no snapshots left in trash). */
  trashConsumed: boolean;
}

/**
 * Restore a trashed plan. Days whose {repo, day} slot is now occupied by a
 * live row (a new plan was set after the delete) are SKIPPED and remain in
 * the trash entry — restoring never clobbers current work; the response
 * reports both sets so nothing vanishes silently. The entry is deleted only
 * once every snapshot has been restored.
 */
export async function restorePlan(
  tenantId: string,
  input: RestorePlanInput,
  actor: AuditActor = SYSTEM_ACTOR,
  connection?: Connection,
): Promise<RestorePlanResult | null> {
  requireDb();
  if (!input.trashId && !input.repo) throw new Error('trashId or repo is required');
  const filter: Record<string, unknown> = { kind: 'plan' };
  if (input.trashId) filter.trashId = input.trashId;
  else filter.repo = input.repo;
  const entry = await scopedFindOne(TrashEntryModel, tenantId, filter, connection)
    .sort({ deletedAt: -1 }) as unknown as ITrashEntry | null;
  if (!entry || !entry.snapshots.length) return null;

  const restoredDays: number[] = [];
  const skippedConflicts: number[] = [];
  const remaining: Record<string, unknown>[] = [];
  const model = resolveScopedModel(PlanDayModel, connection);

  for (const snapshot of entry.snapshots) {
    const day = snapshot.day as number;
    const conflict = await scopedCountDocuments(PlanDayModel, tenantId, { repo: entry.repo, day }, connection);
    if (conflict > 0) {
      skippedConflicts.push(day);
      remaining.push(snapshot);
      continue;
    }
    await model.create({ ...snapshot, ...tenantScope(tenantId) });
    restoredDays.push(day);
  }

  const trashConsumed = remaining.length === 0;
  if (trashConsumed) {
    await scopedDeleteOne(TrashEntryModel, tenantId, { trashId: entry.trashId }, connection);
  } else if (restoredDays.length) {
    entry.snapshots = remaining;
    entry.markModified?.('snapshots');
    await entry.save();
  }

  log.info(
    { repo: entry.repo, trashId: entry.trashId, restored: restoredDays.length, skipped: skippedConflicts.length },
    'Plan restored from trash',
  );
  recordAuditEvent({
    tenantId,
    actor,
    action: 'plan.restore',
    target: entry.repo,
    detail: { trashId: entry.trashId, restoredDays, skippedConflicts },
  });
  emitNotifyEvent({
    type: 'plan.updated',
    tenantId,
    title: `Plan restored: ${entry.repo}`,
    message: `${restoredDays.length} day(s) recovered from trash${skippedConflicts.length ? `, ${skippedConflicts.length} skipped (conflict with live plan)` : ''}`,
    level: 'info',
    source: 'trash-bin',
    data: { repo: entry.repo, trashId: entry.trashId, restoredDays, skippedConflicts },
  });

  return { repo: entry.repo, trashId: entry.trashId, restoredDays, skippedConflicts, trashConsumed };
}

export interface ListTrashFilter {
  kind?: TrashKind;
  repo?: string;
  limit?: number;
}

/** Tenant's trash bin, newest first. */
export async function listTrash(
  tenantId: string,
  filter: ListTrashFilter = {},
  connection?: Connection,
): Promise<TrashEntryView[]> {
  requireDb();
  const query: Record<string, unknown> = {};
  if (filter.kind) query.kind = filter.kind;
  if (filter.repo) query.repo = filter.repo;
  const docs = await scopedFind(TrashEntryModel, tenantId, query, connection)
    .sort({ deletedAt: -1 })
    .limit(filter.limit ?? 50)
    .exec();
  return (docs as unknown as ITrashEntry[]).map(toView);
}

/**
 * Hard-delete trash entries past the retention window — the ONLY destructive
 * path. Cross-tenant by design (invoked from data-retention.ts's purge, same
 * posture as the Task/PlanDay retention sweeps); `excludeTenantIds` carries
 * the legal-hold list.
 */
export async function purgeExpiredTrash(
  now: Date = new Date(),
  excludeTenantIds: string[] = [],
): Promise<number> {
  if (!isConnected() || !TrashEntryModel) return 0;
  const cutoff = new Date(now.getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const res = await TrashEntryModel.deleteMany({
    ...(excludeTenantIds.length ? { tenantId: { $nin: excludeTenantIds } } : {}),
    deletedAt: { $lt: cutoff },
  });
  const purged = res.deletedCount ?? 0;
  if (purged) log.info({ purged, cutoff }, 'Expired trash entries purged');
  return purged;
}
