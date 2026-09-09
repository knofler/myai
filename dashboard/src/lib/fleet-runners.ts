// Fleet runner registry — per-machine visibility across the shared
// `myai-local` pool (task-c0a03fcc). Two runners can now be registered across
// two Macs, each firing independently via launchd; nothing surfaced WHICH
// machines are in the pool or whether each is still alive. This module joins
// the three signals the gateway already tracks per machine —
//   1. RunnerHeartbeat  — "the runner process fired" pulse (heartbeat-store.ts)
//   2. RunnerLease      — a currently-held concurrency slot (lease-store.ts)
//   3. RunnerLeaseHistory — the most recently released slot (runs log)
// — into one row per registered runner: name/host, online/busy, last job,
// last-seen. A machine that stops heartbeating stays in the list (sourced
// from the union of all three signals) with online:false, so it reads as
// visibly stale rather than silently disappearing.
//
// Pure aggregation only, DB-free (see lib/fleet-overview.ts for the same
// split) — getFleetRunners() below is the thin Mongo-fetching wrapper.

import { DEFAULT_LIVENESS_THRESHOLD_MINUTES } from './runner-health';

export interface FleetHeartbeatLike {
  machine: string;
  holder: string;
  lastHeartbeatAt: string | Date;
}

export interface FleetLeaseLike {
  holder: string;
  machine?: string;
  taskId?: string;
  acquiredAt: string | Date;
  leaseUntil: string | Date;
}

export interface FleetLeaseHistoryLike {
  holder: string;
  machine?: string;
  taskId?: string;
  releasedAt: string | Date;
}

export interface FleetTaskLabelLike {
  taskId: string;
  repo?: string;
  title?: string;
}

export interface FleetRunnerRow {
  /** Registered runner identity — the Mac's hostname (RUNNER_MACHINE). */
  machine: string;
  /** Most recent per-fire process identity seen for this machine, e.g. "mac-a/4821". */
  holder: string | null;
  lastHeartbeatAt: string | null;
  minutesSinceHeartbeat: number | null;
  /** Heartbeat within the liveness threshold. */
  online: boolean;
  /** Holds a currently non-expired concurrency lease. */
  busy: boolean;
  currentTaskId: string | null;
  currentTaskLabel: string | null;
  /** The task most recently worked — the current one if busy, else the last released. */
  lastJobTaskId: string | null;
  lastJobLabel: string | null;
  lastJobAt: string | null;
}

function toMs(d: string | Date): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

function toIso(d: string | Date | undefined | null): string | null {
  if (!d) return null;
  const ms = toMs(d);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function labelFor(taskId: string | null | undefined, tasksById: Map<string, FleetTaskLabelLike>): string | null {
  if (!taskId) return null;
  const t = tasksById.get(taskId);
  if (!t) return taskId;
  const parts = [t.repo, t.title].filter(Boolean);
  return parts.length > 0 ? parts.join(': ') : taskId;
}

/**
 * Join heartbeat + lease + lease-history rows into one per-machine fleet
 * view. The registered-runner set is the UNION of every machine any of the
 * three signals has ever named — a machine can appear via a live lease even
 * if its heartbeat write raced behind, and must never be dropped just
 * because one signal is momentarily missing it.
 */
export function buildFleetRunners(
  heartbeats: FleetHeartbeatLike[],
  leases: FleetLeaseLike[],
  leaseHistory: FleetLeaseHistoryLike[],
  tasks: FleetTaskLabelLike[],
  opts: { now?: Date; thresholdMinutes?: number } = {},
): FleetRunnerRow[] {
  const now = opts.now ?? new Date();
  const thresholdMs = (opts.thresholdMinutes ?? DEFAULT_LIVENESS_THRESHOLD_MINUTES) * 60_000;
  const tasksById = new Map(tasks.map(t => [t.taskId, t]));

  const heartbeatByMachine = new Map<string, FleetHeartbeatLike>();
  for (const hb of heartbeats) heartbeatByMachine.set(hb.machine, hb);

  const machines = new Set<string>();
  for (const hb of heartbeats) machines.add(hb.machine);
  for (const l of leases) if (l.machine) machines.add(l.machine);
  for (const h of leaseHistory) if (h.machine) machines.add(h.machine);

  const rows: FleetRunnerRow[] = [];
  for (const machine of machines) {
    const hb = heartbeatByMachine.get(machine);
    const lastHeartbeatAt = hb ? toIso(hb.lastHeartbeatAt) : null;
    const minutesSinceHeartbeat = lastHeartbeatAt
      ? Math.floor((now.getTime() - new Date(lastHeartbeatAt).getTime()) / 60_000)
      : null;
    const online = lastHeartbeatAt !== null && (now.getTime() - new Date(lastHeartbeatAt).getTime()) <= thresholdMs;

    const activeLease = leases
      .filter(l => l.machine === machine && toMs(l.leaseUntil) > now.getTime())
      .sort((a, b) => toMs(b.acquiredAt) - toMs(a.acquiredAt))[0] ?? null;
    const busy = activeLease !== null;
    const currentTaskId = activeLease?.taskId ?? null;

    const lastHistory = leaseHistory
      .filter(h => h.machine === machine)
      .sort((a, b) => toMs(b.releasedAt) - toMs(a.releasedAt))[0] ?? null;

    const lastJobTaskId = busy ? currentTaskId : (lastHistory?.taskId ?? null);
    const lastJobAt = busy ? toIso(activeLease?.acquiredAt) : toIso(lastHistory?.releasedAt);
    const holder = hb?.holder ?? activeLease?.holder ?? lastHistory?.holder ?? null;

    rows.push({
      machine,
      holder,
      lastHeartbeatAt,
      minutesSinceHeartbeat,
      online,
      busy,
      currentTaskId,
      currentTaskLabel: labelFor(currentTaskId, tasksById),
      lastJobTaskId,
      lastJobLabel: labelFor(lastJobTaskId, tasksById),
      lastJobAt,
    });
  }

  // Online first, then most-recently-seen — a stale runner sinks to the
  // bottom instead of vanishing, per the "visibly stale, not absent" acceptance bar.
  rows.sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    const at = a.lastHeartbeatAt ? new Date(a.lastHeartbeatAt).getTime() : -Infinity;
    const bt = b.lastHeartbeatAt ? new Date(b.lastHeartbeatAt).getTime() : -Infinity;
    if (at !== bt) return bt - at;
    return a.machine.localeCompare(b.machine);
  });
  return rows;
}
