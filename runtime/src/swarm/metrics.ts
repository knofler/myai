/**
 * Swarm metrics (SWARM_MESSAGING plan, P5 — §5 "metrics: parallelism, lead time,
 * cost per swarm").
 *
 * Pure functions over the swarm's child tasks. No DB / gateway dependency: P3
 * (the /swarm dashboard) and any reporting caller pass in the child task rows
 * (fetched by swarmId once P2 tags tasks with `swarmId`) and get back one
 * {@link SwarmMetrics} record. Kept side-effect-free so the numbers are
 * deterministic and unit-testable with fixtures.
 *
 *   parallelism — the MAX number of children whose execution windows overlapped
 *                 at any instant (sweep line over [startedAt, endedAt]). This is
 *                 the *observed* concurrency, which ADR-011's 2 lease slots bound
 *                 from above (§6.1 Q1): 5 ready children still ran ≤2 at a time.
 *   lead time   — wall clock from the earliest child createdAt to the latest
 *                 completedAt (null while nothing has finished).
 *   cost        — summed tokens + USD across children, plus a per-child mean.
 */

/** A child task row, as P2 will store it (only the fields metrics needs). */
export interface SwarmTaskLike {
  taskId: string;
  status: string;
  swarmId?: string;
  createdAt: Date | string | number;
  startedAt?: Date | string | number | null;
  completedAt?: Date | string | number | null;
  tokensUsed?: number;
  costUsd?: number;
}

export interface SwarmMetrics {
  swarmId: string;
  childCount: number;
  completed: number;
  failed: number;
  /** Non-terminal children (pending / paused / in-progress). */
  open: number;
  /** Max observed concurrent executions (see module note). */
  parallelism: number;
  /** ms from earliest createdAt to latest completedAt; null if none completed. */
  leadTimeMs: number | null;
  totalTokens: number;
  totalCostUsd: number;
  /** totalCostUsd / childCount (0 when no children). */
  costPerChildUsd: number;
}

const TERMINAL_DONE = new Set(['done', 'completed', 'complete']);
const TERMINAL_FAILED = new Set(['failed', 'cancelled', 'canceled']);

function toMs(v: Date | string | number | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
  return Number.isFinite(t) ? t : null;
}

function toNum(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Max number of overlapping execution intervals — classic sweep line. A child
 * contributes an interval [start, end] where start = startedAt (fallback
 * createdAt) and end = completedAt (fallback `now` for still-running children).
 * Children with no usable start are ignored. Touching intervals that only share
 * an endpoint (one ends exactly as the next starts) do NOT count as overlapping.
 */
export function maxConcurrency(tasks: readonly SwarmTaskLike[], now: number = Date.now()): number {
  type Ev = { t: number; delta: number };
  const events: Ev[] = [];
  for (const task of tasks ?? []) {
    const start = toMs(task.startedAt) ?? toMs(task.createdAt);
    if (start === null) continue;
    let end = toMs(task.completedAt);
    if (end === null) end = now; // still running
    if (end < start) end = start; // guard against clock skew / bad rows
    events.push({ t: start, delta: 1 });
    events.push({ t: end, delta: -1 });
  }
  // Sort by time; at a tie, process ends (-1) before starts (+1) so an interval
  // that ends exactly when another starts does not count as an overlap.
  events.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));

  let cur = 0;
  let peak = 0;
  for (const ev of events) {
    cur += ev.delta;
    if (cur > peak) peak = cur;
  }
  return peak;
}

/** Compute the full metric record for one swarm's children. */
export function computeSwarmMetrics(
  swarmId: string,
  tasks: readonly SwarmTaskLike[],
  now: number = Date.now(),
): SwarmMetrics {
  const children = (tasks ?? []).filter((t) => t && typeof t.taskId === 'string' && t.taskId.trim().length > 0);
  const childCount = children.length;

  let completed = 0;
  let failed = 0;
  let totalTokens = 0;
  let totalCostUsd = 0;
  let earliestCreated: number | null = null;
  let latestCompleted: number | null = null;

  for (const child of children) {
    const status = typeof child.status === 'string' ? child.status.trim().toLowerCase() : '';
    if (TERMINAL_DONE.has(status)) completed += 1;
    else if (TERMINAL_FAILED.has(status)) failed += 1;

    totalTokens += toNum(child.tokensUsed);
    totalCostUsd += toNum(child.costUsd);

    const created = toMs(child.createdAt);
    if (created !== null && (earliestCreated === null || created < earliestCreated)) earliestCreated = created;

    const done = toMs(child.completedAt);
    if (done !== null && (latestCompleted === null || done > latestCompleted)) latestCompleted = done;
  }

  const open = childCount - completed - failed;
  const leadTimeMs =
    earliestCreated !== null && latestCompleted !== null && latestCompleted >= earliestCreated
      ? latestCompleted - earliestCreated
      : null;

  return {
    swarmId,
    childCount,
    completed,
    failed,
    open: open > 0 ? open : 0,
    parallelism: maxConcurrency(children, now),
    leadTimeMs,
    totalTokens,
    totalCostUsd: round4(totalCostUsd),
    costPerChildUsd: childCount > 0 ? round4(totalCostUsd / childCount) : 0,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
