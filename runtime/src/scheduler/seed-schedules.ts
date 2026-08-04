/**
 * Idempotent seeding of the standard gateway schedules.
 *
 * The scheduler subsystem ships with zero schedules — nothing runs
 * autonomously until the standard set is seeded. This module creates the
 * default daily sweeps, matching by name so repeated invocations never
 * duplicate. Existing schedules are left untouched (reported under
 * `existing`); `updated` is reserved for future drift-correction and is
 * always empty today.
 *
 * Defaults seeded:
 *   - morning_sweep_daily         → kind=tool, target=morning_sweep, 09:00 UTC daily
 *   - evening_sweep_daily         → kind=tool, target=evening_sweep, 18:00 UTC daily
 *   - data_retention_purge_daily  → kind=tool, target=data_retention_purge, 03:00 UTC daily
 *   - mrr_snapshot_sweep_daily    → kind=tool, target=mrr_snapshot_sweep, 02:00 UTC daily
 *   - erasure_sweep_daily         → kind=tool, target=erasure_sweep, 04:00 UTC daily
 *   - task_lease_reap_15min       → kind=tool, target=task_lease_reap, every 15 minutes
 *   - inline_exec_cycle_5min      → kind=tool, target=inline_execute, every 5 minutes
 *
 * `inline_exec_cycle_5min` (ADR-018) is the activation wire-up for the
 * in-gateway inline execution lane: seeding it is what actually gives
 * `INLINE_EXEC_ENABLED=1` an effect. Safe to seed unconditionally — the tool
 * it dispatches (`inline_execute` → `runInlineCycle`) is a no-op read-then-return
 * whenever `agentRuntime.inlineEnabled` is false (the default), so this
 * schedule existing changes nothing until an operator separately opts the
 * flag in.
 *
 * Conventions mirror `registerDispatchSchedule` in dispatch-worker.ts:
 * tool-kind schedules dispatch the named MCP tool directly, with args
 * parsed from the `message` field as a JSON object literal ('{}' = no args).
 */

import { listSchedules, createSchedule } from './schedule-store.js';
import type { CreateScheduleInput } from './schedule-store.js';
import { computeNextRun } from './scheduler.js';
import { createChildLogger } from '../shared/logger.js';
import { DEFAULT_TENANT_ID } from '../shared/db.js';

const log = createChildLogger({ module: 'seed-schedules' });

export interface SeedResult {
  created: string[];
  existing: string[];
  updated: string[];
}

type DefaultScheduleSpec = Omit<CreateScheduleInput, 'nextRun' | 'enabled'>;

const DEFAULT_SCHEDULES: DefaultScheduleSpec[] = [
  {
    name: 'morning_sweep_daily',
    cronExpr: '0 9 * * *', // 09:00 UTC daily
    kind: 'tool',
    target: 'morning_sweep',
    message: '{}',
  },
  {
    name: 'evening_sweep_daily',
    cronExpr: '0 18 * * *', // 18:00 UTC daily
    kind: 'tool',
    target: 'evening_sweep',
    message: '{}',
  },
  {
    name: 'data_retention_purge_daily',
    cronExpr: '0 3 * * *', // 03:00 UTC daily — off-peak, ahead of the morning sweep
    kind: 'tool',
    target: 'data_retention_purge',
    message: '{}',
  },
  {
    name: 'mrr_snapshot_sweep_daily',
    cronExpr: '0 2 * * *', // 02:00 UTC daily — ahead of data-retention/morning sweeps
    kind: 'tool',
    target: 'mrr_snapshot_sweep',
    message: '{}',
  },
  {
    name: 'erasure_sweep_daily',
    cronExpr: '0 4 * * *', // 04:00 UTC daily — after data-retention purge, ahead of the morning sweep
    kind: 'tool',
    target: 'erasure_sweep',
    message: '{}',
  },
  {
    name: 'task_lease_reap_15min',
    cronExpr: '*/15 * * * *', // every 15 minutes — well under the default 1h claim lease, so a dead runner's task is freed promptly
    kind: 'tool',
    target: 'task_lease_reap',
    message: '{}',
  },
  {
    name: 'inline_exec_cycle_5min',
    cronExpr: '*/5 * * * *', // every 5 minutes — a no-op cadence until INLINE_EXEC_ENABLED=1
    kind: 'tool',
    target: 'inline_execute',
    message: '{}',
  },
];

/**
 * Seed the default schedules. Idempotent — matches by schedule name and
 * never duplicates. Schedules that already exist are left alone.
 *
 * @param opts.enabled Whether newly created schedules fire (default true).
 */
export async function seedDefaultSchedules(opts: { enabled?: boolean } = {}): Promise<SeedResult> {
  const enabled = opts.enabled ?? true;
  const result: SeedResult = { created: [], existing: [], updated: [] };

  // Operator-level default schedules belong to the default tenant.
  const current = await listSchedules(DEFAULT_TENANT_ID, {});
  const existingNames = new Set(current.map(s => s.name));

  for (const spec of DEFAULT_SCHEDULES) {
    if (existingNames.has(spec.name)) {
      result.existing.push(spec.name);
      log.info({ name: spec.name }, 'Schedule already exists — leaving untouched');
      continue;
    }

    await createSchedule(DEFAULT_TENANT_ID, {
      ...spec,
      enabled,
      nextRun: computeNextRun(spec.cronExpr),
    });
    result.created.push(spec.name);
    log.info({ name: spec.name, cronExpr: spec.cronExpr, target: spec.target, enabled }, 'Default schedule seeded');
  }

  log.info(
    { created: result.created.length, existing: result.existing.length, updated: result.updated.length },
    'Schedule seeding complete',
  );
  return result;
}
