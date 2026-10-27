// Gateway tools answered straight from Atlas — the CLOUD fallback for every page.
//
// The Vercel dashboard cannot reach the gateway (it runs on the operator's
// office Mac and is deliberately NOT exposed — operator decision 2026-10-02:
// "Atlas, no tunnel"). The gateway's durable store IS Atlas, so when a gateway
// call fails, lib/gateway.ts asks this module first: each handler mirrors the
// gateway's own handler (same filters, sort, limits, response shape) for the
// read tools the dashboard uses, plus the swarm/mail operator actions.
//
// Not everything can live here: logs_list is the gateway's IN-MEMORY ring
// buffer (monitoring/log-store.ts) and never reaches Atlas, and health/perf/
// routing are live process state — those return a clear `cloudUnavailable`
// marker so a page can say so instead of a bare 502. Server-side only; loaded
// via dynamic import so mongoose never enters a client bundle.
import mongoose from 'mongoose';
import { connectDB } from '@/lib/db';
import { tenantFilter } from '@/lib/tenant-cookie';
import {
  ackMailAtlas,
  approveSwarmAtlas,
  getSwarmAtlas,
  snapshotAtlas,
} from '@/lib/swarm-atlas';
import { snapshotWorkerLanesAtlas } from '@/lib/worker-lanes-atlas';

type Args = Record<string, unknown>;
type Handler = (tenantId: string, args: Args) => Promise<unknown>;

const PRIORITY_ORDER = ['P0', 'P1', 'P2', 'P3'];
const JOB_STATUSES = ['done', 'blocked', 'failed', 'no-result']; // job-history-store.ts JOB_HISTORY_STATUSES

async function col(name: string) {
  await connectDB();
  const db = mongoose.connection.db;
  if (!db) throw new Error('database not connected');
  return db.collection(name);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/** job-history-store.ts searchJobHistory parity. */
const jobHistorySearch: Handler = async (tenantId, a) => {
  const q: Record<string, unknown> = { ...tenantFilter(tenantId) };
  if (str(a.repo)) q.repo = str(a.repo);
  if (str(a.taskId)) q.taskId = str(a.taskId);
  if (str(a.status) && JOB_STATUSES.includes(String(a.status))) q.status = a.status;
  if (str(a.q)) {
    const re = new RegExp(escapeRegex(String(a.q).slice(0, 200)), 'i');
    q.$and = [{ $or: [{ resultLine: re }, { errorExcerpt: re }] }];
  }
  const startedAt: Record<string, Date> = {};
  if (num(a.since) !== undefined) startedAt.$gte = new Date(num(a.since)!);
  if (num(a.until) !== undefined) startedAt.$lte = new Date(num(a.until)!);
  if (Object.keys(startedAt).length) q.startedAt = startedAt;
  const limit = Math.min(Math.max(Math.trunc(num(a.limit) || 50), 1), 500);
  const c = await col('runnerjobhistories');
  const [total, docs] = await Promise.all([c.countDocuments(q), c.find(q).sort({ startedAt: -1 }).limit(limit).toArray()]);
  return {
    total,
    entries: docs.map((d) => ({
      jobId: d.jobId, repo: d.repo, taskId: d.taskId, status: d.status, resultLine: d.resultLine,
      errorExcerpt: d.errorExcerpt, exitCode: d.exitCode ?? undefined, machine: d.machine ?? undefined,
      model: d.usedModel ?? undefined, logFile: d.logFile ?? undefined, startedAt: d.startedAt,
      durationSeconds: d.durationSeconds ?? undefined,
    })),
  };
};

/** task-store.ts listTasksPage parity (priority, createdAt, taskId order; no cursor in the cloud path). */
const tasksList: Handler = async (tenantId, a) => {
  const q: Record<string, unknown> = { ...tenantFilter(tenantId) };
  for (const k of ['repo', 'status', 'priority', 'assignedAgent'] as const) if (str(a[k])) q[k] = str(a[k]);
  const limit = Math.min(Math.max(Math.trunc(num(a.limit) || 50), 1), 500);
  const docs = await (await col('tasks')).find(q, { projection: { _id: 0, __v: 0 } })
    .sort({ priority: 1, createdAt: 1, taskId: 1 }).limit(limit).toArray();
  docs.sort((x, y) => PRIORITY_ORDER.indexOf(String(x.priority)) - PRIORITY_ORDER.indexOf(String(y.priority)));
  return { count: docs.length, tasks: docs };
};

/** repos_list: the tenant's DB `repos` table (the managed_repos.txt seed lives on the Mac only). */
const reposList: Handler = async (tenantId) => {
  const repos = await (await col('repos')).find(tenantFilter(tenantId), { projection: { _id: 0, __v: 0 } }).sort({ name: 1 }).toArray();
  return { total: repos.length, withAiFolder: repos.filter((r) => r.hasAiFolder).length, gitRepos: repos.filter((r) => r.isGitRepo).length, repos };
};

const mailInbox: Handler = async (tenantId, a) => {
  const raw = Array.isArray(a.to) ? a.to : [a.to];
  const to = raw.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim().toLowerCase());
  if (!to.length) return { messages: [], unreadCount: 0 };
  const q: Record<string, unknown> = { ...tenantFilter(tenantId), to: { $in: to } };
  if (a.includeAcked !== true) q.acked = false;
  const c = await col('mailbox_messages');
  const limit = Math.min(Math.max(Math.trunc(num(a.limit) || 50), 1), 200);
  const [messages, unreadCount] = await Promise.all([
    c.find(q, { projection: { _id: 0, __v: 0 } }).sort({ createdAt: -1 }).limit(limit).toArray(),
    c.countDocuments({ ...tenantFilter(tenantId), to: { $in: to }, acked: false }),
  ]);
  return { count: messages.length, unreadCount, messages };
};

const swarmList: Handler = async (tenantId, a) => {
  const snap = await snapshotAtlas(tenantId);
  let swarms = snap.swarms.map((s) => s.swarm);
  if (str(a.status)) swarms = swarms.filter((s) => s.status === a.status);
  if (str(a.repo)) swarms = swarms.filter((s) => s.repo === a.repo);
  return { count: swarms.length, swarms };
};

/** Live gateway process state — not in Atlas by design. */
const liveOnly = (what: string): Handler => async () => ({
  cloudUnavailable: true,
  reason: `${what} is live state inside the local gateway on the office Mac and is not stored in Atlas — open the local dashboard (localhost:3210) to see it.`,
});

const HANDLERS: Record<string, Handler> = {
  job_history_search: jobHistorySearch,
  tasks_list: tasksList,
  repos_list: reposList,
  mail_inbox: mailInbox,
  mail_ack: (t, a) => ackMailAtlas(t, String(a.id ?? ''), String(a.ackedBy ?? 'operator (dashboard) · cloud')),
  swarm_list: swarmList,
  swarm_get: (t, a) => getSwarmAtlas(t, String(a.swarmId ?? '')),
  swarm_approve: (t, a) => approveSwarmAtlas(t, String(a.swarmId ?? ''), String(a.approvedBy ?? 'operator (dashboard) · cloud')),
  // No swarm_stop here: a stop must leave a `swarm.action` audit row, and the
  // trail lives in the gateway — without it the stop is refused (phase 3).
  worker_lane_status: (t, a) => snapshotWorkerLanesAtlas(t, num(a.thresholdMinutes)),
  logs_list: async () => ({ entries: [], cloudUnavailable: true, reason: 'Live logs are an in-memory buffer inside the local gateway (office Mac) — they are never written to Atlas. Open localhost:3210/logs on the Mac; run history is on /runs.' }),
  health_status: liveOnly('Gateway health'),
  perf_stats: liveOnly('Gateway performance stats'),
  provider_health: liveOnly('Provider health'),
  routing_config: liveOnly('The routing config'),
};

export function atlasHandles(tool: string): boolean {
  return tool in HANDLERS;
}

/** Run `tool` against Atlas. Returns null when this module has no answer for it. */
export async function callAtlasTool(tool: string, args: Args, tenantId: string): Promise<unknown | null> {
  const h = HANDLERS[tool];
  if (!h) return null;
  const out = await h(tenantId, args);
  // Tag object results so callers (e.g. /api/swarm's source badge) can tell
  // an Atlas answer from a gateway one.
  return out && typeof out === 'object' && !Array.isArray(out) ? { ...(out as object), _source: 'atlas' } : out;
}
