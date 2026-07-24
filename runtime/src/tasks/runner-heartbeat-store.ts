/**
 * Runner-heartbeat store — liveness alerting, distinct from the runner-lease
 * heartbeat (runner-lease-store.ts).
 *
 * The lease heartbeat only exists while a runner HOLDS a concurrency slot
 * (mid-session); it says nothing about whether the off-hours runner process is
 * alive between fires — an operator staring at an empty queue can't tell "no
 * work to do" from "the launchd job silently died". This store gives every
 * fire (whether or not it claims a task) a cheap, always-updated per-machine
 * pulse, so liveness ("last heartbeat N minutes ago") can be checked
 * independent of task activity.
 */
import { RunnerHeartbeatModel, isConnected } from '../shared/db.js';
import type { IRunnerHeartbeat } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOneAndUpdate } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'runner-heartbeat-store' });

/** Runner cadence is 10 min (launchd StartInterval); 3x + margin before crying wolf. */
export const DEFAULT_LIVENESS_THRESHOLD_MINUTES = 25;

export interface RecordHeartbeatInput {
  /** Hostname the runner fired on, e.g. "runner-host". */
  machine: string;
  /** Runner identity for this fire, e.g. "runner-host/12345". */
  holder: string;
}

export interface RunnerHeartbeatView {
  machine: string;
  holder: string;
  lastHeartbeatAt: Date;
  /** Minutes since lastHeartbeatAt, for display. */
  minutesSince: number;
  /** lastHeartbeatAt older than the liveness threshold. */
  down: boolean;
}

export interface RunnerLivenessResult {
  thresholdMinutes: number;
  /** True when at least one machine has heartbeated within the threshold. */
  alive: boolean;
  /** Most recent heartbeat across all machines, or null if none recorded. */
  lastHeartbeatAt: Date | null;
  lastMachine: string | null;
  machines: RunnerHeartbeatView[];
}

function requireDb(): void {
  if (!isConnected() || !RunnerHeartbeatModel) {
    throw new Error('MongoDB not connected — runner heartbeats unavailable');
  }
}

function toView(doc: IRunnerHeartbeat, now: Date, thresholdMs: number): RunnerHeartbeatView {
  const ageMs = now.getTime() - doc.lastHeartbeatAt.getTime();
  return {
    machine: doc.machine,
    holder: doc.holder,
    lastHeartbeatAt: doc.lastHeartbeatAt,
    minutesSince: Math.floor(ageMs / 60_000),
    down: ageMs > thresholdMs,
  };
}

/**
 * Record one liveness pulse for a machine. Called once per runner fire
 * (before task pickup), regardless of whether a task gets claimed — so the
 * pulse tracks "the process is alive", not "there was work".
 */
export async function recordHeartbeat(
  tenantId: string,
  input: RecordHeartbeatInput,
): Promise<{ ok: true; lastHeartbeatAt: Date }> {
  requireDb();
  const now = new Date();
  const doc = await scopedFindOneAndUpdate(
    RunnerHeartbeatModel, tenantId,
    { machine: input.machine },
    { $set: { holder: input.holder, lastHeartbeatAt: now } },
    { upsert: true, new: true },
  ) as IRunnerHeartbeat;
  log.debug({ machine: input.machine, holder: input.holder }, 'Runner heartbeat recorded');
  return { ok: true, lastHeartbeatAt: doc.lastHeartbeatAt };
}

/**
 * Fleet-wide liveness read: per-machine last-heartbeat + a "down" flag once
 * that pulse is older than thresholdMinutes, plus an overall `alive` (true iff
 * ANY machine is within threshold — the fleet needs only one live runner).
 */
export async function getRunnerLiveness(
  tenantId: string,
  opts: { thresholdMinutes?: number } = {},
): Promise<RunnerLivenessResult> {
  requireDb();
  const thresholdMinutes = opts.thresholdMinutes ?? DEFAULT_LIVENESS_THRESHOLD_MINUTES;
  const thresholdMs = thresholdMinutes * 60_000;
  const now = new Date();
  const docs = await scopedFind(RunnerHeartbeatModel, tenantId, {}).sort({ lastHeartbeatAt: -1 }).exec() as IRunnerHeartbeat[];
  const machines = docs.map(d => toView(d, now, thresholdMs));

  if (machines.length === 0) {
    return { thresholdMinutes, alive: false, lastHeartbeatAt: null, lastMachine: null, machines: [] };
  }
  const latest = machines[0];
  return {
    thresholdMinutes,
    alive: !latest.down,
    lastHeartbeatAt: latest.lastHeartbeatAt,
    lastMachine: latest.machine,
    machines,
  };
}
