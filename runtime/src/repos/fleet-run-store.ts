import { FleetRunModel, isConnected } from '../shared/db.js';
import type { IFleetRun, IFleetRunRepo, FleetRepoActionStatus } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { scopedFind, scopedFindOne, scopedFindOneAndUpdate, tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'fleet-run-store' });

export type { FleetRepoActionStatus };

export interface FleetRepoInput {
  repo: string;
  group?: string;
  overnight?: string;
  recommendation?: string;
  branch?: string;
  ahead?: number;
  uncommitted?: number;
  openPrs?: number;
  reviewTasks?: number;
  blockedTasks?: number;
}

export interface StartFleetRunInput {
  runId: string;
  type?: string;
  machine?: string;
  agent?: string;
  repos: FleetRepoInput[];
}

export interface FleetRepoPatch {
  decision?: string;
  action?: string;
  actionStatus?: FleetRepoActionStatus;
  detail?: string;
  prUrl?: string;
  recommendation?: string;
}

export interface FleetRunView {
  runId: string;
  type: string;
  status: 'running' | 'completed' | 'aborted';
  machine?: string;
  agent?: string;
  startedAt: Date;
  finishedAt?: Date;
  repos: IFleetRunRepo[];
  summary?: Record<string, unknown>;
}

function toView(doc: IFleetRun): FleetRunView {
  return {
    runId: doc.runId,
    type: doc.type,
    status: doc.status,
    machine: doc.machine,
    agent: doc.agent,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt,
    repos: doc.repos,
    summary: doc.summary,
  };
}

/** Compute a per-repo summary from the repos array (live counts). */
function computeSummary(repos: IFleetRunRepo[]): Record<string, number> {
  const needsAction = repos.filter(r => ['ship', 'review', 'merge', 'fix', 'wrap-up', 'attention'].includes(r.recommendation)).length;
  const shipped = repos.filter(r => r.actionStatus === 'done').length;
  const failed = repos.filter(r => r.actionStatus === 'failed').length;
  return { total: repos.length, needsAction, shipped, failed };
}

/** Create (or replace) the fleet run keyed by runId — the morning aggregate. */
export async function startFleetRun(tenantId: string, input: StartFleetRunInput): Promise<FleetRunView | null> {
  if (!isConnected() || !FleetRunModel) {
    log.warn('DB not connected — cannot start fleet run');
    return null;
  }
  if (!input.runId) throw new Error('runId is required');

  const now = new Date();
  const repos: IFleetRunRepo[] = (input.repos || []).map(r => ({
    repo: r.repo,
    group: r.group,
    overnight: r.overnight ?? '',
    recommendation: r.recommendation ?? 'idle',
    branch: r.branch,
    ahead: r.ahead,
    uncommitted: r.uncommitted,
    openPrs: r.openPrs,
    reviewTasks: r.reviewTasks,
    blockedTasks: r.blockedTasks,
    actionStatus: 'pending',
    updatedAt: now,
  }));

  const doc = await scopedFindOneAndUpdate(
    FleetRunModel, tenantId,
    { runId: input.runId },
    {
      $set: {
        type: input.type ?? 'morning-resume-all',
        status: 'running',
        machine: input.machine,
        agent: input.agent,
        startedAt: now,
        finishedAt: undefined,
        repos,
        summary: computeSummary(repos),
      },
      $setOnInsert: { ...tenantScope(tenantId), runId: input.runId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  log.info({ runId: input.runId, repos: repos.length }, 'fleet run started');
  return toView(doc as IFleetRun);
}

/** Patch one repo's progress within a run and refresh the summary. */
export async function updateFleetRepo(tenantId: string, runId: string, repo: string, patch: FleetRepoPatch): Promise<FleetRunView | null> {
  if (!isConnected() || !FleetRunModel) {
    log.warn('DB not connected — cannot update fleet repo');
    return null;
  }
  const set: Record<string, unknown> = { 'repos.$.updatedAt': new Date() };
  for (const k of ['decision', 'action', 'actionStatus', 'detail', 'prUrl', 'recommendation'] as const) {
    if (patch[k] !== undefined && patch[k] !== '') set[`repos.$.${k}`] = patch[k];
  }

  const doc = await scopedFindOneAndUpdate(
    FleetRunModel, tenantId,
    { runId, 'repos.repo': repo },
    { $set: set },
    { new: true },
  );
  if (!doc) {
    log.warn({ runId, repo }, 'fleet repo not found for update');
    return null;
  }
  // Recompute the summary off the freshly-updated repos.
  doc.summary = computeSummary(doc.repos);
  await doc.save();
  return toView(doc as IFleetRun);
}

/** Close a run — status completed (or aborted) + final summary. */
export async function finishFleetRun(tenantId: string, runId: string, status: 'completed' | 'aborted' = 'completed'): Promise<FleetRunView | null> {
  if (!isConnected() || !FleetRunModel) return null;
  const doc = await scopedFindOne(FleetRunModel, tenantId, { runId });
  if (!doc) return null;
  doc.status = status;
  doc.finishedAt = new Date();
  doc.summary = computeSummary(doc.repos);
  await doc.save();
  log.info({ runId, status }, 'fleet run finished');
  return toView(doc as IFleetRun);
}

export async function getFleetRun(tenantId: string, runId: string): Promise<FleetRunView | null> {
  if (!isConnected() || !FleetRunModel) return null;
  const doc = await scopedFindOne(FleetRunModel, tenantId, { runId }).lean<IFleetRun | null>();
  return doc ? toView(doc) : null;
}

export async function latestFleetRun(tenantId: string): Promise<FleetRunView | null> {
  if (!isConnected() || !FleetRunModel) return null;
  const doc = await scopedFindOne(FleetRunModel, tenantId, {}).sort({ startedAt: -1 }).lean<IFleetRun | null>();
  return doc ? toView(doc) : null;
}

export async function listFleetRuns(tenantId: string, limit = 20): Promise<FleetRunView[]> {
  if (!isConnected() || !FleetRunModel) return [];
  const docs = await scopedFind(FleetRunModel, tenantId, {}).sort({ startedAt: -1 }).limit(limit).lean<IFleetRun[]>();
  return docs.map(toView);
}
