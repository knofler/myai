/**
 * Usage recap — the per-tenant "year in review" value summary.
 *
 * Distinct from the operator-facing MRR/ARR/NRR dashboards (analytics/revenue.ts,
 * analytics/nrr-cohort.ts) and the internal KPI-digest email: this is a
 * TENANT-facing, marketing-grade recap — tasks shipped, engineer-hours saved,
 * apps generated, off-hours minutes used — meant to be shown off (retention +
 * word-of-mouth), not to inform a revenue decision.
 *
 * Sources the same product-usage ledger the /system → Usage tab reads
 * (UsageEvent — ADR-014 S2) plus the task queue directly for "shipped" counts,
 * scoped by an arbitrary Mongo match (tenantFilter() from the caller — same
 * discipline as monitoring/continuity-metrics.ts::getUserSavings). Mirrored in
 * dashboard/src/lib/usage-recap.ts — keep the two in sync.
 */
import { isConnected, TaskModel, UsageEventModel } from '../shared/db.js';

/**
 * Assumed average engineer time to hand-build what one shipped task
 * automated (write, test, review) — the "hours saved" headline is
 * `tasksShipped * hoursPerTask + offhoursMinutes / 60` (the off-hours term is
 * pure unattended runner time on top of the per-task estimate). Deliberately a
 * conservative, documented assumption rather than a measured figure — same
 * spirit as monitoring/continuity-metrics.ts pricing tokens at the input-token
 * rate. Overridable via MYAI_HOURS_PER_TASK.
 */
export const DEFAULT_HOURS_PER_TASK = 0.75;

export function hoursPerTask(): number {
  const raw = Number(process.env.MYAI_HOURS_PER_TASK);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_HOURS_PER_TASK;
}

/** Pure calc — clamps negative/NaN inputs to 0 so a bad reading never goes negative. */
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
  periodStart: string; // ISO date (UTC)
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
 * Per-tenant recap over a period (default: trailing 12 months — a rolling
 * "year in review"). `match` is the caller's Mongo filter (e.g.
 * tenantFilter(tenantId) from lib/tenant.ts). Never throws — degrades to
 * zeros so the recap page/card always renders.
 */
export async function getUsageRecap(
  match: Record<string, unknown>,
  opts: { from?: Date; to?: Date; hoursPerTask?: number } = {},
): Promise<UsageRecapSummary> {
  const to = opts.to ?? new Date();
  const from = opts.from ?? yearAgoUtc(to);
  const perTask = opts.hoursPerTask ?? hoursPerTask();
  const summary = emptySummary(from, to, perTask);

  if (!isConnected() || !TaskModel || !UsageEventModel) return summary;

  try {
    const period = { $gte: from, $lt: to };
    const [tasksShipped, appRows, offRows] = await Promise.all([
      TaskModel.countDocuments({ ...match, status: 'done', completedAt: period }),
      UsageEventModel.aggregate<{ _id: null; total: number }>([
        { $match: { ...match, type: 'app.generated', occurredAt: period } },
        { $group: { _id: null, total: { $sum: '$quantity' } } },
      ]),
      UsageEventModel.aggregate<{ _id: null; total: number }>([
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
