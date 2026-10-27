/**
 * Worker lane status (task-496862ee) — the /swarm "Workers" panel's backend.
 *
 * Distinct from runner-heartbeat-store.ts's per-MACHINE liveness: this is
 * per-LANE (the Claude runner, Claude Fable, the director-only master
 * profile, Codex, Antigravity, Copilot, local Ollama, and the DeepSeek/Kimi
 * API tiers — Gemini removed, task-5a8c09ca) — which backend actually
 * produced a shipped diff, not which Mac fired. A lane is "connected" when
 * some runner_heartbeat capability
 * tag names it and that heartbeat is fresh, "down" when the tag was seen but
 * has gone stale, and "not-configured" when no heartbeat has ever advertised
 * it — distinguishing "it broke" from "it was never wired up" for an operator
 * scanning the panel.
 *
 * Execution counts come from the router's own audit-trail stamps on Task docs
 * (executionLane/executionProvider/routedModel, db.ts ITask) — real diffs that
 * shipped, not routing *intent* (routedModel/recommendedModel reflect the
 * planned route, which can differ after a fallback). The Claude runner vs
 * fable split on routedModel since both share executionLane:'claude' and
 * (usually) executionProvider:'anthropic'; the director is director-only
 * (interactive remote-control sessions, never runner-claimed queue work) so it
 * never matches a task and always reads 0 executions by design, not as a fault.
 *
 * Lane ids are ROLES, never an operator's profile names (v1 G6): the runner
 * advertises its Claude profile's basename (`claude` / `claude-<name>`), which
 * isClaudeProfileTag accepts whatever the profile is called.
 */
import { RunnerHeartbeatModel, TaskModel, isConnected } from '../shared/db.js';
import { scopedFind } from '../shared/scoped-query.js';
import { DEFAULT_LIVENESS_THRESHOLD_MINUTES } from './runner-heartbeat-store.js';

export { DEFAULT_LIVENESS_THRESHOLD_MINUTES } from './runner-heartbeat-store.js';

export interface TaskExecStamp {
  executionLane?: string;
  executionProvider?: string;
  routedModel?: string;
  completedAt?: Date;
  status?: string;
  updatedAt?: Date;
  reviewEnteredAt?: Date;
}

/**
 * When a task's execution finished. completedAt is only set on done/blocked/
 * dead_letter, but the runner hands its finished work to `review` and the
 * reconciler can hold it there for days (task-bfd09c3d, the first agy run, sat
 * in review uncounted) — so a review task counts at reviewEnteredAt (stamped
 * once on the transition into review, task-store.ts), NOT updatedAt. PR #479
 * used updatedAt here, which the reconciler bumps on every pass it merely
 * touches a review task — re-counting the same execution in executions24h
 * every day it sat there instead of once.
 */
export function executionFinishedAt(t: TaskExecStamp): Date | undefined {
  if (t.completedAt) return t.completedAt;
  if (t.status === 'review' && t.reviewEnteredAt) return t.reviewEnteredAt;
  return undefined;
}

export interface HeartbeatLike {
  machine: string;
  lastHeartbeatAt: Date;
  capabilities?: string[];
}

export type WorkerLaneConnection = 'connected' | 'down' | 'not-configured';

export interface WorkerLaneDef {
  id: string;
  label: string;
  /** runner_heartbeat `capabilities` tags that identify a runner serving this lane. */
  capabilityTags: string[];
  /** Director-only profile (interactive remote-control, never runner-claimed queue work). */
  directorOnly?: boolean;
  /** Also matches a heartbeat tag that is data (a profile name), beyond capabilityTags. */
  matchesCapability?: (tag: string) => boolean;
  matchesTask: (t: TaskExecStamp) => boolean;
}

const FABLE_MODEL = 'claude-fable-5';

/** A Claude profile directory's basename (`~/.claude` → `claude`, `~/.claude-<name>` → `claude-<name>`). */
export function isClaudeProfileTag(tag: string): boolean {
  return tag === 'claude' || /^claude-[a-z0-9][a-z0-9_.-]*$/.test(tag);
}

export const WORKER_LANE_DEFS: WorkerLaneDef[] = [
  {
    id: 'claude-runner', label: 'Claude (runner)', capabilityTags: ['claude-runner'],
    matchesCapability: isClaudeProfileTag,
    matchesTask: (t) => t.executionLane === 'claude' && t.routedModel !== FABLE_MODEL,
  },
  {
    id: 'fable', label: 'Claude (Fable)', capabilityTags: ['fable'],
    matchesTask: (t) => t.executionLane === 'claude' && t.routedModel === FABLE_MODEL,
  },
  {
    id: 'director', label: 'Claude (director — interactive only)', capabilityTags: ['director'],
    directorOnly: true,
    matchesTask: () => false,
  },
  {
    id: 'codex', label: 'Codex', capabilityTags: ['codex'],
    matchesTask: (t) => t.executionLane === 'agentic-fallback' && t.executionProvider === 'openai',
  },
  {
    // cli_task_runner.sh stamps executionLane='claude' for every external-CLI
    // dispatch (codex/agy) — the executionLane enum is still {claude,
    // agentic-fallback} (plan/MULTI_PROVIDER_ORCHESTRATION.md L4 follow-up),
    // so executionProvider is the only signal that actually distinguishes agy.
    id: 'antigravity', label: 'Antigravity', capabilityTags: ['antigravity', 'agy'],
    matchesTask: (t) => t.executionLane === 'claude' && t.executionProvider === 'agy',
  },
  {
    id: 'copilot', label: 'GitHub Copilot', capabilityTags: ['copilot'],
    matchesTask: (t) => t.executionLane === 'agentic-fallback' && t.executionProvider === 'github-copilot',
  },
  {
    id: 'ollama', label: 'Ollama (local models)', capabilityTags: ['ollama'],
    matchesTask: (t) => t.executionProvider === 'ollama',
  },
  {
    id: 'deepseek', label: 'DeepSeek API', capabilityTags: ['deepseek'],
    matchesTask: (t) => t.executionProvider === 'deepseek',
  },
  {
    id: 'kimi', label: 'Kimi (Moonshot) API', capabilityTags: ['kimi', 'moonshot'],
    matchesTask: (t) => t.executionProvider === 'kimi' || t.executionProvider === 'moonshot',
  },
];

export interface WorkerLaneRow {
  id: string;
  label: string;
  directorOnly: boolean;
  status: WorkerLaneConnection;
  host: string | null;
  lastCheckAt: string | null;
  executions24h: number;
  executions30d: number;
}

export interface WorkerLaneStatus {
  generatedAt: string;
  thresholdMinutes: number;
  lanes: WorkerLaneRow[];
}

/** Pure, DB-free core — unit tested directly over fixture rows (see tests/unit/worker-lane-status.test.ts). */
export function computeWorkerLaneStatus(
  heartbeats: HeartbeatLike[],
  tasks: TaskExecStamp[],
  now: Date,
  thresholdMinutes = DEFAULT_LIVENESS_THRESHOLD_MINUTES,
): WorkerLaneStatus {
  const thresholdMs = thresholdMinutes * 60_000;
  const since24h = now.getTime() - 24 * 60 * 60_000;
  const since30d = now.getTime() - 30 * 24 * 60 * 60_000;

  const lanes: WorkerLaneRow[] = WORKER_LANE_DEFS.map((def) => {
    const matches = heartbeats
      .filter((h) => (h.capabilities ?? []).some((c) => def.capabilityTags.includes(c) || !!def.matchesCapability?.(c)))
      .sort((a, b) => b.lastHeartbeatAt.getTime() - a.lastHeartbeatAt.getTime());
    const latest = matches[0];

    let status: WorkerLaneConnection = 'not-configured';
    let host: string | null = null;
    let lastCheckAt: string | null = null;
    if (latest) {
      host = latest.machine;
      lastCheckAt = latest.lastHeartbeatAt.toISOString();
      status = now.getTime() - latest.lastHeartbeatAt.getTime() <= thresholdMs ? 'connected' : 'down';
    }

    // Bounds the window itself rather than trusting the caller's DB query to
    // have pre-filtered — getWorkerLaneStatus() below does filter completedAt
    // at the query level too, but a defensive bound here keeps this function
    // correct for any caller (including the unit tests over fixture rows).
    let executions24h = 0;
    let executions30d = 0;
    for (const t of tasks) {
      if (!def.matchesTask(t)) continue;
      const finishedAt = executionFinishedAt(t);
      if (!finishedAt || finishedAt.getTime() < since30d) continue;
      executions30d++;
      if (finishedAt.getTime() >= since24h) executions24h++;
    }

    return { id: def.id, label: def.label, directorOnly: !!def.directorOnly, status, host, lastCheckAt, executions24h, executions30d };
  });

  return { generatedAt: now.toISOString(), thresholdMinutes, lanes };
}

function requireDb(): void {
  if (!isConnected() || !RunnerHeartbeatModel || !TaskModel) {
    throw new Error('MongoDB not connected — worker lane status unavailable');
  }
}

/** DB-backed read: fleet heartbeats + the last 30d of execution-stamped tasks, tenant-scoped. */
export async function getWorkerLaneStatus(
  tenantId: string,
  opts: { thresholdMinutes?: number } = {},
): Promise<WorkerLaneStatus> {
  requireDb();
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60_000);

  const [heartbeats, tasks] = await Promise.all([
    scopedFind(RunnerHeartbeatModel, tenantId, {})
      .lean<Array<{ machine: string; lastHeartbeatAt: Date; capabilities?: string[] }>>()
      .exec(),
    scopedFind(TaskModel, tenantId, {
      $and: [
        { $or: [{ completedAt: { $gte: since30d } }, { status: 'review', reviewEnteredAt: { $gte: since30d } }] },
        { $or: [{ executionProvider: { $exists: true } }, { executionLane: { $exists: true } }] },
      ],
    })
      .select('executionLane executionProvider routedModel completedAt status reviewEnteredAt')
      .lean<TaskExecStamp[]>()
      .exec(),
  ]);

  return computeWorkerLaneStatus(heartbeats as unknown as HeartbeatLike[], tasks, now, opts.thresholdMinutes);
}
