/**
 * task-noop-dispatch-alerter — per-task consecutive no-op (docs/state-only)
 * dispatch counter.
 *
 * Incident: a task fired the runner repeatedly and every single dispatch
 * produced only a docs/state commit (e.g. "still resolved — Nth re-dispatch")
 * — never a real code change, never a terminal close. Six fires produced six
 * clean-looking successes; the loop was found only because a human read
 * `git log`. monitoring/task-defer-alerter.ts's deferCount only tracks
 * routing failure — a task that routes and "completes" every single time is
 * invisible to it.
 *
 * Mirrors task-defer-alerter.ts's shape: env-configurable threshold, a pure
 * evaluate function for unit-testing without I/O, and an in-process counter
 * keyed by tenantId|taskId (same live-operational-alerter stance, not a
 * store). Differs in dispatch: the defer-alerter throttles re-alerts
 * (repeatEvery) because it pushes to Telegram/notify-bus on every crossing;
 * this counter is read by the runner's own per-fire log line and by the boot
 * SCHEDULE banner's live count, so there is no repeat-alert to throttle —
 * every fire past the threshold is worth its own WARN line in that fire's log.
 *
 * Caller: task-store.ts's updateTaskImpl calls recordNoopDispatch() when a
 * review-flip update carries `noopDispatch: true` (the runner determined the
 * commits it just pushed touched only docs/state paths), and
 * clearNoopDispatchCount() when a flip carries `noopDispatch: false` (this
 * fire's commits touched real code — the streak breaks).
 */
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'task-noop-dispatch-alerter' });

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export interface NoopDispatchAlertConfig {
  /** Consecutive docs/state-only fires before the WARN fires (default 3 — "fired >2 times in a row"). */
  threshold: number;
}

/** Read the threshold from env at call time so tests (and a gateway restart) pick up changes. */
export function noopDispatchAlertConfig(): NoopDispatchAlertConfig {
  return { threshold: envNum('TASK_NOOP_DISPATCH_ALERT_THRESHOLD', 3) };
}

/** Pure — unit-testable without touching the in-process counter map. */
export function evaluateNoopDispatchBreach(count: number, cfg: NoopDispatchAlertConfig): boolean {
  return count >= cfg.threshold;
}

// ── In-process consecutive-noop-dispatch counters ─────────────

interface NoopState {
  count: number;
}

/** key: `${tenantId}|${taskId}` → consecutive-noop-dispatch state. */
const noopCounts = new Map<string, NoopState>();

function keyFor(tenantId: string, taskId: string): string {
  return `${tenantId}|${taskId}`;
}

/** Reset a task's consecutive-noop-dispatch streak — call when a fire lands a real code change. */
export function clearNoopDispatchCount(input: { taskId: string; tenantId: string }): void {
  noopCounts.delete(keyFor(input.tenantId, input.taskId));
}

/** Clear all tracked counters (test helper / manual reset). */
export function clearAllNoopDispatchCounts(): void {
  noopCounts.clear();
}

/** Current consecutive-noop-dispatch count for a task (0 if untracked). */
export function getNoopDispatchCount(input: { taskId: string; tenantId: string }): number {
  return noopCounts.get(keyFor(input.tenantId, input.taskId))?.count ?? 0;
}

export interface RecordNoopDispatchResult {
  count: number;
  /** True once `count` has crossed (or is past) the configured threshold. */
  warn: boolean;
}

export interface NoopDispatchInput {
  taskId: string;
  tenantId: string;
  repo: string;
}

/**
 * Record one docs/state-only dispatch for a task. Returns the new
 * consecutive count and whether it is past the WARN threshold — the caller
 * (task-store.ts) mirrors the count onto the task doc so it's queryable (the
 * boot SCHEDULE banner reads it from there), and logs its own WARN line here
 * for the runner's log stream.
 *
 * Never throws — a missed warning must not affect the caller's review-flip,
 * same "best-effort" stance as recordTaskDefer.
 */
export function recordNoopDispatch(input: NoopDispatchInput): RecordNoopDispatchResult {
  try {
    const key = keyFor(input.tenantId, input.taskId);
    const cfg = noopDispatchAlertConfig();
    const prev = noopCounts.get(key);
    const count = (prev?.count ?? 0) + 1;
    noopCounts.set(key, { count });

    const warn = evaluateNoopDispatchBreach(count, cfg);
    if (warn) {
      log.warn(
        { taskId: input.taskId, repo: input.repo, count },
        'Task fired repeatedly with docs/state-only commits — no real code change landed',
      );
    }
    return { count, warn };
  } catch (err) {
    log.warn({ err, taskId: input.taskId }, 'recordNoopDispatch failed (suppressed)');
    return { count: getNoopDispatchCount({ taskId: input.taskId, tenantId: input.tenantId }), warn: false };
  }
}
