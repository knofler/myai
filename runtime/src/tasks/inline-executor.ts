/**
 * In-gateway inline execution path (MYAI_GATEWAY ph6 — lightweight lane).
 *
 * Closes the gap between the two heavy task-execution paths that exist today:
 *
 *   1. CLI runner (`cli_task_runner.sh` + launchd) — fires a full headless
 *      Claude CLI session per task. Correct when a task needs arbitrary
 *      reasoning + file edits + git, but ~minutes of wall-clock and real LLM
 *      spend even for a one-liner.
 *   2. `dispatch_cycle` — calls `agents_invoke` (in-gateway LLM) to produce an
 *      analysis. Still spends LLM budget; produces text only, not an effect.
 *
 * Many queued tasks are neither: they are **short deterministic operations**
 * that map 1:1 onto an existing whitelisted gateway MCP tool (reprioritize the
 * queue, run a health check, reindex memory, seed schedules). Firing a whole
 * CLI session — or even one LLM call — to run `repos_priority` is absurd
 * overkill. This module executes those tasks **in-process, with no LLM call and
 * no CLI fire**.
 *
 * Two independent safety gates, both DEFENSIVE (default = existing behaviour):
 *  - **Feature flag** — `config.agentRuntime.inlineEnabled` (env
 *    `INLINE_EXEC_ENABLED`, default OFF). When off, every task is ineligible and
 *    falls through to the CLI runner / dispatch worker unchanged.
 *  - **Quota** — an in-process rolling-window counter caps inline executions per
 *    window (env `INLINE_EXEC_QUOTA` / `INLINE_EXEC_WINDOW_SEC`). A flood of
 *    inline tasks (or a runaway) can never hammer the gateway hot path.
 *
 * Eligibility is CONSERVATIVE and OPT-IN per task: a task is only inline-eligible
 * if it carries an explicit `[inline:<op>]` marker naming a whitelisted operation.
 * Nothing is inferred by an LLM; the whitelist is the security boundary (no
 * arbitrary tool execution, no git, no shell).
 */

import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { listTasks, updateTask, type TaskView } from './task-store.js';
import { recordUsage, usageEventId } from '../shared/usage-store.js';

const log = createChildLogger({ module: 'inline-executor' });

// ── Whitelisted operations ──────────────────────────────────
//
// The ONLY tools the inline path may invoke. Each entry is a deterministic,
// side-effect-bounded gateway operation that spends no LLM budget. Adding a new
// op is a deliberate, reviewed act — never widen this to a pass-through of an
// arbitrary tool name from task content.

export interface InlineOperation {
  /** The MCP tool this op invokes via the injected executor. */
  tool: string;
  /** Human-readable summary — surfaced in the task result note. */
  summary: string;
}

export const INLINE_OPERATIONS: Readonly<Record<string, InlineOperation>> = Object.freeze({
  reprioritize:    { tool: 'repos_priority',  summary: 'Recompute repo/task priority ordering' },
  health:          { tool: 'health_status',   summary: 'Run gateway health check' },
  reindex:         { tool: 'memory_reindex',  summary: 'Reindex the semantic memory corpus' },
  'seed-schedules':{ tool: 'schedules_seed',  summary: 'Ensure default schedules exist' },
  'usage-summary': { tool: 'usage_summary',   summary: 'Summarize product-usage events' },
  'repo-status':   { tool: 'repos_status',    summary: 'Report git status for a repo' },
});

export type InlineOpKey = keyof typeof INLINE_OPERATIONS;

// ── Marker parsing ──────────────────────────────────────────

/**
 * Recognizes an inline directive of the form `[inline:<op>]` or
 * `[inline:<op> {"json":"args"}]` at any position in the supplied text.
 * The op must be a known whitelist key or the marker is rejected.
 */
const INLINE_MARKER = /\[inline:([a-z0-9-]+)(?:\s+(\{.*?\}))?\]/i;

export interface InlineDirective {
  op: InlineOpKey;
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Extract an inline directive from a task's title/notes. Returns null when no
 * marker is present or the op is not whitelisted. Malformed JSON args degrade to
 * empty args (the tool applies its own defaults) rather than rejecting the task.
 */
export function parseInlineDirective(task: Pick<TaskView, 'title' | 'notes'>): InlineDirective | null {
  const haystack = `${task.title ?? ''}\n${task.notes ?? ''}`;
  const m = INLINE_MARKER.exec(haystack);
  if (!m) return null;

  const op = m[1].toLowerCase();
  const spec = (INLINE_OPERATIONS as Record<string, InlineOperation>)[op];
  if (!spec) {
    log.warn({ op }, 'Inline marker names an unknown operation — not eligible');
    return null;
  }

  let args: Record<string, unknown> = {};
  if (m[2]) {
    try {
      const parsed = JSON.parse(m[2]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      }
    } catch {
      log.warn({ op, raw: m[2] }, 'Inline marker args are not valid JSON — using empty args');
    }
  }

  return { op: op as InlineOpKey, tool: spec.tool, args };
}

// ── Quota gate (in-process rolling window) ──────────────────

interface QuotaState {
  /** Epoch-ms timestamps of inline executions inside the current window. */
  hits: number[];
}

const quota: QuotaState = { hits: [] };

/** Resolve the quota config (feature flag + limit + window) from GatewayConfig. */
function inlineConfig(): { enabled: boolean; quota: number; windowMs: number } {
  const rt = getConfig().agentRuntime;
  return {
    enabled: !!rt?.inlineEnabled,
    quota: rt?.inlineQuotaPerWindow ?? 20,
    windowMs: (rt?.inlineWindowSeconds ?? 3600) * 1000,
  };
}

/** Prune expired hits so the window reflects only the last `windowMs`. */
function pruneQuota(nowMs: number, windowMs: number): void {
  const cutoff = nowMs - windowMs;
  if (quota.hits.length && quota.hits[0] < cutoff) {
    quota.hits = quota.hits.filter((t) => t >= cutoff);
  }
}

/** Current count of inline executions inside the rolling window. */
export function inlineQuotaUsage(nowMs: number = Date.now()): { used: number; limit: number; windowMs: number } {
  const cfg = inlineConfig();
  pruneQuota(nowMs, cfg.windowMs);
  return { used: quota.hits.length, limit: cfg.quota, windowMs: cfg.windowMs };
}

/** Test/ops hook: clear the rolling-window counter. */
export function resetInlineQuota(): void {
  quota.hits = [];
}

// ── Classification ──────────────────────────────────────────

export type IneligibleReason =
  | 'disabled'          // feature flag off
  | 'no-marker'         // task carries no recognized inline directive
  | 'quota-exceeded';   // rolling-window limit hit

export type Classification =
  | { eligible: true; directive: InlineDirective }
  | { eligible: false; reason: IneligibleReason };

/**
 * Decide whether a task may run on the inline path RIGHT NOW. Pure and
 * side-effect free (does not consume quota) so it is safe to call speculatively
 * — the CLI runner / dispatch worker can ask "should I skip this?" without
 * burning a slot. `runInlineTask` re-checks + consumes atomically.
 */
export function classifyTask(task: Pick<TaskView, 'title' | 'notes'>, nowMs: number = Date.now()): Classification {
  const cfg = inlineConfig();
  if (!cfg.enabled) return { eligible: false, reason: 'disabled' };

  const directive = parseInlineDirective(task);
  if (!directive) return { eligible: false, reason: 'no-marker' };

  pruneQuota(nowMs, cfg.windowMs);
  if (quota.hits.length >= cfg.quota) return { eligible: false, reason: 'quota-exceeded' };

  return { eligible: true, directive };
}

// ── Execution ───────────────────────────────────────────────

/** Injected tool executor — kept as a param to avoid a circular import on tools.ts. */
export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface InlineResult {
  taskId: string;
  op: string;
  tool: string;
  status: 'done' | 'blocked' | 'skipped';
  reason?: IneligibleReason | string;
  durationMs: number;
}

/**
 * Execute one inline-eligible task in-process. Re-classifies (guards against a
 * stale caller-side decision), consumes exactly one quota slot on success,
 * invokes the whitelisted tool, then marks the task done (or blocked on error)
 * and records a `task.executed` usage event tagged with the inline lane.
 *
 * Never throws — a tool failure blocks the task and returns a `blocked` result.
 */
export async function runInlineTask(
  tenantId: string,
  task: TaskView,
  exec: ToolExecutor,
  nowMs: number = Date.now(),
): Promise<InlineResult> {
  const start = nowMs;
  const decision = classifyTask(task, nowMs);
  if (!decision.eligible) {
    return { taskId: task.taskId, op: '-', tool: '-', status: 'skipped', reason: decision.reason, durationMs: 0 };
  }

  const { op, tool, args } = decision.directive;

  // Consume a quota slot at the moment we commit to running.
  quota.hits.push(nowMs);

  // Mark the task working so the dashboard reflects the inline pickup.
  await updateTask(tenantId, { taskId: task.taskId, status: 'working', assignedAgent: 'gateway-inline' }).catch(() => {});

  try {
    const output = await exec(tool, { ...args, repo: args.repo ?? task.repo });
    const durationMs = Date.now() - start;

    const note = `[inline:${op}] ${INLINE_OPERATIONS[op].summary} — done in ${durationMs}ms`;
    await updateTask(tenantId, { taskId: task.taskId, status: 'done', notes: note }).catch(() => {});

    // Product meter: an inline execution is still a completed task, tagged so
    // billing/analytics can tell the cheap lane from a runner/agent execution.
    await recordUsage(tenantId, {
      eventId: usageEventId('task.executed', task.taskId),
      type: 'task.executed',
      source: 'gateway',
      repo: task.repo,
      taskId: task.taskId,
      metadata: { lane: 'inline', op, tool, durationMs },
    });

    log.info({ taskId: task.taskId, op, tool, durationMs }, 'Inline task executed');
    return { taskId: task.taskId, op, tool, status: 'done', durationMs };
  } catch (err) {
    const durationMs = Date.now() - start;
    const message = err instanceof Error ? err.message : String(err);
    await updateTask(tenantId, {
      taskId: task.taskId,
      status: 'blocked',
      notes: `[inline:${op}] failed: ${message}`,
    }).catch(() => {});
    log.warn({ taskId: task.taskId, op, tool, err: message }, 'Inline task failed — blocked');
    return { taskId: task.taskId, op, tool, status: 'blocked', reason: message, durationMs };
  }
}

// ── Cycle ───────────────────────────────────────────────────

export interface InlineCycleConfig {
  /** Cap tasks processed this cycle (also bounded by remaining quota). Default 10. */
  maxTasks?: number;
  /** Restrict to one repo (optional). */
  repo?: string;
}

export interface InlineCycleResult {
  enabled: boolean;
  processed: number;
  done: number;
  blocked: number;
  scanned: number;
  quota: { used: number; limit: number };
  details: InlineResult[];
}

/**
 * Scan pending tasks and run the inline-eligible ones in-process. Returns
 * immediately (no work) when the feature flag is off, so a scheduled call is a
 * cheap no-op until an operator opts in. Ineligible tasks are left untouched for
 * the CLI runner / dispatch worker to pick up.
 */
export async function runInlineCycle(
  tenantId: string,
  exec: ToolExecutor,
  config: InlineCycleConfig = {},
): Promise<InlineCycleResult> {
  const cfg = inlineConfig();
  const result: InlineCycleResult = {
    enabled: cfg.enabled,
    processed: 0,
    done: 0,
    blocked: 0,
    scanned: 0,
    quota: { used: 0, limit: cfg.quota },
    details: [],
  };

  if (!cfg.enabled) {
    log.debug('Inline execution disabled — cycle is a no-op');
    return result;
  }

  const maxTasks = Math.min(Math.max(1, config.maxTasks ?? 10), 50);
  const pending = await listTasks(tenantId, { status: 'pending', repo: config.repo, limit: 100 });
  result.scanned = pending.length;

  for (const task of pending) {
    if (result.processed >= maxTasks) break;
    const nowMs = Date.now();
    const decision = classifyTask(task, nowMs);
    if (!decision.eligible) {
      // Stop early only when quota is the blocker — no point scanning further.
      if (decision.reason === 'quota-exceeded') {
        log.info({ tenantId }, 'Inline quota exhausted — ending cycle');
        break;
      }
      continue;
    }

    const r = await runInlineTask(tenantId, task, exec, nowMs);
    result.processed++;
    result.details.push(r);
    if (r.status === 'done') result.done++;
    else if (r.status === 'blocked') result.blocked++;
  }

  result.quota = { used: inlineQuotaUsage().used, limit: cfg.quota };
  log.info({ processed: result.processed, done: result.done, blocked: result.blocked }, 'Inline cycle complete');
  return result;
}
