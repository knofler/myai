// Reader for the CLI task-runner health artifact.
//
// scripts/runner_health.sh (host-side) parses ~/.ai-cli-runner/runner.out into
// state/runner-health.json inside the repo. The dashboard container mounts the
// repo read-only at AI_ROOT, so we read the artifact straight off the filesystem
// — the same pattern as lib/docs.ts. runner.out lives outside the repo and is
// not mounted, so this artifact is the only bridge to the runner-fire signal.

import { promises as fs } from 'fs';
import path from 'path';
import { AI_ROOT } from './docs';
import { connectDB, RunnerHeartbeat, RunnerLease, RunnerLeaseHistory, Task, FleetMaintenance } from './db';
import { getActiveTenant, tenantFilter } from './tenant';
import { buildFleetRunners, type FleetRunnerRow, type FleetHeartbeatLike, type FleetLeaseLike, type FleetLeaseHistoryLike, type FleetTaskLabelLike } from './fleet-runners';

export type { FleetRunnerRow } from './fleet-runners';

export interface RunnerRepoHealth {
  repo: string;
  lastFireAt: string | null;
  lastOutcome: 'review' | 'blocked' | null;
  lastResult: string | null;
  lastAgent: string | null;
  fires: number;
  zeroWork: number;
  consecutiveZeroWork: number;
  stalled: boolean;
}

export interface RunnerHealth {
  generatedAt: string;
  source: string;
  available: boolean;
  stallThreshold: number;
  global: {
    totalFires: number;
    firesLast24h: number;
    consecutiveZeroWork: number;
    stall: boolean;
    stalledRepo: string | null;
    lastFireAt: string | null;
    lastRepo: string | null;
    lastResult: string | null;
  };
  repos: RunnerRepoHealth[];
}

/** Runner cadence is 10 min (launchd StartInterval); 3x + margin before crying wolf. */
export const DEFAULT_LIVENESS_THRESHOLD_MINUTES = 25;

export interface RunnerLivenessMachine {
  machine: string;
  holder: string;
  lastHeartbeatAt: string;
  minutesSince: number;
  down: boolean;
}

export interface RunnerLiveness {
  thresholdMinutes: number;
  alive: boolean;
  lastHeartbeatAt: string | null;
  lastMachine: string | null;
  machines: RunnerLivenessMachine[];
}

/**
 * Fleet-wide runner liveness from the gateway's runner_heartbeats collection —
 * distinct from readRunnerHealth() above (that's the log-parsed "did work
 * happen" signal). "down" means no machine has heartbeated within the
 * threshold, i.e. the off-hours runner process itself appears dead, not just
 * idle.
 */
export async function getRunnerLiveness(thresholdMinutes = DEFAULT_LIVENESS_THRESHOLD_MINUTES): Promise<RunnerLiveness> {
  await connectDB();
  const tenantId = await getActiveTenant();
  const docs = await RunnerHeartbeat.find(tenantFilter(tenantId)).sort({ lastHeartbeatAt: -1 }).lean<
    Array<{ machine: string; holder: string; lastHeartbeatAt: Date }>
  >();

  const now = Date.now();
  const thresholdMs = thresholdMinutes * 60_000;
  const machines: RunnerLivenessMachine[] = docs.map(d => {
    const ageMs = now - new Date(d.lastHeartbeatAt).getTime();
    return {
      machine: d.machine,
      holder: d.holder,
      lastHeartbeatAt: new Date(d.lastHeartbeatAt).toISOString(),
      minutesSince: Math.floor(ageMs / 60_000),
      down: ageMs > thresholdMs,
    };
  });

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

/**
 * Fleet-wide runner registry: one row per machine that has ever heartbeated,
 * held a lease, or appears in the lease-history runs log for this tenant —
 * joined with its current online/busy status and last job (see
 * lib/fleet-runners.ts for the join logic). Powers the "registered runners"
 * panel so an operator can see every Mac in the `myai-local` pool, not just
 * the single most-recent heartbeat.
 */
export async function getFleetRunners(thresholdMinutes = DEFAULT_LIVENESS_THRESHOLD_MINUTES): Promise<FleetRunnerRow[]> {
  await connectDB();
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const [heartbeats, leases, leaseHistory] = await Promise.all([
    RunnerHeartbeat.find(tf).lean<FleetHeartbeatLike[]>(),
    RunnerLease.find(tf).lean<FleetLeaseLike[]>(),
    RunnerLeaseHistory.find(tf).sort({ releasedAt: -1 }).limit(200).lean<FleetLeaseHistoryLike[]>(),
  ]);

  const taskIds = new Set<string>();
  for (const l of leases) if (l.taskId) taskIds.add(l.taskId);
  for (const h of leaseHistory) if (h.taskId) taskIds.add(h.taskId);

  const tasks = taskIds.size > 0
    ? await Task.find({ ...tf, taskId: { $in: [...taskIds] } }, { taskId: 1, repo: 1, title: 1 }).lean<FleetTaskLabelLike[]>()
    : [];

  return buildFleetRunners(heartbeats, leases, leaseHistory, tasks, { thresholdMinutes });
}

export interface FleetMaintenanceStatus {
  active: boolean;
  reason: string | null;
  operator: string | null;
  enteredAt: string | null;
  resumeAt: string | null;
}

/**
 * Fleet-wide operator kill switch — read-only mirror of the gateway's
 * fleet_maintenance collection (runtime/src/tasks/fleet-maintenance-store.ts).
 * The gateway is the only writer (via fleet_maintenance_enter/exit); this just
 * reads the current doc for the maintenance banner. Note: unlike the gateway's
 * own read path, this does NOT auto-resume a lapsed `resumeAt` — it only ever
 * writes via the MCP tools — so a window whose resumeAt has passed but hasn't
 * been read by the gateway yet still shows as active here. That's fine for a
 * banner (it disappears on the gateway's next claim-time check, at most one
 * runner cycle later); it must never let a stale banner claim the fleet is
 * paused when it verifiably is not.
 */
export async function getFleetMaintenanceStatus(): Promise<FleetMaintenanceStatus> {
  await connectDB();
  const tenantId = await getActiveTenant();
  const doc = await FleetMaintenance.findOne(tenantFilter(tenantId)).lean<{
    active?: boolean; reason?: string; operator?: string; enteredAt?: Date; resumeAt?: Date;
  } | null>();
  if (!doc?.active) {
    return { active: false, reason: null, operator: null, enteredAt: null, resumeAt: null };
  }
  // A resumeAt in the past means the window has lapsed even though the
  // gateway hasn't lazily auto-exited it yet (that only happens on the next
  // claimTask read) — don't tell the operator the fleet is still paused.
  if (doc.resumeAt && new Date(doc.resumeAt).getTime() <= Date.now()) {
    return { active: false, reason: null, operator: null, enteredAt: null, resumeAt: null };
  }
  return {
    active: true,
    reason: doc.reason ?? null,
    operator: doc.operator ?? null,
    enteredAt: doc.enteredAt ? new Date(doc.enteredAt).toISOString() : null,
    resumeAt: doc.resumeAt ? new Date(doc.resumeAt).toISOString() : null,
  };
}

/** Read state/runner-health.json from AI_ROOT. Returns null when absent/malformed. */
export async function readRunnerHealth(): Promise<RunnerHealth | null> {
  const resolved = path.resolve(path.join(AI_ROOT, 'state', 'runner-health.json'));
  if (!resolved.startsWith(path.resolve(AI_ROOT))) return null; // containment guard
  try {
    const stat = await fs.stat(resolved);
    if (!stat.isFile() || stat.size > 2_000_000) return null;
    const raw = await fs.readFile(resolved, 'utf-8');
    return JSON.parse(raw) as RunnerHealth;
  } catch {
    return null;
  }
}
