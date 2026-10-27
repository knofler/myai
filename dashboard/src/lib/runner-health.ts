// Reader for the CLI task-runner health artifact.
//
// scripts/runner_health.sh (host-side) parses ~/.ai-cli-runner/runner.out into
// state/runner-health.<host>.json inside the repo (per-host by name — every
// Mac writes its own file, task-1eba9e51). The dashboard container mounts the
// repo read-only at AI_ROOT, so we read the artifacts straight off the
// filesystem — the same pattern as lib/docs.ts. runner.out lives outside the
// repo and is not mounted, so these artifacts are the only bridge to the
// runner-fire signal.

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

// ── Claims-vs-executions churn ratio (task-d85ea318) ────────────────────────
// The "runner churn" incident: 14,746 tasks carried a claimedAt inside a 30-day
// window but only 595 ever routed/executed (a 24:1 ratio) — a post-claim pacing/
// routing gate was claiming the head-of-queue task atomically, then releasing it
// straight back to pending before it ever stamped routedProfile/routedModel, so
// the SAME task was re-claimed on the next fire. Each wasted claim is a gateway
// round trip + log noise and can hide genuine starvation. This surfaces the same
// ratio the Atlas evidence was gathered with (claimedAt in-window vs those
// carrying a routed stamp) directly on the runner_health report, so the churn is
// visible instead of only findable with an ad-hoc query.

export interface ClaimExecutionRatio {
  windowDays: number;
  /** Tasks whose (last) claimedAt falls inside the window — one per distinct doc. */
  claims: number;
  /** Of those, how many actually routed (carry a routedProfile/routedModel). */
  executions: number;
  /** claims − executions: claimed but never routed — the churn. */
  churnedClaims: number;
  /** Of the churned, how many are attributed to a counted pacing-defer release
   *  (pacingDeferCount > 0) — the share this fix makes self-explaining. */
  pacingDeferredClaims: number;
  /** claims / max(executions, 1), rounded to 1 decimal. 24.8 ⇒ "24.8:1". */
  ratio: number;
}

export interface ClaimExecStamp {
  claimedAt?: Date | string | null;
  routedModel?: string | null;
  routedProfile?: string | null;
  pacingDeferCount?: number | null;
}

/**
 * Pure churn computation — reproduces the Atlas-evidence methodology exactly:
 * count docs whose claimedAt is inside the window (claims), of which the ones
 * carrying a routed stamp are executions. Kept pure (no DB) so it is hermetically
 * testable; getClaimExecutionRatio() is the thin DB wrapper.
 */
export function computeClaimExecutionRatio(
  stamps: ClaimExecStamp[],
  opts: { now?: Date; windowDays?: number } = {},
): ClaimExecutionRatio {
  const windowDays = opts.windowDays ?? 30;
  const now = opts.now ?? new Date();
  const cutoff = now.getTime() - windowDays * 86_400_000;
  let claims = 0;
  let executions = 0;
  let pacingDeferredClaims = 0;
  for (const s of stamps) {
    const t = s.claimedAt ? new Date(s.claimedAt).getTime() : NaN;
    if (!Number.isFinite(t) || t < cutoff) continue;
    claims++;
    const routed =
      String(s.routedModel ?? '').trim() !== '' || String(s.routedProfile ?? '').trim() !== '';
    if (routed) {
      executions++;
    } else if ((s.pacingDeferCount ?? 0) > 0) {
      pacingDeferredClaims++;
    }
  }
  const churnedClaims = claims - executions;
  const ratio = Math.round((claims / Math.max(executions, 1)) * 10) / 10;
  return { windowDays, claims, executions, churnedClaims, pacingDeferredClaims, ratio };
}

/**
 * DB wrapper for computeClaimExecutionRatio: reads the tenant's tasks whose
 * claimedAt falls inside the window (projecting only the four stamp fields — the
 * window keeps the scan bounded) and returns the churn ratio. claimedAt is a
 * single overwritten field, so this counts DISTINCT docs last claimed in-window,
 * which is exactly what the "claimedAt in last 30d = N docs" evidence counted.
 */
export async function getClaimExecutionRatio(windowDays = 30): Promise<ClaimExecutionRatio> {
  await connectDB();
  const tenantId = await getActiveTenant();
  const cutoff = new Date(Date.now() - windowDays * 86_400_000);
  const docs = await Task.find(
    { ...tenantFilter(tenantId), claimedAt: { $gte: cutoff } },
    { claimedAt: 1, routedModel: 1, routedProfile: 1, pacingDeferCount: 1 },
  ).lean<ClaimExecStamp[]>();
  return computeClaimExecutionRatio(docs, { windowDays });
}

/**
 * Read the runner-health artifact(s) from AI_ROOT.
 *
 * Per-host by name since task-1eba9e51: every Mac's runner_health.sh writes
 * its own state/runner-health.<host>.json (the legacy shared
 * state/runner-health.json is still read during rollout). With several hosts
 * present, prefer artifacts with available:true (a Mac without a runner.out
 * writes available:false and must not mask a live runner elsewhere), then the
 * freshest generatedAt among those. Returns null when nothing parses.
 */
const RUNNER_HEALTH_FILE_RE = /^runner-health(\.[A-Za-z0-9_.-]+)?\.json$/;

export async function readRunnerHealth(): Promise<RunnerHealth | null> {
  const stateDir = path.resolve(path.join(AI_ROOT, 'state'));
  if (!stateDir.startsWith(path.resolve(AI_ROOT))) return null; // containment guard
  let names: string[];
  try {
    names = await fs.readdir(stateDir);
  } catch {
    return null;
  }
  let best: RunnerHealth | null = null;
  let bestTime = -Infinity;
  for (const name of names) {
    if (!RUNNER_HEALTH_FILE_RE.test(name)) continue;
    const resolved = path.resolve(path.join(stateDir, name));
    if (!resolved.startsWith(stateDir)) continue;
    try {
      const stat = await fs.stat(resolved);
      if (!stat.isFile() || stat.size > 2_000_000) continue;
      const parsed = JSON.parse(await fs.readFile(resolved, 'utf-8')) as RunnerHealth;
      if (!parsed || typeof parsed !== 'object') continue;
      const t = Date.parse(String(parsed.generatedAt ?? ''));
      const time = Number.isNaN(t) ? -Infinity : t;
      const beatsOnAvailability = Boolean(parsed.available) && !best?.available;
      const losesOnAvailability = !parsed.available && Boolean(best?.available);
      if (best === null || beatsOnAvailability || (!losesOnAvailability && time > bestTime)) {
        best = parsed;
        bestTime = time;
      }
    } catch {
      // Skip malformed/racing files; another host's artifact may still parse.
    }
  }
  return best;
}
