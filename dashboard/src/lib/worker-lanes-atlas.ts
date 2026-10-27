// Worker lane status straight from Atlas — the CLOUD path for the /swarm
// "Workers" panel, registered as the gateway-atlas fallback for the
// `worker_lane_status` MCP tool (lib/gateway-atlas.ts).
//
// SAME rules as runtime/src/tasks/worker-lane-status.ts (WORKER_LANE_DEFS,
// the connected/down/not-configured threshold, the worker/fable/master/
// agentic-fallback/API-tier matching) — duplicated here because the dashboard
// and the gateway are separately deployed apps with no shared package, same
// convention as lib/swarm-atlas.ts mirroring tasks/swarm-store.ts. Keep the
// two in sync by hand if the lane taxonomy changes.
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { tenantFilter } from '@/lib/tenant';

export const DEFAULT_LIVENESS_THRESHOLD_MINUTES = 25;

export type WorkerLaneConnection = 'connected' | 'down' | 'not-configured';

export interface TaskExecStamp {
  executionLane?: string;
  executionProvider?: string;
  routedModel?: string;
  completedAt?: Date;
}

interface HeartbeatLike {
  machine: string;
  lastHeartbeatAt: Date;
  capabilities?: string[];
}

interface WorkerLaneDef {
  id: string;
  label: string;
  capabilityTags: string[];
  directorOnly?: boolean;
  /** Also matches a heartbeat tag that is data (a profile name), beyond capabilityTags. */
  matchesCapability?: (tag: string) => boolean;
  matchesTask: (t: TaskExecStamp) => boolean;
}

const FABLE_MODEL = 'claude-fable-5';

/** A Claude profile directory's basename — the runner's tag, whatever the profile is called (v1 G6). */
export function isClaudeProfileTag(tag: string): boolean {
  return tag === 'claude' || /^claude-[a-z0-9][a-z0-9_.-]*$/.test(tag);
}

export const WORKER_LANE_DEFS: WorkerLaneDef[] = [
  { id: 'claude-runner', label: 'Claude (runner)', capabilityTags: ['claude-runner'],
    matchesCapability: isClaudeProfileTag,
    matchesTask: (t) => t.executionLane === 'claude' && t.routedModel !== FABLE_MODEL },
  { id: 'fable', label: 'Claude (Fable)', capabilityTags: ['fable'],
    matchesTask: (t) => t.executionLane === 'claude' && t.routedModel === FABLE_MODEL },
  { id: 'director', label: 'Claude (director — interactive only)', capabilityTags: ['director'], directorOnly: true,
    matchesTask: () => false },
  { id: 'codex', label: 'Codex', capabilityTags: ['codex'],
    matchesTask: (t) => t.executionLane === 'agentic-fallback' && t.executionProvider === 'openai' },
  // cli_task_runner.sh stamps executionLane='claude' for every external-CLI
  // dispatch (codex/agy) — executionProvider is the only signal that
  // actually distinguishes agy (Gemini API tier removed, task-5a8c09ca).
  { id: 'antigravity', label: 'Antigravity', capabilityTags: ['antigravity', 'agy'],
    matchesTask: (t) => t.executionLane === 'claude' && t.executionProvider === 'agy' },
  { id: 'copilot', label: 'GitHub Copilot', capabilityTags: ['copilot'],
    matchesTask: (t) => t.executionLane === 'agentic-fallback' && t.executionProvider === 'github-copilot' },
  { id: 'ollama', label: 'Ollama (local models)', capabilityTags: ['ollama'],
    matchesTask: (t) => t.executionProvider === 'ollama' },
  { id: 'deepseek', label: 'DeepSeek API', capabilityTags: ['deepseek'],
    matchesTask: (t) => t.executionProvider === 'deepseek' },
  { id: 'kimi', label: 'Kimi (Moonshot) API', capabilityTags: ['kimi', 'moonshot'],
    matchesTask: (t) => t.executionProvider === 'kimi' || t.executionProvider === 'moonshot' },
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

    // Bounds the window itself rather than trusting the caller to have
    // pre-filtered — snapshotWorkerLanesAtlas() below filters completedAt at
    // the query level too, but this keeps the function correct standalone.
    let executions24h = 0;
    let executions30d = 0;
    for (const t of tasks) {
      if (!def.matchesTask(t)) continue;
      if (!t.completedAt || t.completedAt.getTime() < since30d) continue;
      executions30d++;
      if (t.completedAt.getTime() >= since24h) executions24h++;
    }

    return { id: def.id, label: def.label, directorOnly: !!def.directorOnly, status, host, lastCheckAt, executions24h, executions30d };
  });

  return { generatedAt: now.toISOString(), thresholdMinutes, lanes };
}

export async function snapshotWorkerLanesAtlas(tenantId: string, thresholdMinutes?: number): Promise<WorkerLaneStatus> {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error('database not connected');
  const now = new Date();
  const since30d = new Date(now.getTime() - 30 * 24 * 60 * 60_000);

  const [heartbeats, tasks] = await Promise.all([
    db.collection('runner_heartbeats').find(tenantFilter(tenantId)).toArray(),
    db.collection('tasks').find({
      ...tenantFilter(tenantId),
      completedAt: { $gte: since30d },
      $or: [{ executionProvider: { $exists: true } }, { executionLane: { $exists: true } }],
    }, { projection: { _id: 0, executionLane: 1, executionProvider: 1, routedModel: 1, completedAt: 1 } }).toArray(),
  ]);

  return computeWorkerLaneStatus(
    heartbeats.map((h) => ({ machine: String(h.machine), lastHeartbeatAt: new Date(h.lastHeartbeatAt), capabilities: h.capabilities as string[] | undefined })),
    tasks.map((t) => ({
      executionLane: t.executionLane as string | undefined,
      executionProvider: t.executionProvider as string | undefined,
      routedModel: t.routedModel as string | undefined,
      completedAt: t.completedAt ? new Date(t.completedAt) : undefined,
    })),
    now,
    thresholdMinutes,
  );
}
