/**
 * Fleet-wide task-claim kill switch — an operator-initiated maintenance
 * window that pauses `claimTask` (task-store.ts) across every runner on
 * every machine, without killing any process.
 *
 * Distinct from:
 *  - per-tenant rate limiting (core/tenant-quota.ts, core/auth-rate-limit.ts)
 *    — those throttle request *volume*; this stops ALL task claims outright.
 *  - the runner liveness heartbeat (runner-heartbeat-store.ts) — that reports
 *    whether a runner process is alive; this controls whether a live runner
 *    is *allowed* to claim work.
 *  - LLM provider maintenance (llm/provider-maintenance.ts) — that drains one
 *    provider via an in-memory per-process registry; this drains the whole
 *    fleet's task queue and must be visible across the gateway process AND
 *    the separate dashboard process (dashboard/src/lib/db.ts reads Mongo
 *    directly for the banner), so it is Mongo-backed rather than in-memory.
 *
 * One document per tenant (upserted, `active` on/off). `enterFleetMaintenance`
 * accepts an optional `resumeAt` for a schedulable window. Rather than an
 * in-process timer (which wouldn't survive a gateway restart or the host
 * sleeping), `getFleetMaintenanceStatus` lazily auto-exits once `resumeAt`
 * has passed — the same lazy-expiry idiom task-store.ts already uses for
 * lease reclaim (a stale `leaseUntil` is checked, not timer-driven).
 */
import { FleetMaintenanceModel, isConnected } from '../shared/db.js';
import type { IFleetMaintenance } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFindOne, scopedFindOneAndUpdate } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'fleet-maintenance-store' });

export interface FleetMaintenanceStatus {
  active: boolean;
  reason?: string;
  operator?: string;
  enteredAt?: Date;
  /** Scheduled auto-resume time, if this window was entered with one. */
  resumeAt?: Date;
}

export interface EnterFleetMaintenanceInput {
  reason?: string;
  operator?: string;
  /** Auto-resume at this time (a schedulable window). Omit to pause until an explicit exit. */
  resumeAt?: Date;
}

function requireDb(): void {
  if (!isConnected() || !FleetMaintenanceModel) {
    throw new Error('MongoDB not connected — fleet maintenance state unavailable');
  }
}

function toStatus(doc: IFleetMaintenance | null): FleetMaintenanceStatus {
  if (!doc || !doc.active) return { active: false };
  return {
    active: true,
    reason: doc.reason,
    operator: doc.operator,
    enteredAt: doc.enteredAt,
    resumeAt: doc.resumeAt,
  };
}

/**
 * Begin a fleet-wide maintenance window: every subsequent `claimTask` call
 * (any repo, any machine) returns null — as if the queue were empty — until
 * `exitFleetMaintenance` runs or `resumeAt` passes. Idempotent-ish: re-entering
 * while already active overwrites reason/operator/resumeAt, so extending or
 * rescheduling an in-progress window is just calling this again.
 */
export async function enterFleetMaintenance(
  tenantId: string,
  input: EnterFleetMaintenanceInput = {},
): Promise<FleetMaintenanceStatus> {
  requireDb();
  const now = new Date();
  const doc = (await scopedFindOneAndUpdate(
    FleetMaintenanceModel, tenantId,
    {},
    {
      $set: {
        active: true,
        reason: input.reason,
        operator: input.operator,
        enteredAt: now,
        resumeAt: input.resumeAt,
      },
    },
    { upsert: true, new: true },
  )) as IFleetMaintenance;
  log.warn(
    { reason: input.reason, operator: input.operator, resumeAt: input.resumeAt },
    'Fleet maintenance entered — all runner claims paused fleet-wide',
  );
  return toStatus(doc);
}

/** End the maintenance window immediately, resuming normal claims fleet-wide. */
export async function exitFleetMaintenance(tenantId: string): Promise<FleetMaintenanceStatus> {
  requireDb();
  const doc = (await scopedFindOneAndUpdate(
    FleetMaintenanceModel, tenantId,
    {},
    {
      $set: {
        active: false,
        reason: undefined,
        operator: undefined,
        enteredAt: undefined,
        resumeAt: undefined,
      },
    },
    { upsert: true, new: true },
  )) as IFleetMaintenance;
  log.info({}, 'Fleet maintenance ended — runner claims resumed fleet-wide');
  return toStatus(doc);
}

/**
 * Current fleet maintenance status. Auto-exits (persisting `active:false`)
 * once `resumeAt` has passed, so a scheduled window ends on its own — no
 * live timer or second process required.
 *
 * Read path only — degrades to `{active: false}` when Mongo/the model isn't
 * available (same convention as repo-store.ts's `listRepos`), rather than
 * throwing like `enterFleetMaintenance`/`exitFleetMaintenance` do. This runs
 * on every `claimTask` call, so a store that hasn't connected yet must fail
 * OPEN here — `claimTaskImpl`'s own `requireDb()` (TaskModel) is what
 * actually gates claims when the DB is genuinely down.
 */
export async function getFleetMaintenanceStatus(tenantId: string): Promise<FleetMaintenanceStatus> {
  if (!isConnected() || !FleetMaintenanceModel) return { active: false };
  const doc = (await scopedFindOne(FleetMaintenanceModel, tenantId, {})) as IFleetMaintenance | null;
  if (doc?.active && doc.resumeAt && doc.resumeAt.getTime() <= Date.now()) {
    log.info({ resumeAt: doc.resumeAt }, 'Fleet maintenance window elapsed — auto-resuming');
    return exitFleetMaintenance(tenantId);
  }
  return toStatus(doc);
}

/** Gate helper for `claimTask` — true when the fleet-wide switch should block claims. */
export async function isFleetPaused(tenantId: string): Promise<boolean> {
  const status = await getFleetMaintenanceStatus(tenantId);
  return status.active;
}
