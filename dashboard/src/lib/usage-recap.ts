// Per-tenant "year in review" usage recap — dashboard read side.
//
// ⚠ Mirror of runtime/src/analytics/usage-recap.ts — the two packages don't
// share code (same convention as db.ts's read mirrors). The canonical,
// unit-tested copy lives in the runtime; keep them in sync. Aggregates the
// same product-usage ledger the /system → Usage tab reads (UsageEvent) plus
// the task queue directly for "shipped" counts, tenant-scoped via
// tenantFilter() from lib/tenant.ts. Distinct from the operator MRR/ARR/NRR
// dashboards (lib/revenue.ts, lib/nrr-cohort.ts) — this is a tenant-facing,
// marketing-grade value recap, not a revenue view.

import { Task, UsageEvent } from './db';

/**
 * Assumed average engineer time to hand-build what one shipped task
 * automated (write, test, review) — the "hours saved" headline is
 * `tasksShipped * hoursPerTask + offhoursMinutes / 60`. Mirror of the runtime
 * DEFAULT_HOURS_PER_TASK. Overridable via MYAI_HOURS_PER_TASK.
 */
export const DEFAULT_HOURS_PER_TASK = 0.75;

export function hoursPerTask(): number {
  const raw = Number(process.env.MYAI_HOURS_PER_TASK);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOURS_PER_TASK;
}

export function computeEngineerHoursSaved(
  tasksShipped: number,
  offhoursMinutes: number,
  perTask: number = hoursPerTask(),
): number {
  const tasks = Number.isFinite(tasksShipped) && tasksShipped > 0 ? tasksShipped : 0;
  const offMin = Number.isFinite(offhoursMinutes) && offhoursMinutes > 0 ? offhoursMinutes : 0;
  return tasks * perTask + offMin / 60;
}

export interface UsageRecapSummary {
  periodStart: string;
  periodEnd: string;
  tasksShipped: number;
  appsGenerated: number;
  offhoursMinutes: number;
  offhoursHours: number;
  engineerHoursSaved: number;
  hoursPerTask: number;
}

function yearAgoUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear() - 1, now.getUTCMonth(), now.getUTCDate()));
}

function emptySummary(from: Date, to: Date, perTask: number): UsageRecapSummary {
  return {
    periodStart: from.toISOString().slice(0, 10),
    periodEnd: to.toISOString().slice(0, 10),
    tasksShipped: 0,
    appsGenerated: 0,
    offhoursMinutes: 0,
    offhoursHours: 0,
    engineerHoursSaved: 0,
    hoursPerTask: perTask,
  };
}

/**
 * Per-tenant recap over a period (default: trailing 12 months). `match` is
 * the caller's Mongo filter (tenantFilter(tenantId)). Never throws — degrades
 * to zeros so the recap page/card always renders.
 */
export async function getUsageRecap(
  match: Record<string, unknown>,
  opts: { from?: Date; to?: Date; hoursPerTask?: number } = {},
): Promise<UsageRecapSummary> {
  const to = opts.to ?? new Date();
  const from = opts.from ?? yearAgoUtc(to);
  const perTask = opts.hoursPerTask ?? hoursPerTask();
  const summary = emptySummary(from, to, perTask);

  try {
    const period = { $gte: from, $lt: to };
    const [tasksShipped, appRows, offRows] = await Promise.all([
      Task.countDocuments({ ...match, status: 'done', completedAt: period }),
      UsageEvent.aggregate<{ _id: null; total: number }>([
        { $match: { ...match, type: 'app.generated', occurredAt: period } },
        { $group: { _id: null, total: { $sum: '$quantity' } } },
      ]),
      UsageEvent.aggregate<{ _id: null; total: number }>([
        { $match: { ...match, type: 'offhours.minutes', occurredAt: period } },
        { $group: { _id: null, total: { $sum: '$quantity' } } },
      ]),
    ]);

    summary.tasksShipped = tasksShipped;
    summary.appsGenerated = appRows[0]?.total ?? 0;
    summary.offhoursMinutes = offRows[0]?.total ?? 0;
    summary.offhoursHours = summary.offhoursMinutes / 60;
    summary.engineerHoursSaved = computeEngineerHoursSaved(summary.tasksShipped, summary.offhoursMinutes, perTask);
    return summary;
  } catch {
    return summary;
  }
}
