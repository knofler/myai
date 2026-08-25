import type { Connection } from 'mongoose';
import { PlanDayModel, isConnected } from '../shared/db.js';
import type { IPlanDay } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOneAndUpdate, tenantScope } from '../shared/scoped-query.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { trashPlanDays } from '../core/trash-bin.js';
import { buildAfterFilter, encodeCursor, hydrateCursor } from '../shared/pagination.js';

const log = createChildLogger({ module: 'plan-store' });

export type PlanDayStatus = 'enabled' | 'disabled' | 'done' | 'blocked';

export interface PlanDayInput {
  day: number;
  focus: string;
  status?: PlanDayStatus;
  fireAt?: string; // ISO; if omitted, computed from startDate + (day-1)
  notes?: string;
}

export interface SetPlanInput {
  repo: string;
  startDate?: string; // ISO date; default = today.
  fireHourUtc?: number; // default 10 UTC (≈ 8pm Sydney AEST) — OFF-HOURS
  days: PlanDayInput[];
  replace?: boolean; // if true, clear existing days first
}

// Off-hours policy (user 2026-06-12): autonomous runs only outside the user's
// interactive window (weekday 9am–6pm Sydney). Plan fire times must sit in the
// off-hours band 6pm–9am Sydney. Default = 8pm Sydney = 10:00 UTC (AEST UTC+10).
const DEFAULT_FIRE_HOUR_UTC = 10;
const SYD_OFFSET = 10; // AEST (winter). Sydney hour = (utcHour + 10) % 24.

// Clamp any fireAt whose Sydney hour lands in the weekday work window
// (9am–6pm) into the off-hours band (moves it to the default off-hours hour,
// same UTC date). Guarantees /plan never shows a 9am–6pm fire.
function clampToOffHours(d: Date): Date {
  const sydHour = (d.getUTCHours() + SYD_OFFSET) % 24;
  if (sydHour >= 9 && sydHour < 18) {
    d.setUTCHours(DEFAULT_FIRE_HOUR_UTC, 0, 0, 0);
  }
  return d;
}

export interface PlanDayView {
  repo: string;
  day: number;
  fireAt: Date;
  focus: string;
  status: PlanDayStatus;
  notes?: string;
  updatedAt: Date;
}

function toView(d: IPlanDay): PlanDayView {
  return { repo: d.repo, day: d.day, fireAt: d.fireAt, focus: d.focus, status: d.status, notes: d.notes, updatedAt: d.updatedAt };
}

function computeFireAt(startDate: string | undefined, fireHourUtc: number, day: number): Date {
  const base = startDate ? new Date(startDate) : new Date();
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(), fireHourUtc, 0, 0));
  d.setUTCDate(d.getUTCDate() + (day - 1));
  return clampToOffHours(d);
}

export async function setPlan(tenantId: string, input: SetPlanInput, connection?: Connection): Promise<{ count: number; days: PlanDayView[] } | null> {
  if (!isConnected() || !PlanDayModel) {
    log.warn('DB not connected — cannot set plan');
    return null;
  }
  if (!input.repo) throw new Error('repo is required');
  const fireHour = input.fireHourUtc ?? DEFAULT_FIRE_HOUR_UTC;

  // Soft delete, not a hard wipe (trash-bin.ts): the replaced plan's days move
  // into the recoverable TrashEntry collection, so an accidental
  // `plan_set replace:true` over a curated 10-day plan is restorable via
  // plan_restore for TRASH_RETENTION_DAYS. No-op when the repo has no days.
  if (input.replace) await trashPlanDays(tenantId, { repo: input.repo, reason: 'replaced via plan_set' }, undefined, connection);

  for (const d of input.days) {
    const fireAt = d.fireAt ? clampToOffHours(new Date(d.fireAt)) : computeFireAt(input.startDate, fireHour, d.day);
    await scopedFindOneAndUpdate(
      PlanDayModel, tenantId,
      { repo: input.repo, day: d.day },
      { $set: { fireAt, focus: d.focus, status: d.status ?? 'enabled', notes: d.notes }, $setOnInsert: { ...tenantScope(tenantId), repo: input.repo, day: d.day } },
      { upsert: true, setDefaultsOnInsert: true },
      connection,
    );
  }
  const days = (await scopedFind(PlanDayModel, tenantId, { repo: input.repo }, connection).sort({ day: 1 }).lean<IPlanDay[]>()).map(toView);
  log.info({ repo: input.repo, days: days.length }, 'plan set');
  // Real-time fleet-lifecycle event → dashboard /plan reacts live instead of
  // polling. Fire-and-forget: the notify bus never throws or blocks the write.
  emitNotifyEvent({
    type: 'plan.updated',
    tenantId,
    title: `Plan updated: ${input.repo}`,
    message: `${days.length} day(s) scheduled`,
    level: 'info',
    source: 'plan-store',
    data: { repo: input.repo, days: days.length, replaced: !!input.replace },
  });
  return { count: days.length, days };
}

export async function listPlan(tenantId: string, repo?: string, connection?: Connection): Promise<PlanDayView[]> {
  if (!isConnected() || !PlanDayModel) return [];
  const q = repo ? { repo } : {};
  const docs = await scopedFind(PlanDayModel, tenantId, q, connection).sort({ repo: 1, day: 1 }).lean<IPlanDay[]>();
  return docs.map(toView);
}

export interface ListPlanFilter {
  repo?: string;
  limit?: number;
  /** Opaque cursor from a prior page's `nextCursor` (optional — omit for the first page, same as before cursor pagination existed). */
  cursor?: string;
}

export interface ListPlanResult {
  days: PlanDayView[];
  /** Present only when more rows exist past this page. */
  nextCursor?: string;
}

// Stable sort for plan_list / GET /api/plan: repo then day — already a unique
// key per tenant (setPlan upserts on {repo, day}), so no extra tiebreaker needed.
const PLAN_LIST_SORT = { repo: 1, day: 1 } as const;
const PLAN_LIST_CURSOR_TEMPLATE = [{ field: 'repo' }, { field: 'day' }];
const DEFAULT_PLAN_LIST_LIMIT = 200;

/** Cursor-paginated variant of {@link listPlan} — used by the plan_list MCP tool and GET /api/plan. */
export async function listPlanPage(tenantId: string, filter: ListPlanFilter = {}, connection?: Connection): Promise<ListPlanResult> {
  if (!isConnected() || !PlanDayModel) return { days: [] };
  const query: Record<string, unknown> = {};
  if (filter.repo) query.repo = filter.repo;
  if (filter.cursor) {
    const keys = hydrateCursor(filter.cursor, PLAN_LIST_CURSOR_TEMPLATE);
    if (keys) Object.assign(query, buildAfterFilter(keys));
  }

  const limit = filter.limit ?? DEFAULT_PLAN_LIST_LIMIT;
  const docs = await scopedFind(PlanDayModel, tenantId, query, connection)
    .sort(PLAN_LIST_SORT)
    .limit(limit + 1)
    .lean<IPlanDay[]>();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const days = page.map(toView);
  const last = days[days.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor([{ field: 'repo', value: last.repo }, { field: 'day', value: last.day }])
    : undefined;

  return { days, nextCursor };
}

export async function setPlanDayStatus(tenantId: string, repo: string, day: number, status: PlanDayStatus, connection?: Connection): Promise<PlanDayView | null> {
  if (!isConnected() || !PlanDayModel) return null;
  const doc = await scopedFindOneAndUpdate(PlanDayModel, tenantId, { repo, day }, { $set: { status } }, { new: true }, connection);
  if (!doc) return null;
  const view = toView(doc as IPlanDay);
  emitNotifyEvent({
    type: 'plan.updated',
    tenantId,
    title: `Plan day ${day} ${status}: ${repo}`,
    message: view.focus,
    level: status === 'blocked' ? 'warning' : 'info',
    source: 'plan-store',
    data: { repo, day, status },
  });
  return view;
}
