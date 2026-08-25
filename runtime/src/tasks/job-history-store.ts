/**
 * Searchable runner job-history archive (OBSERVABILITY, task-1873b3be).
 *
 * One row per runner fire — the durable, tenant-scoped index over the job
 * logs cli_task_runner.sh writes to ~/.ai-cli-runner/logs. Those raw files
 * are machine-local and rotated away (runner_log_rotate.sh), so "which
 * overnight run touched repo X?" or "when did that error last appear?" used
 * to mean SSHing into whichever Mac ran it and grepping. This store keeps the
 * SEARCHABLE SUMMARY of every run (repo, task id, outcome, RESULT line, a
 * bounded error excerpt) centrally, queryable from the dashboard /runs page
 * and the `job_history_search` MCP tool.
 *
 * Deliberately NOT the raw log body: the full transcript stays host-local
 * under the rotation policy, and the bounded reviewable slice (diff +
 * session.log tail) already lives in the artifact store per task. This module
 * indexes outcomes; it does not duplicate content.
 *
 * Ingestion is idempotent — `logFile` (the host log filename) is a per-tenant
 * unique key, so re-running scripts/ingest_runner_history.sh over the same
 * directory upserts instead of duplicating.
 *
 * Retention: prune-on-write (best-effort, never fails the record call) —
 * rows older than JOB_HISTORY_RETENTION_DAYS (default 90) are deleted, and a
 * per-tenant cap JOB_HISTORY_MAX_PER_TENANT (default 5000) evicts oldest-first
 * so one busy tenant can't grow the collection without bound.
 */
import { randomUUID } from 'node:crypto';
import { RunnerJobHistoryModel, isConnected } from '../shared/db.js';
import type { IRunnerJobHistory, JobHistoryStatus } from '../shared/db.js';
import { createChildLogger } from '../shared/logger.js';
import { redactString } from '../shared/redact.js';
import { scopedFind, scopedCountDocuments, tenantScope, withTenant } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'job-history-store' });

export const JOB_HISTORY_STATUSES: JobHistoryStatus[] = ['done', 'blocked', 'failed', 'no-result'];

/** Caps on stored text — this is an index of outcomes, not a log store. */
export const MAX_RESULT_LINE_CHARS = 2000;
export const MAX_ERROR_EXCERPT_CHARS = 4000;

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_MAX_PER_TENANT = 5000;
const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 500;

export function retentionDays(): number {
  const n = Number(process.env.JOB_HISTORY_RETENTION_DAYS);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_RETENTION_DAYS;
}

export function maxPerTenant(): number {
  const n = Number(process.env.JOB_HISTORY_MAX_PER_TENANT);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULT_MAX_PER_TENANT;
}

export interface RecordJobHistoryInput {
  repo: string;
  taskId: string;
  status: JobHistoryStatus;
  resultLine?: string;
  errorExcerpt?: string;
  exitCode?: number;
  machine?: string;
  model?: string;
  logFile?: string;
  /** Epoch ms the job fired; defaults to now. */
  startedAtMs?: number;
  durationSeconds?: number;
}

export interface JobHistoryView {
  jobId: string;
  repo: string;
  taskId: string;
  status: JobHistoryStatus;
  resultLine: string;
  errorExcerpt: string;
  exitCode?: number;
  machine?: string;
  model?: string;
  logFile?: string;
  startedAt: Date;
  durationSeconds?: number;
}

function toView(doc: IRunnerJobHistory): JobHistoryView {
  return {
    jobId: doc.jobId,
    repo: doc.repo,
    taskId: doc.taskId,
    status: doc.status,
    resultLine: doc.resultLine,
    errorExcerpt: doc.errorExcerpt,
    exitCode: doc.exitCode ?? undefined,
    machine: doc.machine ?? undefined,
    model: doc.usedModel ?? undefined,
    logFile: doc.logFile ?? undefined,
    startedAt: doc.startedAt,
    durationSeconds: doc.durationSeconds ?? undefined,
  };
}

function requireDb(): void {
  if (!isConnected() || !RunnerJobHistoryModel) {
    throw new Error('MongoDB not connected — job-history store unavailable');
  }
}

/**
 * Record (or, when `logFile` matches an existing row for this tenant, update)
 * one run. Text fields are redacted + capped at write time so a secret that
 * leaked into a RESULT line can never reach the collection.
 */
export async function recordJobHistory(tenantId: string, input: RecordJobHistoryInput): Promise<JobHistoryView> {
  requireDb();
  if (!tenantId) throw new Error('tenantId is required');
  if (!input.repo || typeof input.repo !== 'string') throw new Error('repo is required');
  if (!input.taskId || typeof input.taskId !== 'string') throw new Error('taskId is required');
  if (!JOB_HISTORY_STATUSES.includes(input.status)) {
    throw new Error(`status must be one of ${JOB_HISTORY_STATUSES.join('|')}`);
  }

  const fields = {
    repo: input.repo.slice(0, 200),
    taskId: input.taskId.slice(0, 200),
    status: input.status,
    resultLine: redactString(input.resultLine ?? '').slice(0, MAX_RESULT_LINE_CHARS),
    errorExcerpt: redactString(input.errorExcerpt ?? '').slice(0, MAX_ERROR_EXCERPT_CHARS),
    exitCode: typeof input.exitCode === 'number' && Number.isFinite(input.exitCode) ? Math.trunc(input.exitCode) : undefined,
    machine: typeof input.machine === 'string' ? input.machine.slice(0, 100) : undefined,
    usedModel: typeof input.model === 'string' ? input.model.slice(0, 100) : undefined,
    logFile: typeof input.logFile === 'string' && input.logFile ? input.logFile.slice(0, 300) : undefined,
    startedAt: new Date(Number.isFinite(input.startedAtMs) ? (input.startedAtMs as number) : Date.now()),
    durationSeconds:
      typeof input.durationSeconds === 'number' && Number.isFinite(input.durationSeconds) && input.durationSeconds >= 0
        ? Math.trunc(input.durationSeconds)
        : undefined,
  };

  let doc: IRunnerJobHistory | null = null;
  if (fields.logFile) {
    // tenantId + logFile come from the filter's equality fields (Mongo copies
    // them onto the upserted doc) — repeating tenantId in $setOnInsert would
    // be a path conflict.
    doc = await RunnerJobHistoryModel.findOneAndUpdate(
      withTenant(tenantId, { logFile: fields.logFile }),
      { $set: fields, $setOnInsert: { jobId: randomUUID() } },
      { new: true, upsert: true },
    );
  } else {
    doc = await RunnerJobHistoryModel.create({ ...tenantScope(tenantId), jobId: randomUUID(), ...fields });
  }

  // Retention is best-effort and must never fail the record call.
  try {
    await pruneJobHistory(tenantId);
  } catch (err) {
    log.warn({ err, tenantId }, 'job-history retention prune failed (non-fatal)');
  }

  return toView(doc as IRunnerJobHistory);
}

export interface JobHistorySearchFilter {
  repo?: string;
  taskId?: string;
  status?: JobHistoryStatus;
  /** Case-insensitive substring over resultLine + errorExcerpt (regex-escaped). */
  q?: string;
  /** Only runs started at/after this epoch-ms timestamp. */
  since?: number;
  /** Only runs started at/before this epoch-ms timestamp. */
  until?: number;
  limit?: number;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface JobHistorySearchResult {
  total: number;
  entries: JobHistoryView[];
}

/** Search a tenant's run archive, newest first. `total` is the pre-limit match count. */
export async function searchJobHistory(tenantId: string, filter: JobHistorySearchFilter = {}): Promise<JobHistorySearchResult> {
  requireDb();
  if (!tenantId) throw new Error('tenantId is required');

  const query: Record<string, unknown> = {};
  if (filter.repo) query.repo = filter.repo;
  if (filter.taskId) query.taskId = filter.taskId;
  if (filter.status && JOB_HISTORY_STATUSES.includes(filter.status)) query.status = filter.status;
  if (filter.q) {
    const re = new RegExp(escapeRegex(filter.q.slice(0, 200)), 'i');
    query.$or = [{ resultLine: re }, { errorExcerpt: re }];
  }
  const startedAt: Record<string, Date> = {};
  if (typeof filter.since === 'number' && Number.isFinite(filter.since)) startedAt.$gte = new Date(filter.since);
  if (typeof filter.until === 'number' && Number.isFinite(filter.until)) startedAt.$lte = new Date(filter.until);
  if (Object.keys(startedAt).length > 0) query.startedAt = startedAt;

  const limit = Math.min(Math.max(Math.trunc(filter.limit || DEFAULT_SEARCH_LIMIT), 1), MAX_SEARCH_LIMIT);
  const total = await scopedCountDocuments(RunnerJobHistoryModel, tenantId, query);
  const docs = await scopedFind(RunnerJobHistoryModel, tenantId, query).sort({ startedAt: -1 }).limit(limit);
  return { total, entries: (docs as IRunnerJobHistory[]).map(toView) };
}

export interface JobHistoryPruneResult {
  removedByAge: number;
  removedByCap: number;
}

/**
 * Apply the retention policy for one tenant: age-based delete first, then
 * oldest-first eviction down to the per-tenant cap.
 */
export async function pruneJobHistory(tenantId: string): Promise<JobHistoryPruneResult> {
  requireDb();
  if (!tenantId) throw new Error('tenantId is required');

  const cutoff = new Date(Date.now() - retentionDays() * 24 * 60 * 60 * 1000);
  const byAge = await RunnerJobHistoryModel.deleteMany(withTenant(tenantId, { startedAt: { $lt: cutoff } }));
  const removedByAge = byAge?.deletedCount ?? 0;

  let removedByCap = 0;
  const cap = maxPerTenant();
  const count = await scopedCountDocuments(RunnerJobHistoryModel, tenantId, {});
  if (count > cap) {
    const overflow = await scopedFind(RunnerJobHistoryModel, tenantId, {})
      .sort({ startedAt: 1 })
      .limit(count - cap)
      .select({ jobId: 1 });
    const jobIds = (overflow as Pick<IRunnerJobHistory, 'jobId'>[]).map((d) => d.jobId);
    if (jobIds.length > 0) {
      const byCap = await RunnerJobHistoryModel.deleteMany(withTenant(tenantId, { jobId: { $in: jobIds } }));
      removedByCap = byCap?.deletedCount ?? 0;
    }
  }

  if (removedByAge > 0 || removedByCap > 0) {
    log.info({ tenantId, removedByAge, removedByCap }, 'job-history retention prune');
  }
  return { removedByAge, removedByCap };
}
