import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig } from '../shared/config.js';
import { searchVectors, storeVector, getVectorCount, recallSession } from '../memory/vector-store.js';
import { indexMasterRepo, indexAllRepos } from '../memory/indexer.js';
import { createChildLogger } from '../shared/logger.js';
import { recordUsage, summarizeUsage } from '../shared/usage-store.js';
import { randomUUID } from 'node:crypto';
import { loadAgents, loadSkills } from '../agents/loader.js';
import { createTask, updateTask, listTasks, nextTask, countTasks, claimTask, failTask } from '../tasks/task-store.js';
import { saveArtifact, listArtifacts } from '../tasks/artifact-store.js';
import { runInlineCycle, inlineQuotaUsage, INLINE_OPERATIONS } from '../tasks/inline-executor.js';
import { acquireLease, heartbeatLease, releaseLease, listLeases } from '../tasks/runner-lease-store.js';
import { recordHeartbeat, getRunnerLiveness } from '../tasks/runner-heartbeat-store.js';
import { enterFleetMaintenance, exitFleetMaintenance, getFleetMaintenanceStatus } from '../tasks/fleet-maintenance-store.js';
import { listRepoPaths, listReposUnified, getRepoStatus, prioritizeRepos, scanDirectory } from '../repos/repo-registry.js';
import { upsertRepo } from '../repos/repo-store.js';
import {
  buildCodeGraph, computePrImpact, resolveChangedFiles, triagePrs,
  getNeighbors, shortestPath, resolveGraphNode, ALL_EDGE_TYPES,
} from '../repos/code-graph.js';
import type { PrTriageInput, EdgeType } from '../repos/code-graph.js';
import { upsertRepoCard, listRepoCards } from '../repos/app-card-store.js';
import type { RepoCardLevel } from '../repos/app-card-store.js';
import { createNewApp } from '../repos/new-app.js';
import {
  listConnectors,
  upsertConnector,
  setConnectorEnabled,
  removeConnector,
  seedDefaultConnectors,
  buildMcpConfig,
} from '../repos/connector-store.js';
import type { ConnectorTransport } from '../repos/connector-bundle.js';
import { setPlan, listPlan } from '../repos/plan-store.js';
import type { PlanDayInput } from '../repos/plan-store.js';
import { writeHandoff, readHandoff, listLatestHandoffs } from '../repos/handoff-store.js';
import { exportSession, importSession, recallSessionContext } from '../core/session-manager.js';
import type { SessionExport } from '../core/session-manager.js';
import { buildBootBundle } from './context-bundle.js';
import {
  startFleetRun, updateFleetRepo, finishFleetRun, getFleetRun, latestFleetRun, listFleetRuns,
} from '../repos/fleet-run-store.js';
import type { FleetRepoInput, FleetRepoPatch, FleetRepoActionStatus } from '../repos/fleet-run-store.js';
import { complete as llmComplete, isConfigured as isLlmConfigured, getAllProviderHealth, getProviderHealth, resetProvider, enterMaintenance, exitMaintenance, assertKnownProvider } from '../llm/provider.js';
import {
  createSchedule,
  updateSchedule,
  getSchedule,
  listSchedules,
  recordRunResult,
  deleteSchedule,
} from '../scheduler/schedule-store.js';
import { computeNextRun, isValidCronExpr } from '../scheduler/scheduler.js';
import { seedDefaultSchedules } from '../scheduler/seed-schedules.js';
import { runMorningSweep } from '../scheduler/morning-sweep.js';
import { runEveningSweep } from '../scheduler/evening-sweep.js';
import { runRetentionPurge } from '../core/data-retention.js';
import { runDispatchCycle } from '../scheduler/dispatch-worker.js';
import { getBudgetStatus, getBudgetBreakdown } from '../llm/budget-stats.js';
import { route as routeLlm, getRoutingConfig } from '../llm/router.js';
import { isConnected } from '../shared/db.js';
import type { ArtifactKind, IVector, ScheduleKind, ScheduleStatus, TaskPriority, TaskSource, TaskStatus } from '../shared/db.js';
import { sendNotification, getNotificationHistory } from '../notifications/notifier.js';
import { runHealthCheck, getLatestHealthCheckResult, getHealthAlertStatus } from '../monitoring/health-alerter.js';
import { recordContextServed, getContinuityStats, getUserSavings, estimateLegacyBootTokens } from '../monitoring/continuity-metrics.js';
import { recordActivation, getActivationFunnel, getActivationRollup, getSelfServeConversion } from '../monitoring/activation-funnel.js';
import { recordToolLatency, getPerfStats } from '../monitoring/perf-metrics.js';
import { getSloAlertStatus, evaluateBreaches } from '../monitoring/slo-alerter.js';
import { recordSpan, getSpans, getTraceIds, type SpanService, type SpanStatus } from '../tracing/tracer.js';
import { recordLog, getLogs, type LogService, type LogLevel } from '../monitoring/log-store.js';
import { performance } from 'node:perf_hooks';
import { type ToolContext, SYSTEM_CONTEXT, AuthError, stripTenantFromArgs } from '../core/tenant-context.js';
import { verdictFor, tenantRepos, EntitlementError } from '../core/entitlements.js';
import { auditActorFromCtx } from '../core/audit-log.js';
import {
  brainBlame, brainExplore, brainInit, brainStatus, brainCheckout, brainDiff, brainLog, brainPop, brainRevert, brainStash,
  ideaBranch, isBrainRepo, resolveBrainDir, sessionMerge, sessionStart, writeAtom,
} from '../core/brain.js';
import type { AtomKind, BrainSection } from '../core/brain.js';
import { brainDelta, brainEnvFor, brainManifest, distillAfterMerge, reconcileMain } from '../core/distill.js';
import { computeBrainHealth } from '../core/brain-health.js';
import { brainEntity, brainTimeline } from '../core/entity.js';
import type { EntityKind } from '../core/entity.js';
import { brainCommunities } from '../core/community.js';
import { hostedBrainInfo, provisionHostedBrain, rotateHostedToken } from '../core/hosted-brain.js';
import { federatedBrainSearch } from '../core/brain-search.js';
import {
  grantNamespaceAccess, listNamespaceGrants, readSharedNamespace, revokeNamespaceAccess, writeSharedNamespaceAtom,
} from '../core/namespace-share.js';
import type { NamespaceGrantLevel } from '../core/namespace-share.js';

const log = createChildLogger({ module: 'mcp-tools' });

// ── Tool Definitions (MCP schema) ─────────────────────────

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export const TOOL_DEFINITIONS: McpToolDef[] = [
  // ── MEMORY / RAG ──────────────────────────────────────
  {
    name: 'memory_search',
    description: 'Search the RAG memory for relevant context. Returns semantically similar chunks from state files, handoff notes, commit messages, PR descriptions, and SONA patterns across all managed repos.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query' },
        repo: { type: 'string', description: 'Filter to a specific repo name (optional)' },
        source: { type: 'string', enum: ['state', 'handoff', 'commit', 'pr', 'pattern', 'bug', 'code', 'feature', 'archive'], description: 'Filter by source type (optional)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Filter by tags (optional)' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'recall_session',
    description: 'Recall past work sessions by semantic similarity. Searches the session corpus (STATE.md session blocks, handoff notes, and archived sessions) and returns the most relevant blocks ranked by similarity. Use to answer "what did we do for PR #99?", "when did we ship Phase 5b?", or "what was the fix for the update_all.sh bug?" without grepping the archive. Filter by repo or restrict to recent work with `since`.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language query about past work, e.g. "the update_all.sh overlay-merge bug"' },
        k: { type: 'number', description: 'Number of session blocks to return (default 5)' },
        since: { type: 'string', description: 'ISO date (YYYY-MM-DD) — only recall sessions on or after this date (optional)' },
        repo: { type: 'string', description: 'Filter to a specific repo name (optional)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'memory_store',
    description: 'Store a new text chunk in the RAG memory with automatic embedding. Deduplicates by content hash.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Text content to embed and store' },
        repo: { type: 'string', description: 'Repo this content belongs to' },
        source: { type: 'string', enum: ['state', 'handoff', 'commit', 'pr', 'pattern', 'bug', 'code', 'feature', 'archive'], description: 'Source type' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags for filtering' },
        sessionId: { type: 'string', description: 'Session identifier' },
      },
      required: ['content', 'repo', 'source'],
    },
  },
  {
    name: 'memory_context',
    description: 'Assemble a pre-built context block for a repo: top recent state chunks + handoff + related patterns. Returns a ready-to-inject markdown block.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name' },
        query: { type: 'string', description: 'Optional focus query to bias retrieval' },
        limit: { type: 'number', description: 'Max chunks per source (default 5)' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'memory_stats',
    description: 'Get vector count statistics by repo and source type.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Filter to a specific repo (optional)' },
      },
    },
  },
  {
    name: 'memory_reindex',
    description: 'Re-embed and upsert vectors for STATE.md, AI_AGENT_HANDOFF.md, and state/archive/*.md. Call after wrap-up to keep the RAG corpus current. Idempotent via content-hash dedup. Master repo only by default; pass scope=all to also index every managed repo.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['master', 'all'], description: 'master = this repo only (default), all = master + every managed repo' },
      },
    },
  },
  // ── STATE ─────────────────────────────────────────────
  {
    name: 'state_read',
    description: 'Read STATE.md or AI_AGENT_HANDOFF.md for a repo. Returns raw file content.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name (reads from master repo if omitted)' },
        file: { type: 'string', enum: ['state', 'handoff'], description: 'Which file to read (default: state)' },
      },
    },
  },
  {
    name: 'state_update',
    description: 'Replace or append a section in STATE.md or AI_AGENT_HANDOFF.md. Section is identified by a markdown heading (e.g. "## 3. Blockers"). If the heading does not exist, content is appended to the file.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name (master repo if omitted)' },
        file: { type: 'string', enum: ['state', 'handoff'], description: 'Target file (default: state)' },
        heading: { type: 'string', description: 'Markdown heading that starts the section (include ##/### and text). Omit to append to end of file.' },
        content: { type: 'string', description: 'New section body (without the heading line). Heading is preserved or appended.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace = overwrite section body, append = add after existing body (default: replace)' },
      },
      required: ['content'],
    },
  },
  // ── TASKS ─────────────────────────────────────────────
  {
    name: 'tasks_list',
    description: 'List tasks in the queue. Filter by repo, status, priority, or assigned agent. Sorted by priority then creation time.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Filter by repo (optional)' },
        status: { type: 'string', enum: ['pending', 'working', 'review', 'done', 'blocked', 'paused', 'dead_letter'], description: 'Filter by status (optional)' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'Filter by priority (optional)' },
        assignedAgent: { type: 'string', description: 'Filter by assigned agent (optional)' },
        limit: { type: 'number', description: 'Max results (default 50)' },
      },
    },
  },
  {
    name: 'tasks_create',
    description: 'Create a new task in the queue. Returns the created task with assigned ID.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Target repo name' },
        title: { type: 'string', description: 'Task title' },
        description: { type: 'string', description: 'Task details (optional)' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'], description: 'Priority (default P2)' },
        assignedAgent: { type: 'string', description: 'Specialist agent to assign (optional)' },
        recommendedModel: { type: 'string', description: 'Recommended model for this task, e.g. claude-fable-5, claude-sonnet-4-6 (optional)' },
        source: { type: 'string', enum: ['manual', 'connect-hub', 'auto-detected', 'scheduler', 'telegram'], description: 'Where it originated (default: manual)' },
        sourceId: { type: 'string', description: 'External ref ID (e.g. bug-123)' },
        notes: { type: 'string', description: 'Additional notes (optional)' },
      },
      required: ['repo', 'title'],
    },
  },
  {
    name: 'tasks_update',
    description: 'Update a task by ID: re-point repo, change status, priority, assigned agent, PR URL, notes, telegram message ID. Automatically sets startedAt when moving to working, completedAt when moving to done/blocked.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to update' },
        repo: { type: 'string', description: 'Re-point a misfiled task to a different repo (e.g. old-name → new-name). Empty/whitespace is ignored.' },
        status: { type: 'string', enum: ['pending', 'working', 'review', 'done', 'blocked', 'paused', 'dead_letter'], description: 'Setting pending on a blocked/dead_letter task replays it — clears the retry ledger for a fresh attempt chain.' },
        priority: { type: 'string', enum: ['P0', 'P1', 'P2', 'P3'] },
        assignedAgent: { type: 'string' },
        recommendedModel: { type: 'string' },
        prUrl: { type: 'string' },
        notes: { type: 'string' },
        telegramMessageId: { type: 'number' },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'tasks_next',
    description: 'Get the highest-priority pending task (P0 first, then oldest). Optionally filter by repo.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Optional repo filter' },
      },
    },
  },
  {
    name: 'tasks_claim',
    description: 'Atomically claim the highest-priority pending task (P0 first, then oldest), flipping it pending→working in a single findOneAndUpdate. Cross-machine safe: when two runners fire concurrently against the same queue, exactly one wins each task — no double-pick. Sets claimedBy/claimedAt/leaseUntil for stale-runner reclaim. Returns the claimed task, or {claimed:false} when nothing is claimable. Use this from the runner instead of tasks_list + tasks_update.',
    inputSchema: {
      type: 'object',
      properties: {
        claimedBy: { type: 'string', description: 'Identifies the claiming runner/slot, e.g. "runner-host/slot-0"' },
        taskId: { type: 'string', description: 'Claim a specific task by ID (optional)' },
        repo: { type: 'string', description: 'Restrict the claim to one repo (optional)' },
        ignoreRepos: { type: 'array', items: { type: 'string' }, description: 'Repos to exclude from the claim (no-autonomous-schedule consent list)' },
        leaseSeconds: { type: 'number', description: 'Lease TTL in seconds (default 3600); a working task past leaseUntil is reclaimable' },
      },
      required: ['claimedBy'],
    },
  },
  {
    name: 'tasks_fail',
    description: 'Record a genuine runner failure (dead-letter queue + bounded retry-with-backoff). Bumps the task\'s retry ledger: while under maxRetries (default 3) releases it back to pending with an exponential-backoff nextRetryAt (5m, 10m, 20m, … capped at 6h) so claimTask/tasks_claim won\'t re-pick it before then. Once retries are exhausted, sets status to dead_letter instead of looping or vanishing — surfaced on the dashboard for operator triage. Use this from the runner\'s genuine-failure branch INSTEAD OF tasks_update {status:"blocked"}.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID that failed' },
        error: { type: 'string', description: 'Failure detail (exit code, error summary, or 3-strikes postmortem) — stored as lastError/notes' },
      },
      required: ['taskId', 'error'],
    },
  },
  // ── DISTRIBUTED TRACING (gateway→runner→agent spans) ──────
  {
    name: 'traces_record',
    description: 'Record a completed span in the gateway→runner→agent distributed trace for a task (tracing/tracer.ts). Called by the bash runner (scripts/cli_task_runner.sh) to report its own "runner.dispatch" span (claim→CLI-fire) and the "agent.session" span (the headless claude run), correlated with the gateway\'s own gateway.task_claim/task_update spans via the shared taskId. Never fails the caller — a tracing bug must not break the runner.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID this span belongs to — the trace correlation key' },
        name: { type: 'string', description: 'Span name, e.g. "runner.dispatch" or "agent.session"' },
        service: { type: 'string', enum: ['gateway', 'runner', 'agent'], description: 'Which leg of the chain this span represents' },
        startMs: { type: 'number', description: 'Span start, epoch milliseconds' },
        endMs: { type: 'number', description: 'Span end, epoch milliseconds' },
        status: { type: 'string', enum: ['ok', 'error'], description: 'Span outcome (default ok)' },
        parentName: { type: 'string', description: 'Name of the parent span in the same trace, e.g. "gateway.task_claim"' },
        attributes: { type: 'object', description: 'Free-form attributes (repo, model, exitCode, ...)' },
        error: { type: 'string', description: 'Error detail when status is error' },
      },
      required: ['taskId', 'name', 'service', 'startMs', 'endMs'],
    },
  },
  {
    name: 'traces_list',
    description: 'List recent distributed traces (gateway→runner→agent) or the spans of one trace. Backs the minimal /traces viewer. Pass taskId to fetch one trace\'s spans; omit it to list distinct recent trace IDs.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Fetch spans for this task\'s trace only (optional)' },
        limit: { type: 'number', description: 'Max spans/traces to return (default 100)' },
      },
    },
  },
  // ── STRUCTURED REQUEST LOGGING (correlation ids, gateway→runner→agent) ──
  {
    name: 'logs_record',
    description: 'Record one structured log line into the tenant-scoped log-store ring buffer (monitoring/log-store.ts) that backs the dashboard\'s /logs live-tail viewer. Called by the bash runner (scripts/cli_task_runner.sh) so its own log lines for a task thread onto the SAME correlationId the gateway used for that task\'s HTTP requests (by convention, the taskId). Message and attributes are redacted server-side before storage — never fails the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        correlationId: { type: 'string', description: 'Correlation id to thread this line onto — by convention the taskId for task-related lines' },
        service: { type: 'string', enum: ['gateway', 'runner', 'agent'], description: 'Which leg of the chain this line came from' },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'], description: 'Log level (default info)' },
        message: { type: 'string', description: 'Human-readable log message' },
        attributes: { type: 'object', description: 'Free-form structured fields (repo, taskId, exitCode, ...)' },
      },
      required: ['correlationId', 'service', 'message'],
    },
  },
  {
    name: 'logs_list',
    description: 'Query the tenant-scoped structured log-store ring buffer. Filter by correlationId (reconstructs one task\'s full gateway→runner→agent story), service, level, a text search, or a `since` epoch-ms cursor for live-tail polling.',
    inputSchema: {
      type: 'object',
      properties: {
        correlationId: { type: 'string', description: 'Only entries with this correlation id' },
        service: { type: 'string', enum: ['gateway', 'runner', 'agent'] },
        level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] },
        q: { type: 'string', description: 'Case-insensitive substring match against the message' },
        since: { type: 'number', description: 'Only entries at/after this epoch-ms timestamp (live-tail cursor)' },
        limit: { type: 'number', description: 'Max entries to return (default 200, max 2000)' },
      },
    },
  },
  // ── TASK ARTIFACTS (per-task reviewable output) ───────────
  {
    name: 'artifacts_register',
    description: 'Attach a downloadable artifact (git diff, build/test console output, generated report) to a completed task. Content is capped and compressed server-side. Returns the stored artifact metadata.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID this artifact belongs to' },
        repo: { type: 'string', description: 'Repo the task ran in' },
        kind: { type: 'string', enum: ['diff', 'build-log', 'test-report', 'other'], description: 'Artifact category' },
        filename: { type: 'string', description: 'Suggested filename for download, e.g. "task.diff", "build.log"' },
        contentType: { type: 'string', description: 'MIME type (default text/plain)' },
        content: { type: 'string', description: 'Raw artifact content' },
      },
      required: ['taskId', 'repo', 'kind', 'filename', 'content'],
    },
  },
  {
    name: 'artifacts_list',
    description: 'List artifacts captured for a task (metadata only — no content), newest last.',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: 'Task ID to list artifacts for' },
      },
      required: ['taskId'],
    },
  },
  // ── RUNNER LEASES (ADR-011 slice 3 — fleet-wide concurrency) ──
  {
    name: 'runner_lease_acquire',
    description: 'Acquire one of the N fleet-wide runner-lease slots (N = active Claude accounts, default 2) before starting an autonomous session. Cross-machine safe: slots live in the shared runner_leases collection, so at most N sessions run fleet-wide no matter how many Macs fire. Atomically reclaims a stale slot (crashed runner past leaseUntil) and is idempotent for the same holder. Returns {acquired:true, lease} or {acquired:false} when all slots are validly held — back off, do not start a session.',
    inputSchema: {
      type: 'object',
      properties: {
        holder: { type: 'string', description: 'Runner identity, e.g. "runner-host/12345" (hostname/pid)' },
        machine: { type: 'string', description: 'Hostname, for fleet visibility (optional)' },
        account: { type: 'string', description: 'Claude account/profile bound to this run, e.g. "claude-tech" (optional)' },
        taskId: { type: 'string', description: 'Task being worked under this lease (optional, visibility)' },
        slots: { type: 'number', description: 'Slot-pool size override (default 2 = active accounts)' },
        leaseSeconds: { type: 'number', description: 'Lease TTL in seconds (default 3600 — covers the 45-min session cap with margin)' },
      },
      required: ['holder'],
    },
  },
  {
    name: 'runner_lease_heartbeat',
    description: 'Extend a held runner-lease slot (resets leaseUntil to now + leaseSeconds). Only succeeds while the slot still belongs to this holder; {ok:false} means the lease was reclaimed after going stale — the runner must stop claiming new work. Optionally stamps the taskId being worked.',
    inputSchema: {
      type: 'object',
      properties: {
        holder: { type: 'string', description: 'Runner identity that acquired the slot' },
        slot: { type: 'number', description: 'Slot index returned by runner_lease_acquire' },
        leaseSeconds: { type: 'number', description: 'New TTL in seconds from now (default 3600)' },
        taskId: { type: 'string', description: 'Task being worked (optional, visibility)' },
      },
      required: ['holder', 'slot'],
    },
  },
  {
    name: 'runner_lease_release',
    description: 'Release a held runner-lease slot when the session ends, freeing it for the next fire. Holder-scoped (cannot free a slot another runner reclaimed) and idempotent: releasing an already-released slot returns {released:false}, not an error.',
    inputSchema: {
      type: 'object',
      properties: {
        holder: { type: 'string', description: 'Runner identity that acquired the slot' },
        slot: { type: 'number', description: 'Slot index to release' },
      },
      required: ['holder', 'slot'],
    },
  },
  {
    name: 'runner_lease_list',
    description: 'List runner-lease slots for this tenant: holder, machine, account, taskId, heartbeat, leaseUntil and a stale flag per slot, plus active/max counts. Read-only fleet visibility (dashboard, debugging "why is the runner backing off").',
    inputSchema: {
      type: 'object',
      properties: {
        slots: { type: 'number', description: 'Slot-pool size for the maxSlots readout (default 2)' },
      },
    },
  },
  // ── RUNNER LIVENESS (distinct from runner_lease_* above — a lease only
  // exists mid-session; this is "is the runner process alive at all") ──
  {
    name: 'runner_heartbeat',
    description: 'Record one liveness pulse for a runner machine. Call once per fire, before task pickup, regardless of whether a task gets claimed — this tracks "the runner process is alive", not "there was work to do". Distinct from runner_lease_heartbeat, which only extends a held concurrency slot mid-session.',
    inputSchema: {
      type: 'object',
      properties: {
        machine: { type: 'string', description: 'Hostname the runner fired on, e.g. "runner-host"' },
        holder: { type: 'string', description: 'Runner identity for this fire, e.g. "runner-host/12345" (hostname/pid)' },
      },
      required: ['machine', 'holder'],
    },
  },
  {
    name: 'runner_liveness',
    description: 'Read fleet-wide runner liveness: per-machine last-heartbeat age and a "down" flag once it exceeds thresholdMinutes (default 25 — 2.5x the 10-min fire cadence), plus overall `alive` (true iff any machine heartbeated within threshold). Used by the dashboard "runner down / last seen X ago" banner and the health-alerter.',
    inputSchema: {
      type: 'object',
      properties: {
        thresholdMinutes: { type: 'number', description: 'Liveness threshold in minutes (default 25)' },
      },
    },
  },
  // ── REPOS ─────────────────────────────────────────────
  {
    name: 'repos_list',
    description: 'List all managed repos from managed_repos.txt with health indicators (exists, is git repo, has AI/, has state + handoff).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'repos_status',
    description: 'Detailed status for a repo: current branch, uncommitted file count, ahead/behind counts, last handoff/state modification time.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name or absolute path' },
      },
      required: ['repo'],
    },
  },
  {
    name: 'repos_priority',
    description: 'Rank managed repos by attention needed: open task count, stale handoff, missing AI framework. Highest score first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'repos_scan',
    description: 'Scan a directory to discover git repositories and their tech stacks. Returns discovered repos with name, path, stack detection (Next.js, Express, Docker, MongoDB, TypeScript, Python), and whether the AI framework is already installed. Use to discover repos before registering them.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute directory path to scan' },
        maxDepth: { type: 'number', description: 'Max directory depth to search (default 4)' },
        register: { type: 'boolean', description: 'If true, upsert discovered repos into the caller\'s tenant `repos` DB roster (ADR-021) and append them to managed_repos.txt (default false)' },
      },
      required: ['path'],
    },
  },
  {
    name: 'repos_upsert',
    description: 'ADR-021 Phase 2 — self-register (or refresh) one repo in the caller\'s tenant `repos` DB roster. Used by `myai init` (source: myai-init) and `myai scan --register` (source: scan) so a repo\'s fleet-tracking entry lives under the owning tenant instead of the shared managed_repos.txt.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repo name (unique per tenant)' },
        path: { type: 'string', description: 'Absolute local checkout path' },
        gitRemote: { type: 'string', description: 'Origin remote URL, if any' },
        brainNamespace: { type: 'string', description: 'Brain namespace this repo resolves to' },
        stack: { type: 'array', items: { type: 'string' }, description: 'Detected tech stack tags' },
        group: { type: 'string', description: 'Optional dashboard grouping label' },
        source: { type: 'string', enum: ['seed', 'myai-init', 'scan', 'manual'], description: 'Provenance of this entry (default manual)' },
        enabled: { type: 'boolean', description: 'Whether this repo is active in the roster (default true)' },
      },
      required: ['name', 'path'],
    },
  },
  {
    name: 'get_pr_impact',
    description: 'Blast radius for a change: given a set of changed files (or a base...head git diff), returns every in-repo file transitively affected via the deterministic typed code-edge graph (git-tracked TS/JS/Python, regex-resolved import/calls/tests_of edges — same class of heuristic as scripts/scan_repo_index.py + scripts/code_graph.py, not a real compiler). `affectedFiles` is the import-based blast radius; `callers` surfaces files that call into a changed file even without importing it; `affectedTests` lists tests covering the impacted footprint. Use before re-reading files to reason about a PR/diff\'s reach: unaffected files can be skipped. Aliased/bare-package imports and uncommon call patterns are not resolved, so this is a lower bound on impact.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name (from managed_repos.txt) or absolute path. Defaults to the framework root.' },
        files: { type: 'array', items: { type: 'string' }, description: 'Explicit list of changed file paths (repo-relative). Takes precedence over base/head.' },
        base: { type: 'string', description: 'Base git ref for a diff (used with head if files is omitted)' },
        head: { type: 'string', description: 'Head git ref for a diff (used with base if files is omitted)' },
        maxDepth: { type: 'number', description: 'Max BFS hops to traverse for the blast radius (default 6)' },
      },
    },
  },
  {
    name: 'triage_prs',
    description: 'Rank a set of open PRs by risk/impact using get_pr_impact\'s blast radius plus heuristics (infra/config/schema files touched, source changes with no accompanying test file, no known test coverage anywhere in the impacted footprint per the tests_of edge, blast radius exceeding the depth cap). Highest risk first. Feed the PR-review swarm and the runner\'s pre-claim preflight this instead of re-reading every changed file per PR.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name (from managed_repos.txt) or absolute path. Defaults to the framework root.' },
        prs: {
          type: 'array',
          description: 'Array of {id, label?, files?, base?, head?} — one entry per PR. Each needs either files or both base and head.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              label: { type: 'string' },
              files: { type: 'array', items: { type: 'string' } },
              base: { type: 'string' },
              head: { type: 'string' },
            },
            required: ['id'],
          },
        },
        maxDepth: { type: 'number', description: 'Max BFS hops per PR\'s blast radius (default 6)' },
      },
      required: ['prs'],
    },
  },
  {
    name: 'get_neighbors',
    description: 'Typed neighbors of one node in the deterministic code-edge graph (B-1.5) — a scoped subgraph, not raw files. `node` is a repo-relative file path OR a declared symbol (function/class/const) name, resolved to its declaring file(s). Returns each neighbor\'s edge type (import/calls/tests_of), direction, and file — never file contents. Same-process TS counterpart to scripts/code_graph.py get_neighbors(); use to answer "what does X import/call" or "what calls/imports/tests X" without re-reading files.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name (from managed_repos.txt) or absolute path. Defaults to the framework root.' },
        node: { type: 'string', description: 'Repo-relative file path or a declared symbol name' },
        direction: { type: 'string', enum: ['out', 'in', 'both'], description: 'out = this node\'s outgoing edges, in = incoming, both (default out)' },
        edgeTypes: { type: 'array', items: { type: 'string', enum: ['import', 'calls', 'tests_of'] }, description: 'Subset of edge types to traverse (default all three)' },
      },
      required: ['node'],
    },
  },
  {
    name: 'shortest_path',
    description: 'Shortest typed-edge path between two nodes in the deterministic code-edge graph (B-1.5) — returns the file path chain, not file contents. `src`/`dst` are repo-relative file paths OR declared symbol names (resolved to declaring file(s); ambiguous symbols try every candidate file pair and keep the shortest). BFS over import/calls/tests_of edges, same heuristic class as scripts/code_graph.py shortest_path(). Null path means unreachable within the selected edge types.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name (from managed_repos.txt) or absolute path. Defaults to the framework root.' },
        src: { type: 'string', description: 'Starting repo-relative file path or symbol name' },
        dst: { type: 'string', description: 'Target repo-relative file path or symbol name' },
        edgeTypes: { type: 'array', items: { type: 'string', enum: ['import', 'calls', 'tests_of'] }, description: 'Subset of edge types to traverse (default all three)' },
      },
      required: ['src', 'dst'],
    },
  },
  {
    name: 'plan_list',
    description: 'List the 10-day improvement plan (day-by-day focus schedule) for a repo (or all repos). Each day has a fire time (UTC, ≈9am Sydney), a one-line focus, and a status. Rendered as a table on the dashboard /plan page.',
    inputSchema: {
      type: 'object',
      properties: { repo: { type: 'string', description: 'Repo name (optional — omit for all repos)' } },
    },
  },
  {
    name: 'plan_set',
    description: 'Set/replace a repo\'s multi-day improvement plan. Pass an array of {day, focus, status?} and a startDate; fire times auto-compute (day 1 = startDate at the off-hours default 10:00 UTC ≈ 8pm Sydney, then +1 day each). OFF-HOURS POLICY: any fire time landing in the user\'s weekday interactive window (9am–6pm Sydney) is auto-clamped into the 6pm–9am off-hours band. Use after producing the mythos improvement plan, alongside scheduling the actual tasks via schedule_task.sh.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name' },
        startDate: { type: 'string', description: 'ISO date for day 1 (default: today)' },
        fireHourUtc: { type: 'number', description: 'UTC hour each day fires (default 23 ≈ 9am Sydney AEST)' },
        replace: { type: 'boolean', description: 'Clear existing days first (default false)' },
        days: {
          type: 'array',
          description: 'Array of {day:number, focus:string, status?:enabled|disabled|done|blocked}',
          items: {
            type: 'object',
            properties: {
              day: { type: 'number' },
              focus: { type: 'string' },
              status: { type: 'string', enum: ['enabled', 'disabled', 'done', 'blocked'] },
            },
            required: ['day', 'focus'],
          },
        },
      },
      required: ['repo', 'days'],
    },
  },
  // ── HANDOFF (betaC — first-class handoff store) ──────────
  {
    name: 'handoff_write',
    description: 'Write a session handoff for a repo to the gateway (betaC first-class handoff store). Append-only — each call adds a new entry, building an auditable handoff trail across sessions and machines. Replaces git-syncing AI_AGENT_HANDOFF.md: the next agent reads the latest handoff from the gateway instead of pulling main. Pass the full handoff body in `content` and a one-line "what\'s next" in `summary`.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name the handoff belongs to' },
        content: { type: 'string', description: 'Full handoff body (markdown): done / in-progress / next / blockers' },
        summary: { type: 'string', description: 'One-line "what\'s next" headline (optional)' },
        author: { type: 'string', description: 'Agent/profile/machine that wrote it (optional)' },
        branch: { type: 'string', description: 'Git branch the handoff was written from (optional)' },
        machine: { type: 'string', description: 'Hostname the session ran on (optional)' },
        sessionId: { type: 'string', description: 'Originating gateway session id (optional)' },
      },
      required: ['repo', 'content'],
    },
  },
  {
    name: 'handoff_read',
    description: 'Read the latest session handoff for a repo from the gateway (betaC first-class handoff store). Returns the most recent entry (the "what\'s next" the next agent needs) plus the total entry count. Pass `history` > 0 to also get that many recent entries (newest first). Omit `repo` to list the latest handoff for every repo the tenant has.',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Repo name (omit to list the latest handoff per repo)' },
        history: { type: 'number', description: 'Also return this many recent entries newest-first (default 0 = latest only)' },
        limit: { type: 'number', description: 'When repo is omitted: max repos to list (default 100)' },
      },
    },
  },
  // ── SESSION export / import + cross-session recall (betaC context-SHARING) ─
  {
    name: 'session_export',
    description: 'Export a live or persisted session as a portable bundle so its context can follow the user to another device (betaC context-sharing). Returns a versioned, tenant-owned snapshot (agent, status, full message history, workspace, metadata) — prefers the durable DB copy, falls back to the in-memory cache. Pass the bundle to `session_import` on the other device.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Id of the session to export' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'session_import',
    description: 'Import a session bundle produced by `session_export` so context follows the user across devices (betaC context-sharing). The session is stamped with the importing tenant (a bundle can never smuggle a foreign tenant), loaded into the live cache and persisted. By default a fresh session id is minted so cross-device imports never collide; set `preserveId` to keep the original id (idempotent same-device re-import).',
    inputSchema: {
      type: 'object',
      properties: {
        bundle: { type: 'object', description: 'The export bundle returned by session_export ({ version, exportedAt, session })' },
        preserveId: { type: 'boolean', description: 'Keep the bundle\'s original session id and update in place instead of minting a new one (default false)' },
      },
      required: ['bundle'],
    },
  },
  {
    name: 'session_recall',
    description: 'Recall the tenant\'s recent sessions into a single ready-to-inject context block so a fresh session — typically on another device — resumes with continuity (betaC context-sharing). Returns the recent sessions (agent, status, recent messages) plus a markdown `digest`. Filter to one agent with `agentName`.',
    inputSchema: {
      type: 'object',
      properties: {
        agentName: { type: 'string', description: 'Only recall sessions for this agent (optional)' },
        limit: { type: 'number', description: 'Max sessions to recall (default 5)' },
        perSessionMessages: { type: 'number', description: 'Recent messages to include per session (default 4)' },
      },
    },
  },
  {
    name: 'context_boot',
    description: 'Fetch the betaC boot bundle ON DEMAND — the tight, token-budgeted OPERATOR BRIEF a blank agent needs to greet the operator and continue the work. Returns `bundle` (rendered markdown) plus `brief` structured as who / state / handoff / next: WHO you are working with, the STATE (active project), the last HANDOFF summary, and what comes NEXT from the active plan. This is the callable form of the auto-boot the gateway injects on MCP `initialize`: use it from the wrap-it tier (a blank ChatGPT/Ollama via a thin shim that cannot read InitializeResult.instructions) or to RE-fetch a fresh bundle mid-session. CHEAP BY DESIGN: with no `query` it returns only the tight brief and runs NO search. Pass a `query` to LAZILY pull deeper context — one capped semantic search whose short snippet pointers are returned under `deeper` — so depth is opt-in and auto-boot fixes token-burn instead of recreating it. For full depth, follow the returned `lazyRecall` tools (handoff_read / recall_session / memory_search).',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Override the active project (default: highest-priority repo, else master)' },
        query: { type: 'string', description: 'Focus query — when present, lazily pulls deeper RAG context into `deeper` (omit to keep the bundle a tight, zero-search summary)' },
        expandLimit: { type: 'number', description: 'Max deeper snippets when `query` is set (default 4, hard cap 8)' },
        crossProject: { type: 'boolean', description: 'Search the whole tenant memory (global layer) instead of just the active project (default false)' },
        budget: { type: 'number', description: 'Char budget for the tight summary (default BETAC_BUDGET_CHARS / 1800)' },
      },
    },
  },
  {
    name: 'continuity_stats',
    description: 'The cold-start tokens-saved meter. Every context_boot bundle, brain_delta catch-up, and memory_context block the gateway serves is metered (estimated tokens = the re-teaching cost the operator avoided); this tool returns the tenant-scoped rollup: month-to-date and all-time boots + tokens saved, split by serving tool, plus `coldStart` — the today-vs-brain comparison (avg tokens per session start on the brain path vs the measured legacy file-read baseline). Surfaced on the dashboard /analytics page and in `myai status` — the headline continuity number ("myAI saved N tokens this month").',
    inputSchema: {
      type: 'object',
      properties: {
        repo: { type: 'string', description: 'Scope the rollup to one repo (optional; default: whole tenant)' },
      },
    },
  },
  {
    name: 'user_savings',
    description: 'Per-user cumulative cold-start savings + the shareable "myAI saved me N tokens / $X this month" figure. Returns month-to-date and all-time tokens saved with their USD value (cold-start tokens priced at the input-token tier the model would otherwise re-ingest). Pass `userId` to scope to one tenant member (the share-card number); omit it for the whole-tenant total plus a month-to-date per-member breakdown (`byUser`, highest first). Powers the dashboard /savings view and the /savings/card share image.',
    inputSchema: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'Scope to one tenant member (optional; default: whole-tenant total + per-member breakdown)' },
      },
    },
  },
  {
    name: 'activation_funnel',
    description: 'The activation funnel — privacy-respecting product analytics with NO third-party tracker. Returns the tenant\'s own onboarding journey (steps signup → init → first_brain_boot → first_brain_delta → wrapup_merge, which are reached, when, and activation %). Pass `fleet:true` for the operator/product rollup instead: distinct tenants at each step, per-step conversion, and the headline `activationRate` (activated ÷ signed-up). Pass `selfServe:true` for the plain sellable-product view instead: signup → init → first task shipped → retained (2nd task shipped), with the headline `conversionRate` (retained ÷ signed-up) — the self-serve conversion number, distinct from the continuity-aha activation rate. Milestones are stamped first-touch from existing gateway chokepoints (ADR-014 usage-metering write path) and surfaced on the dashboard /analytics page.',
    inputSchema: {
      type: 'object',
      properties: {
        fleet: { type: 'boolean', description: 'Return the cross-tenant fleet rollup + activation rate instead of this tenant\'s own journey (operator view; default false)' },
        sinceDays: { type: 'number', description: 'For the fleet rollup only — bound to tenants whose milestone occurred in the last N days (optional)' },
        selfServe: { type: 'boolean', description: 'Return the self-serve conversion funnel instead (signup → init → first task shipped → retained); takes precedence over `fleet` (default false)' },
      },
    },
  },
  {
    name: 'perf_stats',
    description: 'Gateway hot-path performance meter. Every MCP tool call is timed at the single executeTool chokepoint; this returns the live in-process rollup: per-tool count / avg / p50 / p95 / p99 / max latency (ms), the aggregate p95, a slow-query log of the most recent calls over the slow threshold (default 500ms, MYAI_SLOW_QUERY_MS), and `hotPaths` (the tools accumulating the most slow hits). Surfaced on the dashboard /analytics "Gateway performance" card. In-process + bounded — no DB write on the hot path, so it never adds latency; state resets on gateway restart (this is a live operational meter, not a historical store).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slo_status',
    description: 'Per-route SLO alerting status. Returns the active SLO configuration (default p95-latency + error-rate thresholds, per-route overrides, min-sample floor, cooldown), and — evaluating the live perf meter right now — the routes currently breaching their SLO. The gateway fires cooldown-guarded Telegram alerts on breach (via the notification engine); this tool is the read-only view of that alerter. Disable alerting with SLO_ALERTS_DISABLED=1; tune with MYAI_SLO_P95_MS / MYAI_SLO_ERROR_RATE_PCT / MYAI_SLO_ROUTES (JSON per-route overrides) / MYAI_SLO_MIN_SAMPLES / MYAI_SLO_COOLDOWN_MIN.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'repos_card_list',
    description: 'List the app-directory cards for every tracked repo — the one-point pointer showing each app\'s localhost address, app/api URLs, MongoDB (non-secret label), Vercel/DNS URLs, short description, and rolling last-update status. Populated by each repo on `wrap up`.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'repos_card_upsert',
    description: 'Create or update THIS repo\'s app-directory card. Only provided fields are written (partial update), so a wrap-up can refresh just the status without clobbering the URLs. Store NON-SECRET values only for `mongo` (e.g. host + db name, never a connection string with credentials).',
    inputSchema: {
      type: 'object',
      properties: {
        repoName: { type: 'string', description: 'Repo name (unique key, e.g. git basename)' },
        description: { type: 'string', description: 'Short one-line description of the app' },
        group: { type: 'string', description: 'Optional grouping label' },
        localhostUrl: { type: 'string', description: 'Local dev address, e.g. http://localhost:3000' },
        appUrl: { type: 'string', description: 'Production app URL' },
        apiUrl: { type: 'string', description: 'API base URL' },
        mongo: { type: 'string', description: 'NON-SECRET Mongo label, e.g. "Atlas cluster0 / db myapp" or "local :27017/myapp"' },
        vercelUrl: { type: 'string', description: 'Vercel deployment URL' },
        dnsUrl: { type: 'string', description: 'Custom domain / DNS URL' },
        lastStatus: { type: 'string', description: 'Rolling status free-text (git summary / what last shipped)' },
        lastStatusLevel: { type: 'string', enum: ['ok', 'warn', 'error', 'unknown'], description: 'Status dot colour' },
        reportedBy: { type: 'string', description: 'Agent/profile updating the card' },
        commitsAhead: { type: 'number', description: '`git rev-list --count origin/main..origin/test` — how many unshipped commits are sitting on test' },
      },
      required: ['repoName'],
    },
  },
  {
    name: 'new_app',
    description: 'Spin up a brand-new app from a plain-English idea: drives agentFlow\'s idea→app pipeline (project create + auto-run codegen→runner bridge) and registers the generated repo in the gateway app-directory so it shows on the dashboard. Backs the `myai new-app "<idea>"` CLI command. Requires AGENTFLOW_URL + AGENTFLOW_TOKEN env for the trigger; the card is registered regardless so the app is always tracked.',
    inputSchema: {
      type: 'object',
      properties: {
        idea: { type: 'string', description: 'Plain-English description of the app to build' },
        name: { type: 'string', description: 'Optional explicit project/repo name (defaults to a slug of the idea)' },
        group: { type: 'string', description: 'Optional directory grouping label (default "Generated")' },
        trigger: { type: 'boolean', description: 'Start agentFlow\'s full auto-run pipeline immediately (default true). When false, only create the project + register the card.' },
      },
      required: ['idea'],
    },
  },
  // ── CONNECTORS (bundled MCP connector set + per-tenant manager) ──
  {
    name: 'connectors_list',
    description: 'List this tenant\'s MCP connectors — the curated bundled set (betaC gateway, Context7, shadcn/ui, Playwright, GitHub, Vercel, Dropbox) plus any custom connectors. Auto-seeds the bundle on first read so a fresh install is never empty. Each entry shows transport (http/stdio), enabled state, source (bundled/custom), and any env vars (e.g. a GitHub PAT) the operator still needs to supply.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'connectors_seed_defaults',
    description: 'Seed (or refresh) the curated default MCP connector bundle for this tenant so a fresh betaC install has working connectors day one. Idempotent — bundled catalog fields are refreshed but an existing connector\'s enabled toggle is preserved. Returns counts of newly seeded vs already present.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'connectors_set',
    description: 'Create or update a connector. For a CUSTOM connector supply transport + url (http) or command/args (stdio). For a BUNDLED connector you can pass just {key, enabled} to toggle it without resupplying catalog fields.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Connector slug (also the key under mcpServers in .mcp.json)' },
        label: { type: 'string', description: 'Display label' },
        category: { type: 'string', description: 'framework | docs | design | browser | vcs | deploy | storage | custom' },
        transport: { type: 'string', enum: ['http', 'stdio'], description: 'http (url) or stdio (command/args)' },
        description: { type: 'string' },
        url: { type: 'string', description: 'http transport — MCP endpoint URL' },
        command: { type: 'string', description: 'stdio transport — launch command, e.g. npx' },
        args: { type: 'array', items: { type: 'string' }, description: 'stdio transport — command args' },
        env: { type: 'object', description: 'Env passed to the server / http headers (values may be ${VAR})' },
        requiresEnv: { type: 'array', items: { type: 'string' }, description: 'Env var names the operator must supply' },
        enabled: { type: 'boolean', description: 'Whether the connector is active' },
      },
      required: ['key'],
    },
  },
  {
    name: 'connectors_toggle',
    description: 'Enable or disable a connector by key. Convenience over connectors_set for the dashboard toggle.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        enabled: { type: 'boolean' },
      },
      required: ['key', 'enabled'],
    },
  },
  {
    name: 'connectors_remove',
    description: 'Remove a connector. Custom connectors are deleted; bundled connectors are disabled instead (a re-seed would otherwise bring them back). Returns whether it was removed vs disabled.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'connectors_mcp_config',
    description: 'Build an .mcp.json-shaped object from this tenant\'s ENABLED connectors — the artifact a scaffolded project or CLI session consumes to get working connectors day one.',
    inputSchema: { type: 'object', properties: {} },
  },
  // ── FLEET RUN (morning "agent mode -resume all" console) ──
  {
    name: 'fleet_run_start',
    description: 'Open a fleet morning-sweep run. The master repo aggregates each managed repo\'s overnight state (commits / open PRs / runner activity / queued review+blocked tasks) into repos[] with a per-repo recommendation. Renders live on the dashboard /fleet page. Keyed by runId (re-running the same runId replaces it).',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string', description: 'Unique run id, e.g. "fleet-20260616-0830"' },
        type: { type: 'string', description: 'Run type (default morning-resume-all)' },
        machine: { type: 'string', description: 'Hostname the sweep ran on' },
        agent: { type: 'string', description: 'Agent/profile that opened the run' },
        repos: {
          type: 'array',
          description: 'Per-repo overnight state + recommendation',
          items: {
            type: 'object',
            properties: {
              repo: { type: 'string' },
              group: { type: 'string' },
              overnight: { type: 'string', description: 'One-line overnight summary' },
              recommendation: { type: 'string', description: 'ship | review | merge | fix | wrap-up | idle | attention' },
              branch: { type: 'string' },
              ahead: { type: 'number', description: 'commits test is ahead of main' },
              uncommitted: { type: 'number' },
              openPrs: { type: 'number' },
              reviewTasks: { type: 'number' },
              blockedTasks: { type: 'number' },
            },
            required: ['repo'],
          },
        },
      },
      required: ['runId', 'repos'],
    },
  },
  {
    name: 'fleet_run_repo_update',
    description: 'Update ONE repo\'s live progress within a fleet run as the operator approves and the agent executes an action (merge/fix/test/ship/wrap-up). Flips actionStatus and appends a detail line so the dashboard /fleet page reflects work in realtime.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        repo: { type: 'string' },
        decision: { type: 'string', description: 'What the operator chose' },
        action: { type: 'string', description: 'ship | fix | merge | test | wrap-up | skip' },
        actionStatus: { type: 'string', enum: ['pending', 'in-progress', 'done', 'failed', 'skipped'] },
        detail: { type: 'string', description: 'Rolling progress / result line' },
        prUrl: { type: 'string' },
        recommendation: { type: 'string' },
      },
      required: ['runId', 'repo'],
    },
  },
  {
    name: 'fleet_run_finish',
    description: 'Close a fleet run (status completed or aborted) and stamp the final summary.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        status: { type: 'string', enum: ['completed', 'aborted'] },
      },
      required: ['runId'],
    },
  },
  {
    name: 'fleet_run_latest',
    description: 'Get the most recent fleet run (what the dashboard /fleet page shows). Returns null if no run yet.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fleet_run_list',
    description: 'List recent fleet runs (history of morning sweeps), most recent first.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max runs (default 20)' } },
    },
  },
  // ── AGENTS / SKILLS ───────────────────────────────────
  {
    name: 'agents_list',
    description: 'List all loaded specialist agents with name, category, description, and tool count.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by category (core, swarm, dev, analysis, neural, github, ops, data, content)' },
      },
    },
  },
  {
    name: 'skills_list',
    description: 'List all loaded skills with name, description, and trigger keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Filter to skills owned by a specific agent (optional)' },
      },
    },
  },
  {
    name: 'agents_invoke',
    description: 'Invoke a specialist agent with a task message. Loads the agent\'s instructions as the system prompt, calls the configured LLM provider, and returns the response. Optionally injects memory_context for the target repo to ground the answer in current state.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Agent name (e.g. solution-architect, security-specialist)' },
        message: { type: 'string', description: 'Task or question to send to the agent' },
        repo: { type: 'string', description: 'Repo name for memory context lookup (optional)' },
        includeMemoryContext: { type: 'boolean', description: 'Prepend memory_context block to the message (default false). Requires repo.' },
        maxTokens: { type: 'number', description: 'Max output tokens (default 4096)' },
        tier: { type: 'string', enum: ['budget', 'standard', 'premium', 'ultra', 'fable', 'kimi'], description: 'Explicit routing tier override (optional). Default: determined by agent name.' },
      },
      required: ['agent', 'message'],
    },
  },
  {
    name: 'skills_invoke',
    description: 'Invoke a skill with a task message. Loads the skill\'s playbook as the system prompt, calls the configured LLM provider, and returns the response.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill name (e.g. owasp-audit, code-review)' },
        message: { type: 'string', description: 'Task or question to apply the skill to' },
        maxTokens: { type: 'number', description: 'Max output tokens (default 4096)' },
        tier: { type: 'string', enum: ['budget', 'standard', 'premium', 'ultra', 'fable', 'kimi'], description: 'Explicit routing tier override (optional). Default: determined by skill context.' },
      },
      required: ['skill', 'message'],
    },
  },
  // ── SCHEDULES ─────────────────────────────────────────
  {
    name: 'schedules_list',
    description: 'List schedules sorted by nextRun. Filter by enabled, kind (agent|skill|tool), or last run status.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Filter by enabled flag (optional)' },
        kind: { type: 'string', enum: ['agent', 'skill', 'tool'], description: 'Filter by dispatch kind (optional)' },
        status: { type: 'string', enum: ['never', 'success', 'error'], description: 'Filter by last run status (optional)' },
        limit: { type: 'number', description: 'Max results (default 100)' },
      },
    },
  },
  {
    name: 'schedules_create',
    description: 'Create a new scheduled dispatch. kind=agent invokes a specialist via agents_invoke; kind=skill invokes a skill via skills_invoke; kind=tool dispatches an MCP tool directly with args parsed from the message field as JSON. Validates cron expression and computes nextRun.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Human-readable name' },
        cronExpr: { type: 'string', description: '5-field cron expression (min hour day month dow), e.g. "0 9 * * *" for 09:00 daily' },
        kind: { type: 'string', enum: ['agent', 'skill', 'tool'], description: 'Dispatch kind: agent | skill | tool' },
        target: { type: 'string', description: 'Agent/skill/tool name to dispatch (e.g. solution-architect, code-review, morning_sweep)' },
        message: { type: 'string', description: 'For agent/skill: the prompt. For tool: a JSON-encoded args object (e.g. \'{"topN":3}\')' },
        repo: { type: 'string', description: 'Optional repo for memory context (agent only)' },
        includeMemoryContext: { type: 'boolean', description: 'Inject repo memory context into the message (default false, agent only)' },
        enabled: { type: 'boolean', description: 'Whether the schedule fires (default true)' },
      },
      required: ['name', 'cronExpr', 'kind', 'target', 'message'],
    },
  },
  {
    name: 'schedules_update',
    description: 'Update a schedule by scheduleId. Recomputes nextRun if cronExpr changes. Pass only the fields you want to change.',
    inputSchema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: 'Schedule ID to update' },
        name: { type: 'string' },
        cronExpr: { type: 'string', description: 'New cron expression — if changed, nextRun is recomputed from now' },
        message: { type: 'string' },
        repo: { type: 'string' },
        includeMemoryContext: { type: 'boolean' },
        enabled: { type: 'boolean' },
      },
      required: ['scheduleId'],
    },
  },
  {
    name: 'schedules_run_now',
    description: 'Dispatch a schedule immediately, bypassing nextRun. Updates lastRun/lastStatus but preserves the existing nextRun so the cron cadence is unaffected.',
    inputSchema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: 'Schedule ID to dispatch now' },
      },
      required: ['scheduleId'],
    },
  },
  {
    name: 'schedules_delete',
    description: 'Delete a schedule by scheduleId. Removes it permanently from the queue.',
    inputSchema: {
      type: 'object',
      properties: {
        scheduleId: { type: 'string', description: 'Schedule ID to delete' },
      },
      required: ['scheduleId'],
    },
  },
  {
    name: 'schedules_seed',
    description: 'Idempotently seed the standard default schedules: morning_sweep_daily (09:00 UTC daily) and evening_sweep_daily (18:00 UTC daily), both kind=tool. Matches by name — never duplicates; schedules that already exist are left untouched and reported under "existing". Returns { created, existing, updated }.',
    inputSchema: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'Whether newly seeded schedules fire (default true)' },
      },
    },
  },
  // ── BUDGETS (read-only) ───────────────────────────────
  {
    name: 'budgets_status',
    description: 'Snapshot of the gateway LLM-spend budget: month-to-date and today\'s USD spend, configured caps, downgrade thresholds, and per-channel MTD breakdown when a per-channel cap is configured. Read-only. Returns zero spend with current config when budgets are disabled or MongoDB is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'budgets_breakdown',
    description: 'Spend breakdown by provider, model, and channel. Defaults to month-to-date (UTC). Pass `from`/`to` ISO timestamps to query a different window. Read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO timestamp (UTC) for the start of the window. Defaults to start of current UTC month.' },
        to: { type: 'string', description: 'ISO timestamp (UTC) for the end of the window. Defaults to now.' },
      },
    },
  },
  // ── USAGE METER (product events, read-only — ADR-014 S2) ──
  {
    name: 'usage_summary',
    description: 'Product-usage meter (UsageEvent): summed quantity per group key for the tenant. Unlike budgets_* (LLM spend), this counts billable product units — runner tasks executed, off-hours minutes, apps generated, agents invoked. Group by event `type` (default), `day`, or `repo`. Pass `from`/`to` ISO timestamps to bound the window (half-open [from, to)). Read-only; returns empty totals when metering is disabled or MongoDB is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO timestamp — window start (inclusive).' },
        to: { type: 'string', description: 'ISO timestamp — window end (exclusive).' },
        groupBy: { type: 'string', enum: ['type', 'day', 'repo'], description: "Group key. Defaults to 'type'." },
      },
    },
  },
  // ── SWEEPS / REPORTS ──────────────────────────────────
  {
    name: 'morning_sweep',
    description: 'Daily autonomous sweep: rank managed repos by attention score, ask a specialist agent (default project-manager) for a short brief on each top repo, compose a markdown report, and optionally deliver via Telegram. Designed to run as a cron schedule (kind=tool, target=morning_sweep) or on demand.',
    inputSchema: {
      type: 'object',
      properties: {
        topN: { type: 'number', description: 'How many top-priority repos to brief (default 3)' },
        agent: { type: 'string', description: 'Specialist agent for the per-repo brief (default project-manager)' },
        telegramChatId: { type: 'string', description: 'Telegram chat ID to deliver the report to. Falls back to TELEGRAM_DEFAULT_CHAT env var if omitted.' },
        briefMaxTokens: { type: 'number', description: 'Max tokens per-repo agent brief (default 600)' },
      },
    },
  },
  {
    name: 'evening_sweep',
    description: 'Daily evening summary: tasks completed today, LLM spend, repos worked on, and tomorrow\'s priority queue preview. Designed to run as a cron schedule (kind=tool, target=evening_sweep, e.g. "0 21 * * *" for 9pm) or on demand.',
    inputSchema: {
      type: 'object',
      properties: {
        telegramChatId: { type: 'string', description: 'Telegram chat ID for report delivery (optional, falls back to TELEGRAM_DEFAULT_CHAT)' },
        previewTopN: { type: 'number', description: 'How many repos to preview for tomorrow (default 3)' },
      },
    },
  },
  {
    name: 'data_retention_purge',
    description: 'Compliance data-retention sweep: deletes terminal-state Task rows past TASK_RETENTION_DAYS (default 90), terminal-state PlanDay rows past PLAN_RETENTION_DAYS (default 180), and audit-log day-files past AUDIT_RETENTION_DAYS (default 400). Any tenant flagged legalHold=true is excluded entirely from every collection. Designed to run as a daily cron schedule (kind=tool, target=data_retention_purge) or on demand.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ── HEALTH / MONITORING ──────────────────────────────
  {
    name: 'health_status',
    description: 'Comprehensive health check of the AI Management gateway and framework. Returns: gateway uptime, MongoDB connection status, vector corpus size, active schedules count, LLM provider status with resilience data (circuit breaker states, rate limiter stats), channel statuses, managed repo count, and memory usage. Use for production monitoring and debugging.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'provider_health',
    description: 'Get detailed resilience health for LLM providers. Shows per-provider circuit breaker state (closed/open/half-open), failure/success counts, rate limiter token availability, and total acquired/rejected tokens. Optionally filter to a single provider.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Optional provider name to filter: api, deepseek, moonshot, ollama, bridge, direct' },
      },
    },
  },
  {
    name: 'provider_reset',
    description: 'Manually reset a tripped circuit breaker for an LLM provider. Use when a provider has recovered but the circuit breaker has not timed out yet. Requires the provider name.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', description: 'Provider to reset: api, deepseek, moonshot, ollama, bridge, direct' },
      },
      required: ['provider'],
    },
  },
  {
    name: 'provider_maintenance_enter',
    description: 'Operator-initiated: put an LLM provider into maintenance mode for planned work. Distinct from the circuit breaker (which trips automatically on errors) — this is a deliberate drain. In-flight calls are left to finish; the provider reports "draining" until they complete, then "maintenance". New calls for that provider queue behind the gate and fail over to the next provider in the mode chain (recoverable error), or resume once maintenance ends if there is no chain. Reflected in provider_health / health_status for a dashboard banner.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['api', 'deepseek', 'moonshot', 'ollama', 'bridge', 'direct'], description: 'Provider to place into maintenance: api, deepseek, moonshot, ollama, bridge, direct' },
        reason: { type: 'string', description: 'Optional operator-supplied reason (e.g. "planned DeepSeek maintenance window")' },
        operator: { type: 'string', description: 'Optional operator identity, for audit' },
      },
      required: ['provider'],
    },
  },
  {
    name: 'provider_maintenance_exit',
    description: 'End an operator-initiated maintenance window for an LLM provider — resumes normal dispatch and immediately releases any calls queued behind the maintenance gate.',
    inputSchema: {
      type: 'object',
      properties: {
        provider: { type: 'string', enum: ['api', 'deepseek', 'moonshot', 'ollama', 'bridge', 'direct'], description: 'Provider to resume: api, deepseek, moonshot, ollama, bridge, direct' },
      },
      required: ['provider'],
    },
  },
  {
    name: 'fleet_maintenance_enter',
    description: 'Operator kill-switch: pause task claims for every runner across the whole fleet (all repos, all machines) — so the gateway can be safely deployed or autonomous work frozen without killing any runner process. A paused runner simply sees an empty queue on its next fire; nothing crashes or errors. Distinct from provider_maintenance_enter (drains one LLM provider) and per-tenant rate limiting (throttles volume, does not stop claims) — this is a hard stop on all claimTask calls fleet-wide. Idempotent: calling again while already active reschedules reason/operator/resumeAt in place. Optionally schedule an auto-resume with resumeAt (or resumeInMinutes) instead of requiring a manual fleet_maintenance_exit. Reflected in health_status for a dashboard banner.',
    inputSchema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Optional operator-supplied reason (e.g. "gateway redeploy")' },
        operator: { type: 'string', description: 'Optional operator identity, for audit' },
        resumeAt: { type: 'string', description: 'Optional ISO-8601 timestamp to auto-resume at (schedulable maintenance window)' },
        resumeInMinutes: { type: 'number', description: 'Optional shorthand for resumeAt — auto-resume this many minutes from now' },
      },
    },
  },
  {
    name: 'fleet_maintenance_exit',
    description: 'End the fleet-wide maintenance window immediately, resuming task claims for every runner. No-op-safe if the fleet was not paused.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ── ROUTING / DISPATCH ─────────────────────────────────
  {
    name: 'routing_info',
    description: 'Get the current LLM routing decision for a given context. Shows which provider and model would be selected for a specific tier, agent, channel, or tool. Useful for debugging routing decisions and understanding cost implications.',
    inputSchema: {
      type: 'object',
      properties: {
        tier: { type: 'string', enum: ['budget', 'standard', 'premium', 'ultra', 'fable', 'kimi'], description: 'Explicit routing tier (optional)' },
        agent: { type: 'string', description: 'Agent name — affects tier selection (optional)' },
        channelType: { type: 'string', description: 'Channel type: telegram, scheduler, mcp, websocket (optional)' },
        tool: { type: 'string', description: 'MCP tool name being executed (optional)' },
        complexity: { type: 'number', description: 'Task complexity score 0-1 (optional, >= 0.8 upgrades tier)' },
        complexityLevel: { type: 'string', enum: ['trivial', 'low', 'standard', 'high', 'critical'], description: 'Named complexity bucket (plan/jam/multi-lane-distribution.md) — takes priority over agent/channel/tool (optional)' },
        mode: { type: 'string', enum: ['runner', 'interactive'], description: 'Execution mode for complexityLevel resolution — defaults to runner for the scheduler channel, interactive otherwise (optional)' },
      },
    },
  },
  {
    name: 'routing_config',
    description: 'Get the full routing configuration including tier definitions, agent-to-tier mappings, channel overrides, and tool routing rules. Read-only inspection of the LLM routing table for dashboards and debugging.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'dispatch_cycle',
    description: 'Run one autonomous dispatch cycle: picks pending tasks from the queue, selects appropriate specialist agents, dispatches them, and reports results. Used by the scheduler for daily autonomous work or invoked manually. Respects budget caps.',
    inputSchema: {
      type: 'object',
      properties: {
        maxTasks: { type: 'number', description: 'Max tasks to process in this cycle (default 3)' },
        dailySpendCapUsd: { type: 'number', description: 'Skip dispatch if daily spend exceeds this USD amount (optional)' },
        telegramChatId: { type: 'string', description: 'Telegram chat ID for progress notifications (optional)' },
      },
    },
  },
  {
    name: 'inline_execute',
    description: 'In-gateway inline execution lane (ADR-018): run short deterministic pending tasks in-process via a whitelisted tool — no CLI-runner fire and no LLM spend. Only tasks carrying an explicit [inline:<op>] marker (op ∈ reprioritize, health, reindex, seed-schedules, usage-summary, repo-status) are eligible. Feature-flagged (INLINE_EXEC_ENABLED, default off → no-op) and quota-bounded (INLINE_EXEC_QUOTA per rolling window). Ineligible tasks are left for the CLI runner / dispatch worker.',
    inputSchema: {
      type: 'object',
      properties: {
        maxTasks: { type: 'number', description: 'Max eligible tasks to run this cycle, 1-50 (default 10; also bounded by remaining quota)' },
        repo: { type: 'string', description: 'Restrict to one repo (optional)' },
      },
    },
  },
  // ── FLEET / PATTERNS / STANDING AGENTS ───────────────
  {
    name: 'fleet_overview',
    description: 'One-call fleet-wide dashboard: managed repo count + health summary, task queue totals by status, active schedule count, today\'s LLM spend, and top 3 repos needing attention. Ideal for Telegram status checks or quick session starts. Gracefully degrades if DB is unavailable.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'pattern_analyze',
    description: 'Analyze SONA patterns from the memory/patterns/ store. Lists patterns with confidence scores, usage counts, and staleness (days since last used). Sorted by effectiveness (confidence × usageCount). Filter by category, tag, or minimum confidence threshold.',
    inputSchema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'Filter by pattern category (optional)' },
        tag: { type: 'string', description: 'Filter by tag (optional)' },
        minConfidence: { type: 'number', description: 'Minimum confidence threshold 0–1 (default 0)' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'standing_agents_status',
    description: 'Status of all standing agent schedules: which standing agents are configured, their cron expressions, last run time/status, next run time, and whether they are enabled. Cross-references loaded agents against schedules; agents with no schedule are marked "unscheduled".',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ── NOTIFICATIONS ─────────────────────────────────────
  {
    name: 'notifications_send',
    description: 'Send a notification to one or more channels (Telegram, Discord, etc.). Formats the message with a level icon, optional title, and source tag. Falls back gracefully if a channel fails — never throws. Returns per-channel send results.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'The notification content' },
        channels: { type: 'array', items: { type: 'string' }, description: 'Channel types to send to (e.g. ["telegram", "discord"]). Defaults to all enabled channels.' },
        chatId: { type: 'string', description: 'Specific chat/channel ID. Defaults to TELEGRAM_DEFAULT_CHAT or DISCORD_DEFAULT_CHANNEL env vars.' },
        level: { type: 'string', enum: ['info', 'warning', 'error', 'critical'], description: 'Notification level — prefixes with an icon (default: info)' },
        title: { type: 'string', description: 'Optional bold title line' },
        source: { type: 'string', description: 'Where the notification originated (e.g. webhook, health-alert, scheduler)' },
      },
      required: ['message'],
    },
  },
  {
    name: 'notifications_history',
    description: 'Retrieve recent notification history from the database. Returns an empty array if DB is not connected.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries to return (default 20)' },
      },
    },
  },
  {
    name: 'notifications_test',
    description: 'Send a test notification to verify channel connectivity. Sends "Test notification from myAI gateway" with level info.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel to test (default: telegram)' },
      },
    },
  },
  // ── HEALTH ALERTS ────────────────────────────────────
  {
    name: 'health_alerts_status',
    description: 'Get the latest health check result and alerting status. Returns the most recent HealthCheckResult (or null if never run), plus whether alerting is active, the check interval, dedup window, and tracked alert count.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'health_alerts_run',
    description: 'Force an immediate health check cycle. Runs all probes (gateway, MongoDB, LLM providers, repos, scheduler, Docker), evaluates alert deduplication, and sends Telegram alerts for any degraded or unhealthy checks. Returns the full HealthCheckResult.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  // ── BRAIN (git-versioned agent memory — BRAIN B2) ─────
  // Server-side git ops against the brain repo (plan/jam/brain-layer.md).
  // Agents call these tools; they NEVER touch the brain repo directly.
  {
    name: 'brain_status',
    description: 'Brain store status: location, current branch, namespaces, atom counts (sessions/handoffs/memory), open session/idea branches, pending stashes, last commit. The brain is the git-versioned agent memory — sessions = commits, wrap up = merge, main = the consolidated truth agents boot from.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'brain_health',
    description: 'Composite brain health index (BRAIN health-score): ONE 0-100 score + grade (excellent/good/fair/poor) rolling up freshness (days since last brain commit), coverage gaps (namespaces with atoms but no compiled brief/working yet), contradictions (divergent-brain merge/reconcile events in a trailing 30-day window), and recall hit-rate (the recall_session eval harness\'s tracked baseline, when one exists). Also returns the recent trend (recorded snapshots, one-per-hour throttled) so `myai brain status` and the dashboard can render a trend line. Distinct from per-atom recall analytics (most-recalled/staleness heatmap) — this is the one number to watch over time, not a breakdown.',
    inputSchema: {
      type: 'object',
      properties: {
        record: { type: 'boolean', description: 'Append a trend snapshot (default true, throttled to one per hour). Pass false for a read-only preview.' },
      },
    },
  },
  {
    name: 'brain_manifest',
    description: 'Control-plane boot manifest (BRAIN B2): "know where what is without reading it." A tiny table-of-contents over the stores the 3-plane router dispatches against (brain-git, repo-sqlite-index, atlas-vectors — each with its fetch tools), this brain\'s namespaces (name + hasBrief/hasWorking + atom counts, NO bodies), the cross-repo memory atom count, and `freshnessSha` (the brain main HEAD SHA to anchor a later brain_delta({since})). Extends ADR-020\'s tiered topic index one level up — which store/namespace to descend into, not which topic within one. Cheap by construction: directory listings + git rev-parse only, never an atom read.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'brain_explore',
    description: 'Read-only browsable snapshot of the brain for the dashboard /brain explorer: namespaces with per-kind atom counts, a recent slice of the actual atoms (parsed frontmatter, newest first), open stashes with body previews, session/idea branches, recent commits, and the code↔memory provenance recorded on HEAD. Pure inspection — never checks out, merges, or writes.',
    inputSchema: {
      type: 'object',
      properties: {
        atomLimit: { type: 'number', description: 'Max recent atoms to return (default 60, cap 200)' },
        sections: {
          type: 'array',
          items: { type: 'string', enum: ['atoms', 'stashes', 'provenance'] },
          description: 'Which EXPENSIVE sections to compute — one per dashboard tab. Omit for all (default). Namespaces, totals, branches, recent commits and the open-stash count are always returned; these three cost per-atom reads or extra git calls, so an off-tab load can skip them (e.g. [] for Overview, ["provenance"] for the provenance tab).',
        },
      },
    },
  },
  {
    name: 'brain_commit',
    description: 'Commit one append-only memory atom to the brain on the current branch. Atoms are immutable — identical re-writes dedup to a no-op; changed content becomes a NEW atom. kind=memory atoms are cross-repo (omit repo); session/handoff atoms live under their repo namespace (auto-created). Pass code_* to stamp code↔memory provenance (BRAIN B5): which code branch/HEAD SHA/commits this atom is about — brain_blame answers both directions from those stamps. kind=session atoms get a non-blocking quality lint (too short, no decision/next-step signal, or near-duplicate of the prior session atom) — the atom still commits; check the returned `lint.warnings` and prompt for enrichment if non-empty. Distinct from any brain health-score composite index.',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['session', 'handoff', 'memory'], description: 'Atom kind: session block, handoff entry, or cross-repo memory fact' },
        repo: { type: 'string', description: 'Project namespace (required for session/handoff; omit for cross-repo memory)' },
        slug: { type: 'string', description: 'Short human label — slugified into the filename' },
        content: { type: 'string', description: 'The atom body (markdown)' },
        code_repo: { type: 'string', description: 'Provenance: code repo name (defaults to `repo`)' },
        code_branch: { type: 'string', description: 'Provenance: code branch the work happened on (e.g. test)' },
        code_sha: { type: 'string', description: 'Provenance: code HEAD SHA at write time' },
        code_commits: { type: 'array', items: { type: 'string' }, description: 'Provenance: code commit SHAs this session produced' },
      },
      required: ['kind', 'slug', 'content'],
    },
  },
  {
    name: 'brain_stash',
    description: 'Freeze a context payload and walk away: the stash is committed to the brain\'s MAIN branch (not the session branch), so ANY later session — different agent, device, or branch — can brain_pop it and resume. Not git-stash: it survives across processes and machines.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Short label to pop it by later' },
        content: { type: 'string', description: 'The frozen context (markdown): what you were doing, next steps, open questions' },
        repo: { type: 'string', description: 'Project this context belongs to (optional)' },
      },
      required: ['slug', 'content'],
    },
  },
  {
    name: 'brain_pop',
    description: 'Pop the newest brain stash (or the newest one matching slug): returns the frozen context and removes the entry from main with a normal commit. Use after brain_status shows pending stashes.',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Pop the newest stash with this slug (default: newest of all)' },
      },
    },
  },
  {
    name: 'brain_branch',
    description: 'Create or resume a brain branch. kind=idea (default): long-lived parallel thinking context idea/<slug> off main. kind=session: today\'s auto session branch session/<date>-<host>-<slug> (slug acts as the profile, e.g. cli).',
    inputSchema: {
      type: 'object',
      properties: {
        slug: { type: 'string', description: 'Idea slug (idea/<slug>) or session profile (default cli)' },
        kind: { type: 'string', enum: ['idea', 'session'], description: 'Branch family (default: idea)' },
      },
      required: ['slug'],
    },
  },
  {
    name: 'brain_checkout',
    description: 'Check out an existing brain branch: main, session/<...> or idea/<...>. Refuses unknown refs and anything outside those families.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Branch to check out (main | session/* | idea/*)' },
      },
      required: ['ref'],
    },
  },
  {
    name: 'brain_merge',
    description: 'Merge a session or idea branch into main (--no-ff) — what wrap-up calls. Session branches are deleted after the merge; idea branches survive (long-lived). Defaults to the CURRENT branch. Conflicts abort cleanly and leave the branch unmerged.',
    inputSchema: {
      type: 'object',
      properties: {
        branch: { type: 'string', description: 'Branch to merge (default: current branch)' },
      },
    },
  },
  {
    name: 'brain_log',
    description: 'Brain commit history (newest first): sha, date, subject. Scope with ref (branch/sha) and/or path (e.g. repos/<name>/sessions).',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Branch or commit to log from (default: HEAD)' },
        path: { type: 'string', description: 'Limit to a path inside the brain (optional)' },
        limit: { type: 'number', description: 'Max commits (default 20, cap 200)' },
      },
    },
  },
  {
    name: 'brain_diff',
    description: 'What changed between two brain refs (default main..HEAD — what the current session has that main doesn\'t). Returns changed files + shortstat; pass patch=true for the unified diff (truncated at 20k chars).',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Base ref (default: main)' },
        to: { type: 'string', description: 'Target ref (default: HEAD)' },
        path: { type: 'string', description: 'Limit to a path inside the brain (optional)' },
        patch: { type: 'boolean', description: 'Include the unified patch (default false)' },
      },
    },
  },
  {
    name: 'brain_delta',
    description: 'Diff-only catch-up: "what changed in the brain since <sha>?" Pass the last-seen brain main SHA (`since`, remembered from a previous boot/delta) to get ONLY the delta — new atoms (content, capped), commits, and which compiled artifacts changed — a ~300-800 token payload instead of a full re-boot. No/unknown `since` degrades to the blank-agent path: the compiled ~150-token boot brief. Remember the returned `sha` as the next anchor. Scope with `repo` to one namespace (+ cross-repo memory/).',
    inputSchema: {
      type: 'object',
      properties: {
        since: { type: 'string', description: 'Last-seen brain main SHA (omit for the blank-agent brief path)' },
        repo: { type: 'string', description: 'Scope to one repo namespace + cross-repo memory/ (optional)' },
        budget: { type: 'number', description: 'Char budget for atom contents (default 3200 ≈ 800 tokens)' },
      },
    },
  },
  {
    name: 'brain_blame',
    description: 'Code↔memory provenance lookup (BRAIN B5). Forward: pass code_sha (full or ≥7-char prefix) to find the brain commits whose provenance stamps reference that code commit — "what was the agent thinking when it produced commit X", with the atom files (session logs) to read. Reverse: pass ref (a brain branch/commit, e.g. idea/<slug>) to list every code SHA its commits recorded — "what code did this line of thinking produce". Stamps come from brain_commit code_* args.',
    inputSchema: {
      type: 'object',
      properties: {
        code_sha: { type: 'string', description: 'Code commit SHA (or ≥7-char prefix) to trace back to brain commits' },
        ref: { type: 'string', description: 'Brain ref (branch/commit) to list recorded code SHAs for (default HEAD; mutually exclusive with code_sha)' },
        limit: { type: 'number', description: 'Max entries (default 50, cap 200)' },
      },
    },
  },
  {
    name: 'brain_entity',
    description: 'Cross-session ENTITY recall — "what changed about X" (BRAIN B10). A lightweight, deterministic temporal/entity layer over the brain (Graphiti-style: entities + time-stamped "touched" edges, extracted by plain regex — NO per-write LLM, no embeddings, no new storage). Pass `query` to get the entity records whose name matches (case-insensitive substring): each returns its timestamped touches with a snippet from every atom that mentioned it, so you can read what changed each time and when. Omit `query` to list the most-recently-touched entities (a map of what the brain knows). Entity kinds: repo (namespace), file (path mentioned), feature (atom slug + tag-style names), person (@mention), decision (ADR-*). Scope with `repo` and/or `kind`. The verbatim atoms stay the source of truth — this is an augmenting index, computed on read.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Entity name to recall (substring, case-insensitive). Omit for the recently-touched map.' },
        kind: { type: 'string', enum: ['repo', 'file', 'feature', 'person', 'decision'], description: 'Restrict to one entity kind (optional)' },
        repo: { type: 'string', description: 'Scope to one repo namespace + cross-repo memory/ (optional)' },
        limit: { type: 'number', description: 'Max entity records (default 20, cap 200)' },
        touchLimit: { type: 'number', description: 'Max touches per entity (default 25, cap 200)' },
        atomLimit: { type: 'number', description: 'Max recent atoms scanned (default 800, cap 5000)' },
      },
    },
  },
  {
    name: 'brain_timeline',
    description: 'Cross-session TEMPORAL recall — "when did I last touch Y" / recent activity (BRAIN B10). The time-ordered feed over the same lightweight entity index as brain_entity. Pass `entity` to get that entity\'s "touched" edges newest-first plus its first/last-touched timestamps — the direct answer to "when did I last touch Y". Omit `entity` for the recent cross-entity activity feed (optionally scoped by `kind`/`repo`) — a temporal overview of what has been worked on lately. Use `since` (a raw UTC stamp like 20260706T234100Z, e.g. a previous lastTouched) to get only newer events. Deterministic + extractive; augments the verbatim atoms, never replaces them.',
    inputSchema: {
      type: 'object',
      properties: {
        entity: { type: 'string', description: 'Entity to trace (substring, case-insensitive). Omit for the recent-activity feed.' },
        kind: { type: 'string', enum: ['repo', 'file', 'feature', 'person', 'decision'], description: 'Restrict to one entity kind (optional)' },
        repo: { type: 'string', description: 'Scope to one repo namespace + cross-repo memory/ (optional)' },
        since: { type: 'string', description: 'Only events strictly after this UTC stamp (YYYYMMDDTHHMMSSZ) (optional)' },
        limit: { type: 'number', description: 'Max events (default 40, cap 500)' },
        atomLimit: { type: 'number', description: 'Max recent atoms scanned (default 800, cap 5000)' },
      },
    },
  },
  {
    name: 'brain_communities',
    description: 'GraphRAG-style GLOBAL/THEMATIC recall — "what\'s been going on with the auth area" without knowing which entity to ask about (BRAIN B-6, the community-summary half of B10 Graphiti: plan/BRAIN_BUILD_PLAN.md day 8). Builds a timestamped entity co-occurrence graph over the same deterministic entity extraction as brain_entity/brain_timeline (two entities edge-connect when an atom mentions both), runs Leiden-style community detection (Louvain modularity optimization + a connectivity-refinement pass), and returns each community as a compact extractive summary — top entities, repos, active time window, and top co-occurrence edges (each with firstSeen/lastSeen) — largest/most-active first. Pass `query` to filter to communities whose summary or member entities match (substring, case-insensitive) — a thematic search over the community layer instead of scanning every atom. Deterministic + LLM-free, computed on read; augments the verbatim atoms, never replaces them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Thematic filter: match against community summaries/entity names (substring, case-insensitive). Omit for all communities.' },
        repo: { type: 'string', description: 'Scope to one repo namespace + cross-repo memory/ (optional)' },
        minSize: { type: 'number', description: 'Minimum entities per community to include (default 2, cap 50)' },
        limit: { type: 'number', description: 'Max communities returned (default 20, cap 200)' },
        atomLimit: { type: 'number', description: 'Max recent atoms scanned (default 800, cap 5000)' },
      },
    },
  },
  {
    name: 'brain_revert',
    description: 'Undo a brain commit with an inverse commit — history is never rewritten (atoms stay append-only). Merge commits revert against their first parent. Conflicts abort cleanly, leaving the brain unchanged.',
    inputSchema: {
      type: 'object',
      properties: {
        sha: { type: 'string', description: 'Commit to revert' },
      },
      required: ['sha'],
    },
  },
  {
    name: 'brain_search',
    description: 'Federated recall: one ranked query across this tenant\'s brain atoms (sessions, handoffs, and cross-repo memory facts — every repo namespace) AND the RAG session corpus (STATE.md/handoff/archive vectors — every repo) at once. Distinct from per-namespace sharing/read-only grants (which expose ONE namespace to another tenant) — this unions and ranks what one tenant already owns across its OWN multiple repo-brains, so "what have we done about X" doesn\'t require knowing which repo holds the answer. Omit `repo` to federate across all of them; pass it to narrow to one.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword search query' },
        repo: { type: 'string', description: 'Narrow to one repo namespace instead of federating across all (optional)' },
        k: { type: 'number', description: 'Max merged results (default 10, cap 100)' },
        since: { type: 'string', description: 'ISO date (YYYY-MM-DD) — only recall session-corpus vectors on or after this date (optional; atoms are unaffected)' },
        atomLimit: { type: 'number', description: 'Max recent atoms scanned per the brain-atom side (default 500, cap 5000)' },
      },
      required: ['query'],
    },
  },
  // Per-namespace sharing — an OWNER tenant grants ANOTHER tenant scoped
  // read/read-write access to ONE namespace (stored internally under
  // repos/<namespace>, but every tool param below takes the bare namespace
  // name), revocable, with an access list (distinct from team-brain: that
  // shares a WHOLE team namespace with every member of ONE team; this is a
  // single owner→grantee grant, and the grantee is typically a different
  // tenant entirely).
  {
    name: 'brain_namespace_share',
    description: 'Grant another tenant scoped access to ONE of this tenant\'s brain namespaces (the bare namespace name — internally stored under repos/<namespace>, but pass just <namespace>). Role-gated: `configure`. `level` is `read` (browse only) or `read-write` (browse + append atoms). Re-sharing with the same granteeTenantId updates the level and clears any prior revocation — one active grant per (namespace, grantee). Distinct from team-brain (whole-team sharing); this is a single owner→grantee grant, typically cross-tenant.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'The bare namespace name to share (e.g. a repo name) — NOT prefixed with "repos/"' },
        granteeTenantId: { type: 'string', description: 'The tenant being granted access' },
        level: { type: 'string', enum: ['read', 'read-write'], description: 'Access level to grant' },
      },
      required: ['namespace', 'granteeTenantId', 'level'],
    },
  },
  {
    name: 'brain_namespace_unshare',
    description: 'Revoke a previously granted namespace access. Role-gated: `configure`. The grant record is kept with `revokedAt` set (an audit trail, not a delete) — see `brain_namespace_grants`. Throws if the grantee never held a grant on this namespace; a no-op if already revoked.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'The bare namespace name to revoke access to — NOT prefixed with "repos/"' },
        granteeTenantId: { type: 'string', description: 'The tenant whose access is being revoked' },
      },
      required: ['namespace', 'granteeTenantId'],
    },
  },
  {
    name: 'brain_namespace_grants',
    description: 'The access list for one of this tenant\'s namespaces — every grant ever issued (active and revoked), newest first. Role-gated: `read`. Pass `activeOnly` to filter out revoked grants.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'The bare namespace name to list grants for — NOT prefixed with "repos/"' },
        activeOnly: { type: 'boolean', description: 'Filter out revoked grants (default false)' },
      },
      required: ['namespace'],
    },
  },
  {
    name: 'brain_namespace_read',
    description: 'Read a namespace another tenant (`ownerTenantId`) has shared with THIS tenant: the compiled boot brief plus recent session/handoff atoms and counts. Requires an active grant of at least `read` on (ownerTenantId, namespace) — enforced at the gateway boundary against the caller\'s own server-derived tenant identity. Reads only the owner\'s `main` branch (the consolidated truth), never an in-progress session branch.',
    inputSchema: {
      type: 'object',
      properties: {
        ownerTenantId: { type: 'string', description: 'The tenant that owns and shared the namespace' },
        namespace: { type: 'string', description: 'The shared bare namespace name — NOT prefixed with "repos/"' },
        limit: { type: 'number', description: 'Max recent atoms per kind to return (default 5, cap 50)' },
      },
      required: ['ownerTenantId', 'namespace'],
    },
  },
  {
    name: 'brain_namespace_write',
    description: 'Append a session/handoff atom into a namespace another tenant (`ownerTenantId`) has shared with THIS tenant at `read-write` level. Requires an active `read-write` grant on (ownerTenantId, namespace) — a `read`-only grant is refused. The atom is committed into the owner\'s brain, attributed to this tenant in both the frontmatter (`shared-write-by`) and the git commit author.',
    inputSchema: {
      type: 'object',
      properties: {
        ownerTenantId: { type: 'string', description: 'The tenant that owns and shared the namespace' },
        namespace: { type: 'string', description: 'The shared bare namespace name — NOT prefixed with "repos/"' },
        kind: { type: 'string', enum: ['session', 'handoff'], description: 'Atom kind' },
        slug: { type: 'string', description: 'Short human label — slugified into the filename' },
        content: { type: 'string', description: 'The atom body (markdown)' },
      },
      required: ['ownerTenantId', 'namespace', 'kind', 'slug', 'content'],
    },
  },
  // Hosted brain remote — the managed, tenant-scoped git remote the gateway
  // provisions per tenant (ADR-017). Opt-in Pro/Team upsell; self-host stays
  // the default. Agents/dashboard call these; the transport route is separate.
  {
    name: 'brain_host_provision',
    description: 'Provision (or adopt) this tenant\'s HOSTED brain remote — a managed, gateway-served, tenant-scoped git repo the brain pushes to, so users who won\'t self-host git get turnkey cross-device continuity (ADR-017). Gated on the plan\'s hosted-brain entitlement (Pro/Team; free tier is refused). Returns the remote URL and a one-time access token (the token is never persisted — store it now; use brain_host_rotate to reissue). Point the brain at it once with `brain init --remote <url>` / `git remote set-url origin <url>`; sync is invisible thereafter. Self-host remains the default (data-locality).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'brain_host_status',
    description: 'This tenant\'s hosted brain remote status (ADR-017): whether provisioned, the display remote URL (no credential), plan, created/rotated timestamps, encryption-at-rest posture, and quota (used vs plan cap). No secret material is returned.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'brain_host_rotate',
    description: 'Rotate this tenant\'s hosted brain access token (ADR-017) — mints a fresh token and invalidates the old one (leak response / reissue). Returns the new remote URL + one-time token; update the brain\'s origin URL to match.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// ── Tool Implementations ──────────────────────────────────

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext = SYSTEM_CONTEXT,
): Promise<unknown> {
  log.info({ tool: name, tenantId: ctx.tenantId }, 'Executing MCP tool');

  // ADR-010 §3.4: enforce a resolved tenant when enforcing, and ALWAYS strip a
  // caller-supplied `tenantId` from args so only the server-derived `ctx` is
  // trusted. (Day-2 scoped stores consume `ctx` via getTenantScope.)
  if (getConfig().tenancy?.enforce && !ctx?.tenantId) {
    throw new AuthError('no tenant in context', 401, 'NO_TENANT_CONTEXT');
  }
  args = stripTenantFromArgs(args);

  // The tenant every scoped store call is filtered by — server-derived, never
  // from args. Handlers that touch scoped collections take it as a leading param.
  const tenantId = ctx.tenantId;

  // Hot-path latency meter (perf-metrics): time every dispatch at this single
  // chokepoint so tasks_claim / context_boot / brain_delta and every other tool
  // land in the p95 + slow-query log surfaced on /analytics. Recording is
  // in-process and cannot throw, so it never slows the call it measures.
  const perfStart = performance.now();
  let perfError = false;
  try {
    return await dispatchTool(name, tenantId, args, ctx);
  } catch (err) {
    perfError = true;
    throw err;
  } finally {
    recordToolLatency(name, performance.now() - perfStart, { tenantId, error: perfError });
  }
}

async function dispatchTool(
  name: string,
  tenantId: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  switch (name) {
    case 'memory_search': return handleMemorySearch(tenantId, args);
    case 'recall_session': return handleRecallSession(tenantId, args);
    case 'memory_store': return handleMemoryStore(tenantId, args);
    case 'memory_context': return handleMemoryContext(tenantId, args);
    case 'memory_stats': return handleMemoryStats(tenantId, args);
    case 'memory_reindex': return handleMemoryReindex(tenantId, args);
    case 'state_read': return handleStateRead(args);
    case 'state_update': return handleStateUpdate(args);
    case 'tasks_list': return handleTasksList(tenantId, args);
    case 'tasks_create': return handleTasksCreate(tenantId, args, ctx);
    case 'tasks_update': return handleTasksUpdate(tenantId, args);
    case 'tasks_next': return handleTasksNext(tenantId, args);
    case 'tasks_claim': return handleTasksClaim(tenantId, args);
    case 'tasks_fail': return handleTasksFail(tenantId, args);
    case 'traces_record': return handleTracesRecord(args);
    case 'traces_list': return handleTracesList(args);
    case 'logs_record': return handleLogsRecord(tenantId, args);
    case 'logs_list': return handleLogsList(tenantId, args);
    case 'artifacts_register': return handleArtifactsRegister(tenantId, args);
    case 'artifacts_list': return handleArtifactsList(tenantId, args);
    case 'runner_lease_acquire': return handleRunnerLeaseAcquire(tenantId, args);
    case 'runner_lease_heartbeat': return handleRunnerLeaseHeartbeat(tenantId, args);
    case 'runner_lease_release': return handleRunnerLeaseRelease(tenantId, args);
    case 'runner_lease_list': return handleRunnerLeaseList(tenantId, args);
    case 'runner_heartbeat': return handleRunnerHeartbeat(tenantId, args);
    case 'runner_liveness': return handleRunnerLiveness(tenantId, args);
    case 'repos_list': return handleReposList(tenantId);
    case 'repos_status': return handleReposStatus(args);
    case 'repos_priority': return handleReposPriority(tenantId);
    case 'repos_scan': return handleReposScan(tenantId, args);
    case 'repos_upsert': return handleReposUpsert(tenantId, args);
    case 'get_pr_impact': return handleGetPrImpact(args);
    case 'triage_prs': return handleTriagePrs(args);
    case 'get_neighbors': return handleGetNeighbors(args);
    case 'shortest_path': return handleShortestPath(args);
    case 'repos_card_list': return handleReposCardList(tenantId);
    case 'repos_card_upsert': return handleReposCardUpsert(tenantId, args);
    case 'new_app': return handleNewApp(tenantId, args);
    case 'connectors_list': return handleConnectorsList(tenantId);
    case 'connectors_seed_defaults': return handleConnectorsSeed(tenantId);
    case 'connectors_set': return handleConnectorsSet(tenantId, args, ctx);
    case 'connectors_toggle': return handleConnectorsToggle(tenantId, args, ctx);
    case 'connectors_remove': return handleConnectorsRemove(tenantId, args, ctx);
    case 'connectors_mcp_config': return handleConnectorsMcpConfig(tenantId);
    case 'plan_list': return handlePlanList(tenantId, args);
    case 'plan_set': return handlePlanSet(tenantId, args);
    case 'handoff_write': return handleHandoffWrite(tenantId, args);
    case 'handoff_read': return handleHandoffRead(tenantId, args);
    case 'session_export': return handleSessionExport(tenantId, args);
    case 'session_import': return handleSessionImport(tenantId, args);
    case 'session_recall': return handleSessionRecall(tenantId, args);
    case 'context_boot': return handleContextBoot(tenantId, args);
    case 'continuity_stats': return handleContinuityStats(tenantId, args);
    case 'user_savings': return handleUserSavings(tenantId, args);
    case 'activation_funnel': return handleActivationFunnel(tenantId, args);
    case 'perf_stats': return handlePerfStats();
    case 'slo_status': return handleSloStatus();
    case 'fleet_run_start': return handleFleetRunStart(tenantId, args);
    case 'fleet_run_repo_update': return handleFleetRunRepoUpdate(tenantId, args);
    case 'fleet_run_finish': return handleFleetRunFinish(tenantId, args);
    case 'fleet_run_latest': return handleFleetRunLatest(tenantId);
    case 'fleet_run_list': return handleFleetRunList(tenantId, args);
    case 'agents_list': return handleAgentsList(args);
    case 'skills_list': return handleSkillsList(args);
    case 'agents_invoke': return handleAgentsInvoke(tenantId, args);
    case 'skills_invoke': return handleSkillsInvoke(args);
    case 'schedules_list': return handleSchedulesList(tenantId, args);
    case 'schedules_create': return handleSchedulesCreate(tenantId, args);
    case 'schedules_update': return handleSchedulesUpdate(tenantId, args);
    case 'schedules_run_now': return handleSchedulesRunNow(ctx, args);
    case 'schedules_delete': return handleSchedulesDelete(tenantId, args);
    case 'schedules_seed': return handleSchedulesSeed(args);
    case 'morning_sweep': return handleMorningSweep(args);
    case 'evening_sweep': return handleEveningSweep(args);
    case 'data_retention_purge': return handleDataRetentionPurge();
    case 'budgets_status': return handleBudgetsStatus(tenantId);
    case 'budgets_breakdown': return handleBudgetsBreakdown(tenantId, args);
    case 'usage_summary': return handleUsageSummary(tenantId, args);
    case 'health_status': return handleHealthStatus(tenantId);
    case 'provider_health': return handleProviderHealth(args);
    case 'provider_reset': return handleProviderReset(args);
    case 'provider_maintenance_enter': return handleProviderMaintenanceEnter(args);
    case 'provider_maintenance_exit': return handleProviderMaintenanceExit(args);
    case 'fleet_maintenance_enter': return handleFleetMaintenanceEnter(tenantId, args);
    case 'fleet_maintenance_exit': return handleFleetMaintenanceExit(tenantId);
    case 'routing_info': return handleRoutingInfo(args);
    case 'routing_config': return handleRoutingConfig();
    case 'dispatch_cycle': return handleDispatchCycle(args);
    case 'inline_execute': return handleInlineExecute(tenantId, ctx, args);
    case 'fleet_overview': return handleFleetOverview(tenantId);
    case 'pattern_analyze': return handlePatternAnalyze(args);
    case 'standing_agents_status': return handleStandingAgentsStatus(tenantId);
    case 'notifications_send': return handleNotificationsSend(tenantId, args);
    case 'notifications_history': return handleNotificationsHistory(tenantId, args);
    case 'notifications_test': return handleNotificationsTest(tenantId, args);
    case 'health_alerts_status': return handleHealthAlertsStatus();
    case 'health_alerts_run': return handleHealthAlertsRun();
    case 'brain_status': return handleBrainStatus(tenantId);
    case 'brain_health': return handleBrainHealth(tenantId, args);
    case 'brain_manifest': return handleBrainManifest(tenantId);
    case 'brain_explore': return handleBrainExplore(tenantId, args);
    case 'brain_commit': return handleBrainCommit(tenantId, args);
    case 'brain_stash': return handleBrainStash(tenantId, args);
    case 'brain_pop': return handleBrainPop(tenantId, args);
    case 'brain_branch': return handleBrainBranch(tenantId, args);
    case 'brain_checkout': return handleBrainCheckout(tenantId, args);
    case 'brain_merge': return handleBrainMerge(tenantId, args);
    case 'brain_log': return handleBrainLog(tenantId, args);
    case 'brain_diff': return handleBrainDiff(tenantId, args);
    case 'brain_delta': return handleBrainDelta(tenantId, args);
    case 'brain_blame': return handleBrainBlame(tenantId, args);
    case 'brain_entity': return handleBrainEntity(tenantId, args);
    case 'brain_timeline': return handleBrainTimeline(tenantId, args);
    case 'brain_communities': return handleBrainCommunities(tenantId, args);
    case 'brain_revert': return handleBrainRevert(tenantId, args);
    case 'brain_search': return handleBrainSearch(tenantId, args);
    case 'brain_namespace_share': return handleBrainNamespaceShare(tenantId, args, ctx);
    case 'brain_namespace_unshare': return handleBrainNamespaceUnshare(tenantId, args, ctx);
    case 'brain_namespace_grants': return handleBrainNamespaceGrants(tenantId, args, ctx);
    case 'brain_namespace_read': return handleBrainNamespaceRead(tenantId, args, ctx);
    case 'brain_namespace_write': return handleBrainNamespaceWrite(tenantId, args, ctx);
    case 'brain_host_provision': return handleBrainHostProvision(ctx);
    case 'brain_host_status': return handleBrainHostStatus(ctx);
    case 'brain_host_rotate': return handleBrainHostRotate(ctx);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MEMORY handlers ───────────────────────────────────────

async function handleMemorySearch(tenantId: string, args: Record<string, unknown>) {
  const results = await searchVectors(tenantId, {
    query: args.query as string,
    repo: args.repo as string | undefined,
    source: args.source as IVector['source'] | undefined,
    tags: args.tags as string[] | undefined,
    limit: (args.limit as number) || 10,
  });

  return results.map(r => ({
    repo: r.repo,
    source: r.source,
    content: r.content,
    tags: r.tags,
    score: Math.round(r.score * 1000) / 1000,
    sessionId: r.sessionId,
    createdAt: r.createdAt,
  }));
}

async function handleRecallSession(tenantId: string, args: Record<string, unknown>) {
  const query = args.query as string;
  if (!query) return { error: 'query is required' };

  let since: Date | undefined;
  const sinceRaw = args.since as string | undefined;
  if (sinceRaw) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) return { error: `Invalid 'since' date: ${sinceRaw}` };
    since = d;
  }

  const results = await recallSession(tenantId, {
    query,
    k: (args.k as number) || 5,
    since,
    repo: args.repo as string | undefined,
  });

  return { query, count: results.length, results };
}

async function handleMemoryStore(tenantId: string, args: Record<string, unknown>) {
  const stored = await storeVector(tenantId, {
    repo: args.repo as string,
    source: args.source as IVector['source'],
    content: args.content as string,
    tags: args.tags as string[] | undefined,
    sessionId: args.sessionId as string | undefined,
  });

  return { stored, message: stored ? 'Vector stored successfully' : 'Duplicate content — skipped' };
}

async function handleMemoryContext(tenantId: string, args: Record<string, unknown>) {
  const repo = args.repo as string | undefined;
  if (!repo || typeof repo !== 'string') return { error: 'repo is required' };
  const query = (args.query as string) || `current state of ${repo}`;
  const limit = (args.limit as number) || 5;

  const [stateChunks, handoffChunks, patterns] = await Promise.all([
    searchVectors(tenantId, { query, repo, source: 'state', limit }),
    searchVectors(tenantId, { query, repo, source: 'handoff', limit }),
    searchVectors(tenantId, { query, repo, source: 'pattern', limit }),
  ]);

  const sections: string[] = [`# Context block for ${repo}`, ''];

  if (handoffChunks.length) {
    sections.push('## Recent Handoff');
    for (const c of handoffChunks) sections.push(c.content, '');
  }
  if (stateChunks.length) {
    sections.push('## Relevant State');
    for (const c of stateChunks) sections.push(c.content, '');
  }
  if (patterns.length) {
    sections.push('## Related Patterns');
    for (const p of patterns) sections.push(`- ${p.content}`, '');
  }
  if (sections.length === 2) sections.push('_(no vectors indexed for this repo yet)_');

  const text = sections.join('\n');
  const tokenEstimate = Math.ceil(text.length / 4);
  // Continuity meter: tokens served here are cold-start tokens the operator
  // did not re-teach by hand. Fire-and-forget — never fails the call.
  void recordContextServed(tenantId, { repo, tool: 'memory_context', tokens: tokenEstimate, userId: args.userId as string | undefined });
  return {
    repo,
    query,
    text,
    counts: { state: stateChunks.length, handoff: handoffChunks.length, patterns: patterns.length },
    tokenEstimate,
  };
}

async function handleMemoryStats(tenantId: string, args: Record<string, unknown>) {
  const repo = args.repo as string | undefined;
  const sources: IVector['source'][] = ['state', 'handoff', 'commit', 'pr', 'pattern', 'bug', 'code', 'feature', 'archive'];

  const stats: Record<string, number> = {};
  let total = 0;

  for (const source of sources) {
    const count = await getVectorCount(tenantId, repo, source);
    if (count > 0) stats[source] = count;
    total += count;
  }

  return { repo: repo || 'all', total, bySource: stats };
}

async function handleMemoryReindex(tenantId: string, args: Record<string, unknown>) {
  const scope = (args.scope as string) === 'all' ? 'all' : 'master';
  const results = scope === 'all' ? await indexAllRepos(tenantId) : await indexMasterRepo(tenantId);
  const totals = results.reduce(
    (acc, r) => ({ stored: acc.stored + r.stored, skipped: acc.skipped + r.skipped, failed: acc.failed + r.failed }),
    { stored: 0, skipped: 0, failed: 0 },
  );
  const grandTotal = await getVectorCount(tenantId);
  return { scope, totals, grandTotal, breakdown: results };
}

// ── STATE handlers ────────────────────────────────────────

function resolveRepoStatePath(repo: string | undefined, file: 'state' | 'handoff'): { path: string; repoName: string } {
  const config = getConfig();
  const fileName = file === 'handoff' ? 'AI_AGENT_HANDOFF.md' : 'STATE.md';

  if (!repo || repo === 'ai_management' || repo === 'AI') {
    return { path: resolve(config.aiRoot, 'state', fileName), repoName: 'ai_management' };
  }

  const reposFile = resolve(config.aiRoot, 'config', 'managed_repos.txt');
  if (!existsSync(reposFile)) {
    throw new Error('managed_repos.txt not found');
  }

  const home = process.env.HOME || '/root';
  const repoLines = readFileSync(reposFile, 'utf-8').split('\n');
  const repoPath = repoLines
    .map(l => l.split('#')[0].trim())
    .filter(Boolean)
    .map(l => l.replace(/^~\//, `${home}/`))
    .find(p => p.endsWith(`/${repo}`) || p.includes(`/${repo}/`));

  if (!repoPath) {
    throw new Error(`Repo "${repo}" not found in managed_repos.txt`);
  }

  return { path: resolve(repoPath, 'AI', 'state', fileName), repoName: repo };
}

async function handleStateRead(args: Record<string, unknown>) {
  const repo = args.repo as string | undefined;
  const fileType = ((args.file as string) || 'state') as 'state' | 'handoff';

  let target;
  try { target = resolveRepoStatePath(repo, fileType); }
  catch (err) { return { error: (err as Error).message }; }

  if (!existsSync(target.path)) {
    return { error: `File not found: ${target.path}` };
  }

  const content = readFileSync(target.path, 'utf-8');
  return { file: target.path, content, length: content.length };
}

async function handleStateUpdate(args: Record<string, unknown>) {
  const repo = args.repo as string | undefined;
  const fileType = ((args.file as string) || 'state') as 'state' | 'handoff';
  const heading = args.heading as string | undefined;
  const content = args.content as string;
  const mode = ((args.mode as string) || 'replace') as 'replace' | 'append';

  if (!content) return { error: 'content is required' };

  let target;
  try { target = resolveRepoStatePath(repo, fileType); }
  catch (err) { return { error: (err as Error).message }; }

  if (!existsSync(target.path)) {
    return { error: `File not found: ${target.path}` };
  }

  const original = readFileSync(target.path, 'utf-8');
  let next: string;

  if (!heading) {
    next = original.trimEnd() + '\n\n' + content.trim() + '\n';
  } else {
    const lines = original.split('\n');
    const headingIdx = lines.findIndex(l => l.trim() === heading.trim());

    if (headingIdx === -1) {
      // Append heading + content to end
      next = original.trimEnd() + '\n\n' + heading + '\n\n' + content.trim() + '\n';
    } else {
      // Find next heading of same or higher level (same # count or less)
      const headingLevel = (heading.match(/^#+/) || [''])[0].length;
      let endIdx = lines.length;
      for (let i = headingIdx + 1; i < lines.length; i++) {
        const m = lines[i].match(/^(#+)\s/);
        if (m && m[1].length <= headingLevel) { endIdx = i; break; }
      }

      const before = lines.slice(0, headingIdx + 1).join('\n');
      const after = lines.slice(endIdx).join('\n');
      const currentBody = lines.slice(headingIdx + 1, endIdx).join('\n').trim();
      const newBody = mode === 'append' && currentBody
        ? currentBody + '\n\n' + content.trim()
        : content.trim();

      next = before + '\n\n' + newBody + '\n\n' + after;
      next = next.replace(/\n{3,}/g, '\n\n');
    }
  }

  writeFileSync(target.path, next, 'utf-8');
  return {
    file: target.path,
    repo: target.repoName,
    heading: heading || '(appended)',
    mode,
    bytesWritten: next.length,
    bytesBefore: original.length,
  };
}

// ── TASK handlers ─────────────────────────────────────────

async function handleTasksList(tenantId: string, args: Record<string, unknown>) {
  const tasks = await listTasks(tenantId, {
    repo: args.repo as string | undefined,
    status: args.status as TaskStatus | undefined,
    priority: args.priority as TaskPriority | undefined,
    assignedAgent: args.assignedAgent as string | undefined,
    limit: args.limit as number | undefined,
  });
  return { count: tasks.length, tasks };
}

async function handleTasksCreate(tenantId: string, args: Record<string, unknown>, ctx: ToolContext = SYSTEM_CONTEXT) {
  const repo = args.repo as string | undefined;
  const title = args.title as string | undefined;
  if (!repo || typeof repo !== 'string') return { error: 'repo is required' };
  if (!title || typeof title !== 'string') return { error: 'title is required' };
  // Plan-tier repo hard-cap — mirror the REST POST /api/tasks gate so the cap
  // cannot be bypassed via the MCP surface (the primary tenant interface). Only
  // relevant when `repo` is NEW for the tenant; local-trust / system context is
  // uncapped, exactly as the REST path (ctx.local).
  if (!ctx.local) {
    const known = await tenantRepos(tenantId);
    const verdict = verdictFor('repos', ctx.plan ?? 'free', known.length + (known.includes(repo) ? 0 : 1));
    if (!verdict.allowed) throw new EntitlementError(verdict);
  }
  const task = await createTask(tenantId, {
    repo,
    title,
    description: args.description as string | undefined,
    priority: args.priority as TaskPriority | undefined,
    assignedAgent: args.assignedAgent as string | undefined,
    recommendedModel: args.recommendedModel as string | undefined,
    source: args.source as TaskSource | undefined,
    sourceId: args.sourceId as string | undefined,
    notes: args.notes as string | undefined,
  });
  return task;
}

async function handleTasksUpdate(tenantId: string, args: Record<string, unknown>) {
  if (!args.taskId || typeof args.taskId !== 'string') return { error: 'taskId is required' };
  const task = await updateTask(tenantId, {
    taskId: args.taskId as string,
    repo: args.repo as string | undefined,
    status: args.status as TaskStatus | undefined,
    priority: args.priority as TaskPriority | undefined,
    assignedAgent: args.assignedAgent as string | undefined,
    recommendedModel: args.recommendedModel as string | undefined,
    prUrl: args.prUrl as string | undefined,
    notes: args.notes as string | undefined,
    telegramMessageId: args.telegramMessageId as number | undefined,
  });
  if (!task) return { error: `Task not found: ${args.taskId}` };
  return task;
}

async function handleTasksNext(tenantId: string, args: Record<string, unknown>) {
  const task = await nextTask(tenantId, args.repo as string | undefined);
  if (!task) return { message: 'No pending tasks' };
  const counts = await countTasks(tenantId, { repo: args.repo as string | undefined });
  return { task, queueSummary: counts };
}

async function handleTasksClaim(tenantId: string, args: Record<string, unknown>) {
  const claimedBy = args.claimedBy as string | undefined;
  if (!claimedBy || typeof claimedBy !== 'string') return { error: 'claimedBy is required' };
  const ignoreRepos = Array.isArray(args.ignoreRepos)
    ? (args.ignoreRepos as unknown[]).filter((r): r is string => typeof r === 'string' && r.length > 0)
    : undefined;
  const task = await claimTask(tenantId, {
    claimedBy,
    taskId: args.taskId as string | undefined,
    repo: args.repo as string | undefined,
    ignoreRepos,
    leaseSeconds: args.leaseSeconds as number | undefined,
  });
  if (!task) return { claimed: false, message: 'No claimable pending task' };
  return { claimed: true, task };
}

async function handleTasksFail(tenantId: string, args: Record<string, unknown>) {
  const taskId = args.taskId as string | undefined;
  const error = args.error as string | undefined;
  if (!taskId || typeof taskId !== 'string') return { error: 'taskId is required' };
  if (!error || typeof error !== 'string') return { error: 'error is required' };
  const task = await failTask(tenantId, { taskId, error });
  if (!task) return { error: `Task not found: ${taskId}` };
  return task;
}

// ── DISTRIBUTED TRACING handlers ──────────────────────────

function handleTracesRecord(args: Record<string, unknown>) {
  const taskId = args.taskId as string | undefined;
  const name = args.name as string | undefined;
  const service = args.service as SpanService | undefined;
  const startMs = args.startMs as number | undefined;
  const endMs = args.endMs as number | undefined;
  if (!taskId || typeof taskId !== 'string') return { error: 'taskId is required' };
  if (!name || typeof name !== 'string') return { error: 'name is required' };
  if (service !== 'gateway' && service !== 'runner' && service !== 'agent') return { error: 'service must be one of gateway|runner|agent' };
  if (typeof startMs !== 'number' || typeof endMs !== 'number') return { error: 'startMs and endMs (epoch ms) are required' };

  const status = args.status as SpanStatus | undefined;
  const span = recordSpan({
    traceKey: taskId,
    name,
    service,
    startMs,
    endMs,
    status: status === 'error' ? 'error' : 'ok',
    parentName: args.parentName as string | undefined,
    attributes: (args.attributes as Record<string, unknown> | undefined) ?? {},
    error: args.error as string | undefined,
  });
  return { recorded: !!span, span };
}

function handleTracesList(args: Record<string, unknown>) {
  const taskId = args.taskId as string | undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 100;
  if (taskId) {
    return { taskId, spans: getSpans({ traceKey: taskId, limit }) };
  }
  return { traceIds: getTraceIds().slice(0, limit) };
}

// ── STRUCTURED REQUEST LOGGING handlers ───────────────────

function handleLogsRecord(tenantId: string, args: Record<string, unknown>) {
  const correlationId = args.correlationId as string | undefined;
  const service = args.service as LogService | undefined;
  const message = args.message as string | undefined;
  if (!correlationId || typeof correlationId !== 'string') return { error: 'correlationId is required' };
  if (service !== 'gateway' && service !== 'runner' && service !== 'agent') return { error: 'service must be one of gateway|runner|agent' };
  if (!message || typeof message !== 'string') return { error: 'message is required' };

  const level = args.level as LogLevel | undefined;
  const entry = recordLog({
    tenantId,
    correlationId,
    service,
    level: level && ['debug', 'info', 'warn', 'error'].includes(level) ? level : 'info',
    message,
    attributes: (args.attributes as Record<string, unknown> | undefined) ?? {},
  });
  return { recorded: !!entry, entry };
}

function handleLogsList(tenantId: string, args: Record<string, unknown>) {
  return {
    entries: getLogs({
      tenantId,
      correlationId: args.correlationId as string | undefined,
      service: args.service as LogService | undefined,
      level: args.level as LogLevel | undefined,
      q: args.q as string | undefined,
      since: typeof args.since === 'number' ? args.since : undefined,
      limit: typeof args.limit === 'number' ? args.limit : undefined,
    }),
  };
}

// ── TASK ARTIFACT handlers ────────────────────────────────

async function handleArtifactsRegister(tenantId: string, args: Record<string, unknown>) {
  const taskId = args.taskId as string | undefined;
  const repo = args.repo as string | undefined;
  const kind = args.kind as ArtifactKind | undefined;
  const filename = args.filename as string | undefined;
  const content = args.content as string | undefined;
  if (!taskId || typeof taskId !== 'string') return { error: 'taskId is required' };
  if (!repo || typeof repo !== 'string') return { error: 'repo is required' };
  if (!kind || typeof kind !== 'string') return { error: 'kind is required' };
  if (!filename || typeof filename !== 'string') return { error: 'filename is required' };
  if (typeof content !== 'string') return { error: 'content is required' };
  const artifact = await saveArtifact(tenantId, {
    taskId,
    repo,
    kind,
    filename,
    contentType: args.contentType as string | undefined,
    content,
  });
  return artifact;
}

async function handleArtifactsList(tenantId: string, args: Record<string, unknown>) {
  const taskId = args.taskId as string | undefined;
  if (!taskId || typeof taskId !== 'string') return { error: 'taskId is required' };
  const artifacts = await listArtifacts(tenantId, taskId);
  return { count: artifacts.length, artifacts };
}

// ── RUNNER LEASE handlers (ADR-011 slice 3) ───────────────

async function handleRunnerLeaseAcquire(tenantId: string, args: Record<string, unknown>) {
  const holder = args.holder as string | undefined;
  if (!holder || typeof holder !== 'string') return { error: 'holder is required' };
  return acquireLease(tenantId, {
    holder,
    machine: args.machine as string | undefined,
    account: args.account as string | undefined,
    taskId: args.taskId as string | undefined,
    slots: args.slots as number | undefined,
    leaseSeconds: args.leaseSeconds as number | undefined,
  });
}

async function handleRunnerLeaseHeartbeat(tenantId: string, args: Record<string, unknown>) {
  const holder = args.holder as string | undefined;
  if (!holder || typeof holder !== 'string') return { error: 'holder is required' };
  if (typeof args.slot !== 'number') return { error: 'slot is required (number)' };
  return heartbeatLease(tenantId, {
    holder,
    slot: args.slot,
    leaseSeconds: args.leaseSeconds as number | undefined,
    taskId: args.taskId as string | undefined,
  });
}

async function handleRunnerLeaseRelease(tenantId: string, args: Record<string, unknown>) {
  const holder = args.holder as string | undefined;
  if (!holder || typeof holder !== 'string') return { error: 'holder is required' };
  if (typeof args.slot !== 'number') return { error: 'slot is required (number)' };
  return releaseLease(tenantId, { holder, slot: args.slot });
}

async function handleRunnerLeaseList(tenantId: string, args: Record<string, unknown>) {
  return listLeases(tenantId, args.slots as number | undefined);
}

async function handleRunnerHeartbeat(tenantId: string, args: Record<string, unknown>) {
  const machine = args.machine as string | undefined;
  const holder = args.holder as string | undefined;
  if (!machine || typeof machine !== 'string') return { error: 'machine is required' };
  if (!holder || typeof holder !== 'string') return { error: 'holder is required' };
  return recordHeartbeat(tenantId, { machine, holder });
}

async function handleRunnerLiveness(tenantId: string, args: Record<string, unknown>) {
  return getRunnerLiveness(tenantId, { thresholdMinutes: args.thresholdMinutes as number | undefined });
}

// ── REPO handlers ─────────────────────────────────────────

async function handleReposList(tenantId: string) {
  // ADR-021: unified roster = managed_repos.txt seed ∪ tenant's DB `repos` table.
  const repos = await listReposUnified(tenantId);
  return {
    total: repos.length,
    withAiFolder: repos.filter(r => r.hasAiFolder).length,
    gitRepos: repos.filter(r => r.isGitRepo).length,
    repos,
  };
}

async function handleReposStatus(args: Record<string, unknown>) {
  const repo = args.repo as string | undefined;
  if (!repo || typeof repo !== 'string') return { error: 'repo is required' };
  return getRepoStatus(repo);
}

async function handleReposCardList(tenantId: string) {
  const cards = await listRepoCards(tenantId);
  return { count: cards.length, cards };
}

async function handlePlanList(tenantId: string, args: Record<string, unknown>) {
  const days = await listPlan(tenantId, args.repo as string | undefined);
  return { count: days.length, days };
}

async function handlePlanSet(tenantId: string, args: Record<string, unknown>) {
  const repo = args.repo as string;
  if (!repo) return { error: 'repo is required' };
  const days = args.days as PlanDayInput[] | undefined;
  if (!Array.isArray(days) || days.length === 0) return { error: 'days[] is required' };
  const result = await setPlan(tenantId, {
    repo,
    startDate: args.startDate as string | undefined,
    fireHourUtc: args.fireHourUtc as number | undefined,
    replace: args.replace as boolean | undefined,
    days,
  });
  if (!result) return { error: 'DB not connected — plan not saved' };
  return { saved: true, ...result };
}

// ── HANDOFF handlers ──────────────────────────────────────

async function handleHandoffWrite(tenantId: string, args: Record<string, unknown>) {
  const repo = args.repo as string;
  if (!repo) return { error: 'repo is required' };
  const content = args.content as string;
  if (!content || !content.trim()) return { error: 'content is required' };
  const handoff = await writeHandoff(tenantId, {
    repo,
    content,
    summary: args.summary as string | undefined,
    author: args.author as string | undefined,
    branch: args.branch as string | undefined,
    machine: args.machine as string | undefined,
    sessionId: args.sessionId as string | undefined,
  });
  if (!handoff) return { error: 'DB not connected — handoff not saved' };
  return { saved: true, handoff };
}

async function handleHandoffRead(tenantId: string, args: Record<string, unknown>) {
  const repo = args.repo as string | undefined;
  if (!repo) {
    const handoffs = await listLatestHandoffs(tenantId, (args.limit as number) || 100);
    return { count: handoffs.length, handoffs };
  }
  const result = await readHandoff(tenantId, repo, { historyLimit: (args.history as number) || 0 });
  return result;
}

async function handleSessionExport(tenantId: string, args: Record<string, unknown>) {
  const sessionId = args.sessionId as string;
  if (!sessionId) return { error: 'sessionId is required' };
  const bundle = await exportSession(tenantId, sessionId);
  if (!bundle) return { error: `Session ${sessionId} not found` };
  return { exported: true, bundle };
}

async function handleSessionImport(tenantId: string, args: Record<string, unknown>) {
  const bundle = args.bundle as SessionExport | undefined;
  if (!bundle || typeof bundle !== 'object') return { error: 'bundle is required' };
  try {
    const session = await importSession(tenantId, bundle, { preserveId: Boolean(args.preserveId) });
    return {
      imported: true,
      sessionId: session.id,
      agentName: session.agentName,
      messageCount: session.messages.length,
    };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function handleSessionRecall(tenantId: string, args: Record<string, unknown>) {
  return recallSessionContext(tenantId, {
    agentName: args.agentName as string | undefined,
    limit: args.limit as number | undefined,
    perSessionMessages: args.perSessionMessages as number | undefined,
  });
}

async function handleContextBoot(tenantId: string, args: Record<string, unknown>) {
  const bundle = await buildBootBundle(tenantId, {
    repo: args.repo as string | undefined,
    query: args.query as string | undefined,
    expandLimit: args.expandLimit as number | undefined,
    crossProject: args.crossProject as boolean | undefined,
    budget: args.budget as number | undefined,
  });
  // Continuity meter: every boot bundle served is a cold start the agent did
  // not pay for by re-reading state files. Fire-and-forget. The baseline stamp
  // is the measured legacy file-read cost — the today-vs-brain comparator.
  void recordContextServed(tenantId, {
    repo: bundle.parts.activeProject,
    tool: 'context_boot',
    tokens: bundle.tokenEstimate,
    baselineTokens: estimateLegacyBootTokens(),
    userId: args.userId as string | undefined,
  });
  // Activation funnel: first boot bundle = the tenant reached "first brain boot".
  // Idempotent + fire-and-forget (ADR-014 posture) — every boot re-fires, only
  // the first stamps the milestone.
  void recordActivation(tenantId, 'first_brain_boot', { repo: bundle.parts.activeProject });
  return bundle;
}

async function handleContinuityStats(tenantId: string, args: Record<string, unknown>) {
  return getContinuityStats(tenantId, { repo: args.repo as string | undefined });
}

async function handleUserSavings(tenantId: string, args: Record<string, unknown>) {
  return getUserSavings(tenantId, { userId: (args.userId as string | undefined)?.trim() || undefined });
}

async function handleActivationFunnel(tenantId: string, args: Record<string, unknown>) {
  if (args.selfServe === true) {
    return getSelfServeConversion();
  }
  if (args.fleet === true) {
    const days = typeof args.sinceDays === 'number' && args.sinceDays > 0 ? args.sinceDays : undefined;
    const since = days ? new Date(Date.now() - days * 86_400_000) : undefined;
    return getActivationRollup({ since });
  }
  return getActivationFunnel(tenantId);
}

function handlePerfStats() {
  // Process-wide meter (not tenant-scoped): latency is a property of the gateway
  // process, and it carries no tenant content — only tool names + timings.
  return getPerfStats();
}

function handleSloStatus() {
  // Process-wide, like perf_stats — SLOs are a property of the gateway process.
  // Evaluate current breaches live off the perf meter alongside the config.
  return { ...getSloAlertStatus(), currentBreaches: evaluateBreaches(getPerfStats().tools) };
}

async function handleFleetRunStart(tenantId: string, args: Record<string, unknown>) {
  const runId = args.runId as string;
  if (!runId) return { error: 'runId is required' };
  const repos = args.repos as FleetRepoInput[] | undefined;
  if (!Array.isArray(repos) || repos.length === 0) return { error: 'repos[] is required' };
  const run = await startFleetRun(tenantId, {
    runId,
    type: args.type as string | undefined,
    machine: args.machine as string | undefined,
    agent: args.agent as string | undefined,
    repos,
  });
  if (!run) return { error: 'DB not connected — fleet run not saved' };
  return { started: true, run };
}

async function handleFleetRunRepoUpdate(tenantId: string, args: Record<string, unknown>) {
  const runId = args.runId as string;
  const repo = args.repo as string;
  if (!runId || !repo) return { error: 'runId and repo are required' };
  const patch: FleetRepoPatch = {
    decision: args.decision as string | undefined,
    action: args.action as string | undefined,
    actionStatus: args.actionStatus as FleetRepoActionStatus | undefined,
    detail: args.detail as string | undefined,
    prUrl: args.prUrl as string | undefined,
    recommendation: args.recommendation as string | undefined,
  };
  const run = await updateFleetRepo(tenantId, runId, repo, patch);
  if (!run) return { error: 'run/repo not found or DB not connected' };
  return { updated: true, run };
}

async function handleFleetRunFinish(tenantId: string, args: Record<string, unknown>) {
  const runId = args.runId as string;
  if (!runId) return { error: 'runId is required' };
  const status = (args.status as 'completed' | 'aborted' | undefined) ?? 'completed';
  const run = await finishFleetRun(tenantId, runId, status);
  if (!run) return { error: 'run not found or DB not connected' };
  return { finished: true, run };
}

async function handleFleetRunLatest(tenantId: string) {
  const run = await latestFleetRun(tenantId);
  return { run };
}

async function handleFleetRunList(tenantId: string, args: Record<string, unknown>) {
  const runs = await listFleetRuns(tenantId, args.limit as number | undefined);
  return { count: runs.length, runs };
}

async function handleReposCardUpsert(tenantId: string, args: Record<string, unknown>) {
  const repoName = args.repoName as string;
  if (!repoName) return { error: 'repoName is required' };
  const card = await upsertRepoCard(tenantId, {
    repoName,
    description: args.description as string | undefined,
    group: args.group as string | undefined,
    localhostUrl: args.localhostUrl as string | undefined,
    appUrl: args.appUrl as string | undefined,
    apiUrl: args.apiUrl as string | undefined,
    mongo: args.mongo as string | undefined,
    vercelUrl: args.vercelUrl as string | undefined,
    dnsUrl: args.dnsUrl as string | undefined,
    lastStatus: args.lastStatus as string | undefined,
    lastStatusLevel: args.lastStatusLevel as RepoCardLevel | undefined,
    reportedBy: args.reportedBy as string | undefined,
    commitsAhead: typeof args.commitsAhead === 'number' ? args.commitsAhead : undefined,
  });
  if (!card) return { error: 'DB not connected — card not saved' };
  // Activation funnel: registering an app-directory card = a project was
  // connected to myAI ("init"). First card stamps the milestone; every wrap-up
  // re-fires harmlessly. Idempotent, fire-and-forget.
  void recordActivation(tenantId, 'init', { repo: repoName });
  return { saved: true, card };
}

async function handleNewApp(tenantId: string, args: Record<string, unknown>) {
  const idea = args.idea as string | undefined;
  if (!idea || typeof idea !== 'string' || !idea.trim()) return { error: 'idea is required' };
  const result = await createNewApp(tenantId, {
    idea,
    name: args.name as string | undefined,
    group: args.group as string | undefined,
    trigger: args.trigger as boolean | undefined,
  });
  // Product meter (ADR-014): app.generated on success. Fire-and-forget — a
  // meter failure never fails the scaffold. Non-deterministic eventId (not
  // re-emitted). Skip on an error result so we only meter real apps.
  if (!(result && typeof result === 'object' && 'error' in result)) {
    await recordUsage(tenantId, {
      eventId: `usage-app-${randomUUID()}`,
      type: 'app.generated',
      source: 'gateway',
      metadata: { tool: 'new_app', name: args.name },
    });
  }
  return result;
}

// ── CONNECTOR handlers ────────────────────────────────────

async function handleConnectorsList(tenantId: string) {
  const connectors = await listConnectors(tenantId);
  const enabled = connectors.filter((c) => c.enabled).length;
  const needsKey = connectors.filter((c) => (c.requiresEnv?.length ?? 0) > 0).length;
  return { count: connectors.length, enabled, needsKey, connectors };
}

async function handleConnectorsSeed(tenantId: string) {
  const result = await seedDefaultConnectors(tenantId);
  if (!result) return { error: 'DB not connected — connectors not seeded' };
  return { ok: true, ...result };
}

async function handleConnectorsSet(tenantId: string, args: Record<string, unknown>, ctx: ToolContext) {
  const key = args.key as string;
  if (!key) return { error: 'key is required' };
  try {
    const connector = await upsertConnector(tenantId, {
      key,
      label: args.label as string | undefined,
      category: args.category as string | undefined,
      transport: args.transport as ConnectorTransport | undefined,
      description: args.description as string | undefined,
      url: args.url as string | undefined,
      command: args.command as string | undefined,
      args: args.args as string[] | undefined,
      env: args.env as Record<string, string> | undefined,
      requiresEnv: args.requiresEnv as string[] | undefined,
      enabled: args.enabled as boolean | undefined,
    }, auditActorFromCtx(ctx));
    if (!connector) return { error: 'DB not connected — connector not saved' };
    return { saved: true, connector };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function handleConnectorsToggle(tenantId: string, args: Record<string, unknown>, ctx: ToolContext) {
  const key = args.key as string;
  if (!key) return { error: 'key is required' };
  if (typeof args.enabled !== 'boolean') return { error: 'enabled (boolean) is required' };
  const connector = await setConnectorEnabled(tenantId, key, args.enabled, auditActorFromCtx(ctx));
  if (!connector) return { error: 'DB not connected — connector not updated' };
  return { saved: true, connector };
}

async function handleConnectorsRemove(tenantId: string, args: Record<string, unknown>, ctx: ToolContext) {
  const key = args.key as string;
  if (!key) return { error: 'key is required' };
  const result = await removeConnector(tenantId, key, auditActorFromCtx(ctx));
  if (!result) return { error: 'DB not connected — connector not removed' };
  return { ok: true, ...result };
}

async function handleConnectorsMcpConfig(tenantId: string) {
  return buildMcpConfig(tenantId);
}

async function handleReposPriority(tenantId: string) {
  const ranked = await prioritizeRepos(tenantId);
  return { count: ranked.length, ranked };
}

async function handleReposScan(tenantId: string, args: Record<string, unknown>) {
  const path = args.path as string;
  if (!path) return { error: 'path is required' };

  try {
    return await scanDirectory({
      path,
      maxDepth: args.maxDepth as number | undefined,
      register: args.register as boolean | undefined,
      tenantId,
    });
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function handleReposUpsert(tenantId: string, args: Record<string, unknown>) {
  const name = args.name as string;
  const path = args.path as string;
  if (!name) return { error: 'name is required' };
  if (!path) return { error: 'path is required' };

  const repo = await upsertRepo(tenantId, {
    name,
    path,
    gitRemote: args.gitRemote as string | undefined,
    brainNamespace: args.brainNamespace as string | undefined,
    stack: args.stack as string[] | undefined,
    group: args.group as string | undefined,
    source: args.source as 'seed' | 'myai-init' | 'scan' | 'manual' | undefined,
    enabled: args.enabled as boolean | undefined,
    lastSeenAt: new Date(),
  });
  if (!repo) return { error: 'DB not connected — repo not registered' };
  return { registered: true, repo };
}

// ── CODE-GRAPH / PR IMPACT handlers ───────────────────────

function resolveGraphRepoRoot(repoArg: unknown): string {
  const config = getConfig();
  if (!repoArg || typeof repoArg !== 'string') return config.aiRoot;
  if (existsSync(repoArg)) return repoArg;
  const match = listRepoPaths().find(r => r.name === repoArg || r.path === repoArg || r.path.endsWith(`/${repoArg}`));
  return match?.path ?? config.aiRoot;
}

async function handleGetPrImpact(args: Record<string, unknown>) {
  try {
    const repoRoot = resolveGraphRepoRoot(args.repo);
    const files = args.files as string[] | undefined;
    const base = args.base as string | undefined;
    const head = args.head as string | undefined;
    if ((!files || files.length === 0) && !(base && head)) {
      return { error: 'provide either files, or both base and head' };
    }
    const changed = resolveChangedFiles(repoRoot, { files, base, head });
    const graph = buildCodeGraph(repoRoot);
    return { repo: repoRoot, ...computePrImpact(graph, changed, { maxDepth: args.maxDepth as number | undefined }) };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function handleTriagePrs(args: Record<string, unknown>) {
  try {
    const repoRoot = resolveGraphRepoRoot(args.repo);
    const prs = args.prs as PrTriageInput[] | undefined;
    if (!prs || !Array.isArray(prs) || prs.length === 0) return { error: 'prs (non-empty array) is required' };
    const graph = buildCodeGraph(repoRoot);
    const ranked = triagePrs(graph, prs, { maxDepth: args.maxDepth as number | undefined });
    return { repo: repoRoot, count: ranked.length, ranked };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

function parseEdgeTypes(raw: unknown): EdgeType[] | undefined {
  if (!raw) return undefined;
  const arr = raw as string[];
  for (const t of arr) {
    if (!ALL_EDGE_TYPES.includes(t as EdgeType)) {
      throw new Error(`unknown edge type '${t}', must be one of ${ALL_EDGE_TYPES.join(', ')}`);
    }
  }
  return arr as EdgeType[];
}

async function handleGetNeighbors(args: Record<string, unknown>) {
  try {
    const repoRoot = resolveGraphRepoRoot(args.repo);
    const query = args.node as string | undefined;
    if (!query) return { error: 'node is required' };
    const direction = (args.direction as 'out' | 'in' | 'both' | undefined) ?? 'out';
    const edgeTypes = parseEdgeTypes(args.edgeTypes);

    const graph = buildCodeGraph(repoRoot);
    const resolved = resolveGraphNode(graph, query);
    if (resolved.length === 0) return { error: `node/symbol not found: ${query}` };

    const neighbors = resolved.flatMap(file =>
      getNeighbors(graph, file, { edgeTypes, direction }).map(n => ({ from: file, ...n }))
    );
    return { repo: repoRoot, query, resolved, direction, neighbors };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

async function handleShortestPath(args: Record<string, unknown>) {
  try {
    const repoRoot = resolveGraphRepoRoot(args.repo);
    const srcQuery = args.src as string | undefined;
    const dstQuery = args.dst as string | undefined;
    if (!srcQuery || !dstQuery) return { error: 'src and dst are required' };
    const edgeTypes = parseEdgeTypes(args.edgeTypes);

    const graph = buildCodeGraph(repoRoot);
    const srcCandidates = resolveGraphNode(graph, srcQuery);
    const dstCandidates = resolveGraphNode(graph, dstQuery);
    if (srcCandidates.length === 0) return { error: `src node/symbol not found: ${srcQuery}` };
    if (dstCandidates.length === 0) return { error: `dst node/symbol not found: ${dstQuery}` };

    let best: string[] | null = null;
    let bestKey = '';
    for (const s of srcCandidates) {
      for (const d of dstCandidates) {
        const path = shortestPath(graph, s, d, { edgeTypes });
        if (!path) continue;
        const key = `${s}|${d}`;
        if (!best || path.length < best.length || (path.length === best.length && key < bestKey)) {
          best = path;
          bestKey = key;
        }
      }
    }

    return { repo: repoRoot, src: srcQuery, dst: dstQuery, path: best, found: best !== null };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ── AGENT / SKILL handlers ────────────────────────────────

async function handleAgentsList(args: Record<string, unknown>) {
  const all = loadAgents();
  const categoryFilter = args.category as string | undefined;
  const items = Array.from(all.values())
    .filter(a => !categoryFilter || a.category === categoryFilter)
    .map(a => ({
      name: a.name,
      category: a.category,
      description: a.description,
      toolCount: a.tools.length,
      tools: a.tools,
    }));
  return { count: items.length, agents: items };
}

async function handleSkillsList(args: Record<string, unknown>) {
  const all = loadSkills();
  const agentFilter = args.agent as string | undefined;
  const items = Array.from(all.values())
    .filter(s => {
      if (!agentFilter) return true;
      // Skills aren't strictly tagged by owning agent — fall back to filename prefix match
      return s.name.toLowerCase().includes(agentFilter.toLowerCase());
    })
    .map(s => ({
      name: s.name,
      description: s.description,
      triggers: s.triggers,
    }));
  return { count: items.length, skills: items };
}

// ── INVOKE handlers ───────────────────────────────────────

async function handleAgentsInvoke(tenantId: string, args: Record<string, unknown>) {
  const agentName = args.agent as string | undefined;
  const message = args.message as string | undefined;
  if (!agentName || typeof agentName !== 'string') return { error: 'agent is required' };
  if (!message || typeof message !== 'string') return { error: 'message is required' };
  const repo = args.repo as string | undefined;
  const includeMemoryContext = (args.includeMemoryContext as boolean) || false;
  const maxTokens = (args.maxTokens as number) || 4096;

  if (!isLlmConfigured()) {
    return { error: 'LLM provider not configured. Set ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY, or enable bridge/direct/ollama mode.' };
  }

  const agents = loadAgents();
  const agent = agents.get(agentName);
  if (!agent) {
    return { error: `Agent not found: ${agentName}. Use agents_list to see available agents.` };
  }

  let userContent = message;
  if (includeMemoryContext) {
    if (!repo) {
      return { error: 'includeMemoryContext requires repo parameter' };
    }
    const memCtx = await handleMemoryContext(tenantId, { repo, query: message }) as { text: string };
    userContent = `${memCtx.text}\n\n---\n\n${message}`;
  }

  const start = Date.now();
  const response = await llmComplete({
    systemPrompt: agent.instructions,
    messages: [{ role: 'user', content: userContent }],
    maxTokens,
    routingContext: {
      agent: agentName,
      ...(args.tier ? { tier: args.tier as any } : {}),
    },
  });
  const elapsedMs = Date.now() - start;

  if (!response) return { error: 'LLM returned no response' };

  // Product meter (ADR-014): agent.invoked — the interactive premium surface.
  await recordUsage(tenantId, {
    eventId: `usage-agent-${randomUUID()}`,
    type: 'agent.invoked',
    source: 'gateway',
    repo,
    metadata: { tool: 'agents_invoke', agent: agentName, model: response.model },
  });

  return {
    agent: agent.name,
    category: agent.category,
    content: response.content,
    provider: response.provider,
    model: response.model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
    elapsedMs,
    memoryContextIncluded: includeMemoryContext,
  };
}

async function handleSkillsInvoke(args: Record<string, unknown>) {
  const skillName = args.skill as string;
  const message = args.message as string;
  const maxTokens = (args.maxTokens as number) || 4096;

  if (!isLlmConfigured()) {
    return { error: 'LLM provider not configured. Set ANTHROPIC_API_KEY, DEEPSEEK_API_KEY, MOONSHOT_API_KEY, or enable bridge/direct/ollama mode.' };
  }

  const skills = loadSkills();
  const skill = skills.get(skillName);
  if (!skill) {
    return { error: `Skill not found: ${skillName}. Use skills_list to see available skills.` };
  }

  const start = Date.now();
  const response = await llmComplete({
    systemPrompt: skill.playbook,
    messages: [{ role: 'user', content: message }],
    maxTokens,
    routingContext: {
      tier: (args.tier as any) || undefined,
    },
  });
  const elapsedMs = Date.now() - start;

  if (!response) return { error: 'LLM returned no response' };

  return {
    skill: skill.name,
    triggers: skill.triggers,
    content: response.content,
    provider: response.provider,
    model: response.model,
    inputTokens: response.inputTokens,
    outputTokens: response.outputTokens,
    costUsd: response.costUsd,
    elapsedMs,
  };
}

// ── SCHEDULE handlers ─────────────────────────────────────

async function handleSchedulesList(tenantId: string, args: Record<string, unknown>) {
  const schedules = await listSchedules(tenantId, {
    enabled: args.enabled as boolean | undefined,
    kind: args.kind as ScheduleKind | undefined,
    status: args.status as ScheduleStatus | undefined,
    limit: args.limit as number | undefined,
  });
  return { count: schedules.length, schedules };
}

async function handleSchedulesCreate(tenantId: string, args: Record<string, unknown>) {
  const name = args.name as string | undefined;
  const cronExpr = args.cronExpr as string | undefined;
  const kind = args.kind as ScheduleKind | undefined;
  const target = args.target as string | undefined;
  const message = args.message as string;

  if (!name || typeof name !== 'string') return { error: 'name is required' };
  if (!kind || typeof kind !== 'string') return { error: 'kind is required (agent | skill | tool)' };
  if (!target || typeof target !== 'string') return { error: 'target is required' };
  if (!cronExpr || typeof cronExpr !== 'string') return { error: 'cronExpr is required' };

  if (!isValidCronExpr(cronExpr)) {
    return { error: `Invalid cron expression: "${cronExpr}". Use 5-field format (min hour day month dow), e.g. "0 9 * * *".` };
  }

  // Validate target exists at create-time so callers get fast feedback
  if (kind === 'agent') {
    const agents = loadAgents();
    if (!agents.has(target)) {
      return { error: `Agent not found: ${target}. Use agents_list to see available agents.` };
    }
  } else if (kind === 'skill') {
    const skills = loadSkills();
    if (!skills.has(target)) {
      return { error: `Skill not found: ${target}. Use skills_list to see available skills.` };
    }
  } else if (kind === 'tool') {
    const known = new Set(TOOL_DEFINITIONS.map(t => t.name));
    if (!known.has(target)) {
      return { error: `Tool not found: ${target}. Must be one of the registered MCP tools.` };
    }
    // Tool kind requires message to be JSON-parseable args object.
    const trimmedMessage = typeof message === 'string' ? message.trim() : '';
    if (trimmedMessage) {
      try {
        const parsed = JSON.parse(trimmedMessage);
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { error: 'Tool kind requires message to be a JSON object literal (e.g. \'{"topN":3}\').' };
        }
      } catch (err) {
        return { error: `Tool kind requires message to be valid JSON: ${(err as Error).message}` };
      }
    }
  }

  const schedule = await createSchedule(tenantId, {
    name,
    cronExpr,
    kind,
    target,
    message,
    repo: args.repo as string | undefined,
    includeMemoryContext: args.includeMemoryContext as boolean | undefined,
    enabled: args.enabled as boolean | undefined,
    nextRun: computeNextRun(cronExpr),
  });

  return schedule;
}

async function handleSchedulesUpdate(tenantId: string, args: Record<string, unknown>) {
  if (!args.scheduleId || typeof args.scheduleId !== 'string') return { error: 'scheduleId is required' };
  const scheduleId = args.scheduleId as string;
  const cronExpr = args.cronExpr as string | undefined;

  if (cronExpr !== undefined && !isValidCronExpr(cronExpr)) {
    return { error: `Invalid cron expression: "${cronExpr}".` };
  }

  const updated = await updateSchedule(tenantId, {
    scheduleId,
    name: args.name as string | undefined,
    cronExpr,
    message: args.message as string | undefined,
    repo: args.repo as string | undefined,
    includeMemoryContext: args.includeMemoryContext as boolean | undefined,
    enabled: args.enabled as boolean | undefined,
    nextRun: cronExpr !== undefined ? computeNextRun(cronExpr) : undefined,
  });

  if (!updated) return { error: `Schedule not found: ${scheduleId}` };
  return updated;
}

async function handleSchedulesRunNow(ctx: ToolContext, args: Record<string, unknown>) {
  const tenantId = ctx.tenantId;
  const scheduleId = args.scheduleId as string;

  const schedule = await getSchedule(tenantId, scheduleId);
  if (!schedule) return { error: `Schedule not found: ${scheduleId}` };

  const ranAt = new Date();
  let toolName: string;
  let dispatchArgs: Record<string, unknown>;
  if (schedule.kind === 'agent') {
    toolName = 'agents_invoke';
    dispatchArgs = { agent: schedule.target, message: schedule.message, repo: schedule.repo, includeMemoryContext: schedule.includeMemoryContext };
  } else if (schedule.kind === 'skill') {
    toolName = 'skills_invoke';
    dispatchArgs = { skill: schedule.target, message: schedule.message };
  } else {
    toolName = schedule.target;
    const rawMessage = typeof schedule.message === 'string' ? schedule.message.trim() : '';
    if (!rawMessage) {
      dispatchArgs = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawMessage);
      } catch (err) {
        const errMsg = `Tool args not valid JSON: ${(err as Error).message}`;
        const updated = await recordRunResult(tenantId, {
          scheduleId, status: 'error', error: errMsg, nextRun: schedule.nextRun ?? new Date(Date.now() + 60_000), ranAt,
        });
        return { dispatched: false, error: errMsg, schedule: updated };
      }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        const errMsg = 'Tool args must be a JSON object literal (got array or primitive)';
        const updated = await recordRunResult(tenantId, {
          scheduleId, status: 'error', error: errMsg, nextRun: schedule.nextRun ?? new Date(Date.now() + 60_000), ranAt,
        });
        return { dispatched: false, error: errMsg, schedule: updated };
      }
      dispatchArgs = parsed as Record<string, unknown>;
    }
  }

  // Preserve existing nextRun — run_now is a manual nudge, not part of cadence.
  const nextRun = schedule.nextRun ?? new Date(Date.now() + 60_000);

  try {
    // Re-dispatch under this schedule's tenant context, never cross-tenant.
    const dispatch = await executeTool(toolName, dispatchArgs, ctx) as { content?: string; error?: string };

    if (dispatch && dispatch.error) {
      const updated = await recordRunResult(tenantId, {
        scheduleId, status: 'error', error: dispatch.error, nextRun, ranAt,
      });
      return { dispatched: false, error: dispatch.error, schedule: updated };
    }

    const summarySource = dispatch && typeof dispatch.content === 'string'
      ? dispatch.content
      : JSON.stringify(dispatch ?? {});
    const updated = await recordRunResult(tenantId, {
      scheduleId,
      status: 'success',
      summary: summarySource.slice(0, 200),
      nextRun,
      ranAt,
    });
    return { dispatched: true, content: dispatch?.content, result: dispatch, schedule: updated };
  } catch (err) {
    const errMsg = (err as Error).message;
    const updated = await recordRunResult(tenantId, {
      scheduleId, status: 'error', error: errMsg, nextRun, ranAt,
    });
    return { dispatched: false, error: errMsg, schedule: updated };
  }
}

async function handleSchedulesDelete(tenantId: string, args: Record<string, unknown>) {
  if (!args.scheduleId || typeof args.scheduleId !== 'string') return { error: 'scheduleId is required' };
  const scheduleId = args.scheduleId as string;
  const deleted = await deleteSchedule(tenantId, scheduleId);
  if (!deleted) return { error: `Schedule not found: ${scheduleId}` };
  return { deleted: true, scheduleId };
}

async function handleSchedulesSeed(args: Record<string, unknown>) {
  return seedDefaultSchedules({
    enabled: args.enabled as boolean | undefined,
  });
}

// ── SWEEP handlers ────────────────────────────────────────

async function handleMorningSweep(args: Record<string, unknown>) {
  const result = await runMorningSweep({
    topN: args.topN as number | undefined,
    agent: args.agent as string | undefined,
    telegramChatId: args.telegramChatId as string | undefined,
    briefMaxTokens: args.briefMaxTokens as number | undefined,
  });
  // Return the report as the .content field so summary extraction works for kind=tool dispatches.
  return {
    content: result.report,
    topN: result.topN,
    agent: result.agent,
    ranAt: result.ranAt,
    reposConsidered: result.reposConsidered,
    briefs: result.briefs,
    delivery: result.delivery,
  };
}

async function handleEveningSweep(args: Record<string, unknown>) {
  const result = await runEveningSweep({
    telegramChatId: args.telegramChatId as string | undefined,
    previewTopN: args.previewTopN as number | undefined,
  });
  // Return the report as the .content field so summary extraction works for kind=tool dispatches.
  return {
    content: result.report,
    ranAt: result.ranAt,
    tasksCompletedToday: result.tasksCompletedToday,
    tasksOpenTotal: result.tasksOpenTotal,
    scheduleRunsToday: result.scheduleRunsToday,
    spendToday: result.spendToday,
    reposWorkedOn: result.reposWorkedOn,
    tomorrowPreview: result.tomorrowPreview,
    delivery: result.delivery,
  };
}

async function handleDataRetentionPurge() {
  return runRetentionPurge();
}

// ── BUDGET handlers (read-only) ───────────────────────────

async function handleBudgetsStatus(tenantId: string) {
  return getBudgetStatus(tenantId);
}

async function handleBudgetsBreakdown(tenantId: string, args: Record<string, unknown>) {
  const fromRaw = args.from as string | undefined;
  const toRaw = args.to as string | undefined;

  let from: Date | undefined;
  let to: Date | undefined;
  if (fromRaw) {
    const d = new Date(fromRaw);
    if (Number.isNaN(d.getTime())) return { error: `Invalid 'from' timestamp: ${fromRaw}` };
    from = d;
  }
  if (toRaw) {
    const d = new Date(toRaw);
    if (Number.isNaN(d.getTime())) return { error: `Invalid 'to' timestamp: ${toRaw}` };
    to = d;
  }

  return getBudgetBreakdown(tenantId, { from, to });
}

async function handleUsageSummary(tenantId: string, args: Record<string, unknown>) {
  const fromRaw = args.from as string | undefined;
  const toRaw = args.to as string | undefined;
  const groupByRaw = args.groupBy as string | undefined;

  let from: Date | undefined;
  let to: Date | undefined;
  if (fromRaw) {
    const d = new Date(fromRaw);
    if (Number.isNaN(d.getTime())) return { error: `Invalid 'from' timestamp: ${fromRaw}` };
    from = d;
  }
  if (toRaw) {
    const d = new Date(toRaw);
    if (Number.isNaN(d.getTime())) return { error: `Invalid 'to' timestamp: ${toRaw}` };
    to = d;
  }

  let groupBy: 'type' | 'day' | 'repo' | undefined;
  if (groupByRaw !== undefined) {
    if (groupByRaw !== 'type' && groupByRaw !== 'day' && groupByRaw !== 'repo') {
      return { error: `Invalid 'groupBy': ${groupByRaw} (must be type|day|repo)` };
    }
    groupBy = groupByRaw;
  }

  return summarizeUsage(tenantId, { from, to, groupBy });
}

// ── HEALTH handlers ──────────────────────────────────────

async function handleHealthStatus(tenantId: string) {
  const config = getConfig();

  // Gateway uptime
  const uptimeSeconds = Math.floor(process.uptime());

  // MongoDB connection
  const mongoConnected = isConnected();

  // Vector corpus size
  let vectorCount = 0;
  try {
    vectorCount = await getVectorCount(tenantId);
  } catch { /* noop — DB may be down */ }

  // Active schedules
  let activeSchedules = 0;
  try {
    const schedules = await listSchedules(tenantId, { enabled: true });
    activeSchedules = schedules.length;
  } catch { /* noop */ }

  // LLM provider status
  const llmConfigured = isLlmConfigured();

  // Channel statuses
  const telegramEnabled = config.channels?.telegram?.enabled ?? false;
  const discordEnabled = config.channels?.discord?.enabled ?? false;

  // Managed repos
  let managedRepoCount = 0;
  try {
    managedRepoCount = listRepoPaths().length;
  } catch { /* noop */ }

  // Memory usage
  const mem = process.memoryUsage();

  // Fleet-wide maintenance kill switch (fleet-maintenance-store.js) — surfaced
  // here so the dashboard can render a maintenance banner without a separate poll.
  let fleetMaintenance: Awaited<ReturnType<typeof getFleetMaintenanceStatus>> = { active: false };
  try {
    fleetMaintenance = await getFleetMaintenanceStatus(tenantId);
  } catch { /* noop — DB may be down */ }

  return {
    gateway: {
      uptimeSeconds,
      uptimeFormatted: `${Math.floor(uptimeSeconds / 3600)}h ${Math.floor((uptimeSeconds % 3600) / 60)}m ${uptimeSeconds % 60}s`,
      nodeVersion: process.version,
      toolCount: TOOL_DEFINITIONS.length,
    },
    mongodb: {
      connected: mongoConnected,
    },
    vectors: {
      totalCount: vectorCount,
    },
    schedules: {
      activeCount: activeSchedules,
    },
    llm: {
      configured: llmConfigured,
      providers: getAllProviderHealth(),
    },
    channels: {
      telegram: telegramEnabled,
      discord: discordEnabled,
    },
    repos: {
      managedCount: managedRepoCount,
    },
    fleet: {
      maintenance: fleetMaintenance,
    },
    memory: {
      heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
      rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
      externalMB: Math.round(mem.external / 1024 / 1024 * 100) / 100,
    },
  };
}

function handleProviderHealth(args: Record<string, unknown>) {
  const provider = args.provider as string | undefined;
  if (provider) {
    return getProviderHealth(provider);
  }
  return { providers: getAllProviderHealth() };
}

function handleProviderReset(args: Record<string, unknown>) {
  const provider = args.provider as string;
  if (!provider) throw new Error('provider is required');
  resetProvider(provider);
  return { reset: true, provider, health: getProviderHealth(provider) };
}

function handleProviderMaintenanceEnter(args: Record<string, unknown>) {
  const provider = args.provider as string;
  if (!provider) throw new Error('provider is required');
  assertKnownProvider(provider);
  const reason = args.reason as string | undefined;
  const operator = args.operator as string | undefined;
  return enterMaintenance(provider, { reason, operator });
}

function handleProviderMaintenanceExit(args: Record<string, unknown>) {
  const provider = args.provider as string;
  if (!provider) throw new Error('provider is required');
  assertKnownProvider(provider);
  return exitMaintenance(provider);
}

function handleFleetMaintenanceEnter(tenantId: string, args: Record<string, unknown>) {
  const reason = args.reason as string | undefined;
  const operator = args.operator as string | undefined;
  const resumeInMinutes = args.resumeInMinutes !== undefined ? Number(args.resumeInMinutes) : undefined;
  let resumeAt: Date | undefined;
  if (typeof args.resumeAt === 'string' && args.resumeAt) {
    resumeAt = new Date(args.resumeAt);
    if (Number.isNaN(resumeAt.getTime())) throw new Error(`Invalid 'resumeAt': ${args.resumeAt}`);
  } else if (resumeInMinutes !== undefined) {
    if (!Number.isFinite(resumeInMinutes) || resumeInMinutes <= 0) throw new Error(`Invalid 'resumeInMinutes': ${args.resumeInMinutes}`);
    resumeAt = new Date(Date.now() + resumeInMinutes * 60_000);
  }
  return enterFleetMaintenance(tenantId, { reason, operator, resumeAt });
}

function handleFleetMaintenanceExit(tenantId: string) {
  return exitFleetMaintenance(tenantId);
}

// ── ROUTING / DISPATCH handlers ──────────────────────────

function handleRoutingInfo(args: Record<string, unknown>) {
  // Coerce/validate at the MCP boundary — router.route() validates the tier
  // and ignores invalid ones, but normalize complexity here so NaN never leaks.
  const complexityRaw = args.complexity !== undefined ? Number(args.complexity) : undefined;
  const complexity = complexityRaw !== undefined && !Number.isNaN(complexityRaw) ? complexityRaw : undefined;
  const decision = routeLlm({
    tier: typeof args.tier === 'string' ? (args.tier as any) : undefined,
    agent: args.agent as string | undefined,
    channelType: args.channelType as string | undefined,
    tool: args.tool as string | undefined,
    complexity,
    complexityLevel: typeof args.complexityLevel === 'string' ? (args.complexityLevel as any) : undefined,
    mode: typeof args.mode === 'string' ? (args.mode as any) : undefined,
  });
  return decision;
}

function handleRoutingConfig() {
  return getRoutingConfig();
}

async function handleDispatchCycle(args: Record<string, unknown>) {
  // Single source of truth: delegate to the scheduler's dispatch worker so that
  // manual MCP invocation and scheduled runs share identical agent-selection,
  // per-task budget re-check, status-transition, cost-tracking, and result-shape
  // behavior. (Previously this handler had a divergent re-implementation —
  // PR #173 Copilot finding #3 / DISPATCH-DEDUP.)
  //
  // Parse maxTasks once: default only when non-finite (NaN) so an explicit 0
  // clamps to the floor of 1 rather than silently falling back to 3.
  const maxRaw = Number(args.maxTasks);
  const maxTasksPerCycle = Number.isFinite(maxRaw)
    ? Math.min(Math.max(1, Math.floor(maxRaw)), 10)
    : 3;

  // Accept numeric strings for the spend cap (CLI/env callers often pass "5"),
  // not just JSON numbers — otherwise the cap silently fails to apply. Treat
  // empty/null/undefined as "no cap".
  const capProvided =
    args.dailySpendCapUsd !== undefined &&
    args.dailySpendCapUsd !== null &&
    args.dailySpendCapUsd !== '';
  const capRaw = Number(args.dailySpendCapUsd);
  const dailySpendCapUsd = capProvided && Number.isFinite(capRaw) ? capRaw : undefined;

  return runDispatchCycle({
    maxTasksPerCycle,
    dailySpendCapUsd,
    telegramChatId: typeof args.telegramChatId === 'string' ? args.telegramChatId : undefined,
  });
}

async function handleInlineExecute(tenantId: string, ctx: ToolContext, args: Record<string, unknown>) {
  // In-gateway inline execution lane (ADR-018). Runs short deterministic tasks
  // in-process via a whitelisted tool — no CLI-runner fire, no LLM spend. A
  // no-op unless INLINE_EXEC_ENABLED is set, and quota-bounded regardless.
  const maxRaw = Number(args.maxTasks);
  const maxTasks = Number.isFinite(maxRaw) ? Math.min(Math.max(1, Math.floor(maxRaw)), 50) : 10;
  const repo = typeof args.repo === 'string' && args.repo.trim() ? args.repo.trim() : undefined;

  // Delegate tool invocation back through executeTool so the inline lane shares
  // the identical dispatch / perf-metering / tenant chokepoint as every other
  // call. `ctx` is threaded so scoped stores see the same tenant.
  const result = await runInlineCycle(
    tenantId,
    (name, toolArgs) => executeTool(name, toolArgs, ctx),
    { maxTasks, repo },
  );

  return {
    ...result,
    operations: Object.keys(INLINE_OPERATIONS),
    quotaWindow: inlineQuotaUsage(),
  };
}

// ── FLEET / PATTERNS / STANDING AGENTS handlers ───────────

async function handleFleetOverview(tenantId: string) {
  const result: Record<string, unknown> = {};

  // Repos (ADR-021 unified roster: managed_repos.txt seed ∪ DB `repos` table)
  try {
    const repos = await listReposUnified(tenantId);
    result.repos = {
      total: repos.length,
      withAiFolder: repos.filter(r => r.hasAiFolder).length,
      gitRepos: repos.filter(r => r.isGitRepo).length,
    };
  } catch {
    result.repos = { error: 'unavailable' };
  }

  // Task queue totals by status
  try {
    result.tasks = await countTasks(tenantId, {});
  } catch {
    result.tasks = { error: 'unavailable' };
  }

  // Active schedules
  try {
    const schedules = await listSchedules(tenantId, { enabled: true });
    result.schedules = { activeCount: schedules.length };
  } catch {
    result.schedules = { error: 'unavailable' };
  }

  // Today's LLM spend
  try {
    const budget = await getBudgetStatus(tenantId);
    result.spend = { todayUsd: budget.today, monthUsd: budget.mtd };
  } catch {
    result.spend = { error: 'unavailable' };
  }

  // Top 3 repos needing attention
  try {
    const ranked = await prioritizeRepos(tenantId);
    result.topRepos = ranked.slice(0, 3);
  } catch {
    result.topRepos = { error: 'unavailable' };
  }

  return result;
}

async function handlePatternAnalyze(args: Record<string, unknown>) {
  const config = getConfig();
  const patternsDir = resolve(config.aiRoot, 'memory', 'patterns');
  const indexPath = resolve(patternsDir, 'index.json');

  if (!existsSync(indexPath)) {
    return { count: 0, patterns: [], note: 'No pattern index found at memory/patterns/index.json' };
  }

  let index: string[];
  try {
    const parsed = JSON.parse(readFileSync(indexPath, 'utf-8'));
    if (!Array.isArray(parsed)) {
      return { error: 'Pattern index is not an array — expected memory/patterns/index.json to be a JSON array of pattern names.' };
    }
    index = parsed as string[];
  } catch (err) {
    return { error: `Failed to parse pattern index: ${(err as Error).message}` };
  }

  const categoryFilter = args.category as string | undefined;
  const tagFilter = args.tag as string | undefined;
  // Clamp to safe ranges — confidence is a [0,1] probability; limit a positive count.
  const rawConfidence = typeof args.minConfidence === 'number' ? args.minConfidence : 0;
  const minConfidence = Math.min(1, Math.max(0, rawConfidence));
  const rawLimit = typeof args.limit === 'number' ? args.limit : 20;
  const limit = Math.max(1, Math.min(1000, Math.floor(rawLimit)));

  const now = Date.now();
  const MS_PER_DAY = 86_400_000;

  type PatternEntry = {
    name: string;
    confidence: number;
    usageCount: number;
    category?: string;
    tags?: string[];
    lastUsed?: string;
    staleness: number;
    effectiveness: number;
  };

  const patterns: PatternEntry[] = [];

  for (const entry of index) {
    const filePath = resolve(patternsDir, entry.endsWith('.json') ? entry : `${entry}.json`);
    if (!existsSync(filePath)) continue;

    let data: Record<string, unknown>;
    try {
      data = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
    } catch {
      continue;
    }

    const confidence = typeof data.confidence === 'number' ? data.confidence : 0;
    const usageCount = typeof data.usageCount === 'number' ? data.usageCount : 0;
    const category = data.category as string | undefined;
    const tags = Array.isArray(data.tags) ? (data.tags as string[]) : [];
    const lastUsed = data.lastUsed as string | undefined;

    if (confidence < minConfidence) continue;
    if (categoryFilter && category !== categoryFilter) continue;
    if (tagFilter && !tags.includes(tagFilter)) continue;

    const lastUsedMs = lastUsed ? new Date(lastUsed).getTime() : 0;
    const staleness = lastUsedMs > 0 ? Math.floor((now - lastUsedMs) / MS_PER_DAY) : -1;
    const effectiveness = confidence * usageCount;

    patterns.push({
      name: (data.name as string) || entry,
      confidence,
      usageCount,
      category,
      tags,
      lastUsed,
      staleness,
      effectiveness,
    });
  }

  patterns.sort((a, b) => b.effectiveness - a.effectiveness);
  const sliced = patterns.slice(0, limit);

  return { count: sliced.length, totalMatched: patterns.length, patterns: sliced };
}

async function handleStandingAgentsStatus(tenantId: string) {
  // Load all agents, filter to standing-* names
  const allAgents = loadAgents();
  const standingAgentNames = Array.from(allAgents.keys()).filter(n => n.startsWith('standing-'));

  // Load all schedules
  let allSchedules: Awaited<ReturnType<typeof listSchedules>> = [];
  try {
    allSchedules = await listSchedules(tenantId, {});
  } catch {
    /* DB unavailable — continue with empty */
  }

  // Filter schedules targeting standing agents
  const standingSchedules = allSchedules.filter(
    s => s.target.startsWith('standing-') || (s.kind === 'agent' && standingAgentNames.includes(s.target)),
  );

  // Build a map from agent name → schedule
  const scheduleByAgent = new Map<string, (typeof standingSchedules)[0]>();
  for (const s of standingSchedules) {
    if (!scheduleByAgent.has(s.target)) {
      scheduleByAgent.set(s.target, s);
    }
  }

  // Also collect any scheduled targets not yet in standingAgentNames (configured in schedules but missing from agents/)
  for (const s of standingSchedules) {
    if (!standingAgentNames.includes(s.target)) {
      standingAgentNames.push(s.target);
    }
  }

  const results = standingAgentNames.map(agentName => {
    const agent = allAgents.get(agentName);
    const schedule = scheduleByAgent.get(agentName);

    return {
      agent: agentName,
      loaded: !!agent,
      category: agent?.category ?? null,
      scheduled: !!schedule,
      scheduleId: schedule?.scheduleId ?? null,
      cronExpr: schedule?.cronExpr ?? null,
      enabled: schedule?.enabled ?? null,
      lastRun: schedule?.lastRun ?? null,
      lastStatus: schedule?.lastStatus ?? null,
      nextRun: schedule?.nextRun ?? null,
    };
  });

  const scheduled = results.filter(r => r.scheduled).length;
  const unscheduled = results.filter(r => !r.scheduled).length;

  return {
    total: results.length,
    scheduled,
    unscheduled,
    standingAgents: results,
  };
}

// ── NOTIFICATION handlers ────────────────────────────────

async function handleNotificationsSend(tenantId: string, args: Record<string, unknown>) {
  const message = args.message as string;
  if (!message) return { error: 'message is required' };

  return sendNotification(tenantId, {
    message,
    channels: args.channels as string[] | undefined,
    chatId: args.chatId as string | undefined,
    level: args.level as 'info' | 'warning' | 'error' | 'critical' | undefined,
    title: args.title as string | undefined,
    source: args.source as string | undefined,
  });
}

async function handleNotificationsHistory(tenantId: string, args: Record<string, unknown>) {
  const limit = (args.limit as number) || 20;
  const history = await getNotificationHistory(tenantId, limit);
  return { count: history.length, notifications: history };
}

async function handleNotificationsTest(tenantId: string, args: Record<string, unknown>) {
  const channel = (args.channel as string) || 'telegram';
  return sendNotification(tenantId, {
    message: 'Test notification from myAI gateway',
    channels: [channel],
    level: 'info',
    title: 'Connectivity Test',
    source: 'notifications_test',
  });
}

// ── HEALTH ALERTS handlers ──────────────────────────────

function handleHealthAlertsStatus() {
  const latest = getLatestHealthCheckResult();
  const status = getHealthAlertStatus();
  return { latest, alerting: status };
}

async function handleHealthAlertsRun() {
  const result = await runHealthCheck();
  return result;
}

// ── BRAIN handlers (BRAIN B2) ───────────────────────────
//
// The brain is a per-operator git store on the gateway host, not a Mongo
// collection — so ADR-010 scoping here is DIRECTORY isolation, not row
// filtering: the default (local single-operator) tenant uses the machine
// brain (pointer resolution, shared with `myai brain`), while any other
// tenant is confined to <myai home>/brains/<tenantId> and can never reach
// the operator's brain. `tenantId` is the server-derived ctx value —
// executeTool has already stripped any caller-supplied tenant.
// (brainEnvFor lives in core/distill.ts — shared with context_boot.)

/** Env for write ops: auto-inits the store on first use (idempotent). Tenant
 * stores never write the machine-wide brain.path pointer. */
function brainEnvEnsured(tenantId: string): NodeJS.ProcessEnv {
  const env = brainEnvFor(tenantId);
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) {
    brainInit({ dir, pointer: tenantId === SYSTEM_CONTEXT.tenantId }, env);
    log.info({ dir, tenantId }, 'Brain store auto-initialized');
  }
  return env;
}

function handleBrainStatus(tenantId: string) {
  return brainStatus(brainEnvFor(tenantId));
}

function handleBrainHealth(tenantId: string, args: Record<string, unknown>) {
  const record = typeof args.record === 'boolean' ? args.record : undefined;
  return computeBrainHealth(brainEnvFor(tenantId), record === undefined ? {} : { record });
}

function handleBrainManifest(tenantId: string) {
  return brainManifest(brainEnvFor(tenantId));
}

function handleBrainExplore(tenantId: string, args: Record<string, unknown>) {
  const sections = Array.isArray(args.sections)
    ? (args.sections.filter((s): s is BrainSection => s === 'atoms' || s === 'stashes' || s === 'provenance'))
    : undefined;
  return brainExplore({ atomLimit: args.atomLimit as number | undefined, sections }, brainEnvFor(tenantId));
}

function handleBrainCommit(tenantId: string, args: Record<string, unknown>) {
  const hasProvenance = args.code_repo || args.code_branch || args.code_sha || args.code_commits;
  const result = writeAtom({
    kind: args.kind as AtomKind,
    repo: args.repo as string | undefined,
    slug: args.slug as string,
    content: args.content as string,
    code: hasProvenance ? {
      repo: args.code_repo as string | undefined,
      branch: args.code_branch as string | undefined,
      sha: args.code_sha as string | undefined,
      commits: args.code_commits as string[] | undefined,
    } : undefined,
  }, brainEnvEnsured(tenantId));
  // Session-atom quality lint (non-blocking): the atom is already committed —
  // this only surfaces a nudge to enrich, never a rejection.
  if (result.lint?.warnings.length) {
    log.warn({ path: result.path, warnings: result.lint.warnings }, 'brain_commit: session atom quality lint flagged this write');
  }
  return { ...result, deduped: !result.created };
}

function handleBrainStash(tenantId: string, args: Record<string, unknown>) {
  return brainStash({
    slug: args.slug as string,
    content: args.content as string,
    repo: args.repo as string | undefined,
  }, brainEnvEnsured(tenantId));
}

function handleBrainPop(tenantId: string, args: Record<string, unknown>) {
  return brainPop(args.slug as string | undefined, brainEnvFor(tenantId));
}

function handleBrainBranch(tenantId: string, args: Record<string, unknown>) {
  const env = brainEnvEnsured(tenantId);
  const slug = args.slug as string;
  const branch = args.kind === 'session' ? sessionStart(slug, env) : ideaBranch(slug, env);
  return { branch, kind: args.kind === 'session' ? 'session' : 'idea' };
}

function handleBrainCheckout(tenantId: string, args: Record<string, unknown>) {
  return { branch: brainCheckout(args.ref as string, brainEnvFor(tenantId)) };
}

function handleBrainMerge(tenantId: string, args: Record<string, unknown>) {
  const env = brainEnvFor(tenantId);
  const merged = sessionMerge(args.branch as string | undefined, env);
  // Compile-at-write (BRAIN B3): the merge is the write, so regenerate the
  // compiled artifacts on main right here — extractive, zero LLM tokens.
  const distilled = distillAfterMerge(env);
  // Publish-and-reconcile: instead of a bare push (which another machine's
  // concurrent merge would reject, leaving the two mains diverged forever),
  // reconcileMain fetches origin and — if a second device already pushed —
  // does a deterministic 3-way merge, resolving compiled-artifact conflicts by
  // re-distilling from the union atom set (task-da19637c). Bounded + non-fatal;
  // offline stays first-class (BRAIN_OFFLINE.md).
  const sync = reconcileMain(env);
  // Activation funnel: the wrap-up merge is the continuity "aha" — a session was
  // folded into the brain, closing the loop the product sells. First one stamps
  // the terminal activation milestone. Idempotent, fire-and-forget.
  void recordActivation(tenantId, 'wrapup_merge', { repo: args.repo as string | undefined });
  return {
    merged,
    into: 'main',
    distilled,
    pushed: sync.pushed ?? false,
    ...(sync.reason ? { pushSkipped: sync.reason } : {}),
    // Surface a concurrent-device heal so the operator sees it happened.
    ...(sync.strategy === 'merge' || sync.strategy === 'ff'
      ? { reconciled: { strategy: sync.strategy, resolvedArtifacts: sync.resolvedArtifacts ?? [], distilled: sync.distilled ?? [] } }
      : {}),
  };
}

function handleBrainLog(tenantId: string, args: Record<string, unknown>) {
  const entries = brainLog({
    ref: args.ref as string | undefined,
    path: args.path as string | undefined,
    limit: args.limit as number | undefined,
  }, brainEnvFor(tenantId));
  return { count: entries.length, entries };
}

function handleBrainDiff(tenantId: string, args: Record<string, unknown>) {
  return brainDiff({
    from: args.from as string | undefined,
    to: args.to as string | undefined,
    path: args.path as string | undefined,
    patch: args.patch as boolean | undefined,
  }, brainEnvFor(tenantId));
}

function handleBrainBlame(tenantId: string, args: Record<string, unknown>) {
  return brainBlame({
    codeSha: args.code_sha as string | undefined,
    ref: args.ref as string | undefined,
    limit: args.limit as number | undefined,
  }, brainEnvFor(tenantId));
}

function handleBrainRevert(tenantId: string, args: Record<string, unknown>) {
  return brainRevert(args.sha as string, brainEnvFor(tenantId));
}

async function handleBrainSearch(tenantId: string, args: Record<string, unknown>) {
  const query = args.query as string;
  if (!query || !query.trim()) return { error: 'query is required' };

  let since: Date | undefined;
  const sinceRaw = args.since as string | undefined;
  if (sinceRaw) {
    const d = new Date(sinceRaw);
    if (Number.isNaN(d.getTime())) return { error: `Invalid 'since' date: ${sinceRaw}` };
    since = d;
  }

  return federatedBrainSearch(tenantId, {
    query,
    repo: args.repo as string | undefined,
    k: args.k as number | undefined,
    since,
    atomLimit: args.atomLimit as number | undefined,
  }, brainEnvFor(tenantId));
}

// ── entity/temporal layer handlers (BRAIN B10) ────────────────────────────
// Read-only, deterministic, no LLM: both build the augmenting entity index by
// scanning the brain atoms (the same read path as brain_explore) and query it.

function handleBrainEntity(tenantId: string, args: Record<string, unknown>) {
  return brainEntity({
    query: args.query as string | undefined,
    kind: args.kind as EntityKind | undefined,
    repo: args.repo as string | undefined,
    limit: args.limit as number | undefined,
    touchLimit: args.touchLimit as number | undefined,
    atomLimit: args.atomLimit as number | undefined,
  }, brainEnvFor(tenantId));
}

function handleBrainTimeline(tenantId: string, args: Record<string, unknown>) {
  return brainTimeline({
    entity: args.entity as string | undefined,
    kind: args.kind as EntityKind | undefined,
    repo: args.repo as string | undefined,
    since: args.since as string | undefined,
    limit: args.limit as number | undefined,
    atomLimit: args.atomLimit as number | undefined,
  }, brainEnvFor(tenantId));
}

function handleBrainCommunities(tenantId: string, args: Record<string, unknown>) {
  return brainCommunities({
    query: args.query as string | undefined,
    repo: args.repo as string | undefined,
    minSize: args.minSize as number | undefined,
    limit: args.limit as number | undefined,
    atomLimit: args.atomLimit as number | undefined,
  }, brainEnvFor(tenantId));
}

// ── per-namespace sharing handlers ────────────────────────────────────────
// Owner-side (share/unshare/grants) act on THIS tenant's own brain, gated by
// the caller's own RBAC role. Grantee-side (read/write) act on ANOTHER
// tenant's brain (`ownerTenantId` from args — sharing requires naming who
// shared with you); the grantee identity is always the server-derived
// `ctx.tenantId`, never a caller-supplied value, so a tenant can only ever
// exercise a grant issued to ITSELF.

function handleBrainNamespaceShare(tenantId: string, args: Record<string, unknown>, ctx: ToolContext) {
  return grantNamespaceAccess(
    args.namespace as string,
    args.granteeTenantId as string,
    args.level as NamespaceGrantLevel,
    ctx.role,
    { grantedBy: ctx.userId },
    brainEnvFor(tenantId),
  );
}

function handleBrainNamespaceUnshare(tenantId: string, args: Record<string, unknown>, ctx: ToolContext) {
  revokeNamespaceAccess(args.namespace as string, args.granteeTenantId as string, ctx.role, brainEnvFor(tenantId));
  return { revoked: true, namespace: args.namespace, granteeTenantId: args.granteeTenantId };
}

function handleBrainNamespaceGrants(tenantId: string, args: Record<string, unknown>, ctx: ToolContext) {
  const grants = listNamespaceGrants(
    args.namespace as string,
    ctx.role,
    { activeOnly: args.activeOnly as boolean | undefined },
    brainEnvFor(tenantId),
  );
  return { namespace: args.namespace, grants };
}

function handleBrainNamespaceRead(tenantId: string, args: Record<string, unknown>, ctx: ToolContext) {
  return readSharedNamespace(
    args.namespace as string,
    tenantId,
    ctx.role,
    { limit: args.limit as number | undefined },
    brainEnvFor(args.ownerTenantId as string),
  );
}

function handleBrainNamespaceWrite(tenantId: string, args: Record<string, unknown>, ctx: ToolContext) {
  return writeSharedNamespaceAtom(
    args.namespace as string,
    tenantId,
    ctx.role,
    { kind: args.kind as 'session' | 'handoff', slug: args.slug as string, content: args.content as string },
    brainEnvFor(args.ownerTenantId as string),
  );
}

// ── Hosted brain remote handlers (ADR-017) ────────────────────────────────
// Plan comes from the server-derived ctx (auth.ts populates it from the tenant
// record), never from args. hosted-brain.ts refuses the local operator tenant
// and any non-entitled plan.

function handleBrainHostProvision(ctx: ToolContext) {
  return provisionHostedBrain(ctx.tenantId, ctx.plan ?? 'free');
}

function handleBrainHostStatus(ctx: ToolContext) {
  return hostedBrainInfo(ctx.tenantId);
}

function handleBrainHostRotate(ctx: ToolContext) {
  return rotateHostedToken(ctx.tenantId);
}

function handleBrainDelta(tenantId: string, args: Record<string, unknown>) {
  const result = brainDelta({
    since: args.since as string | undefined,
    repo: args.repo as string | undefined,
    budget: args.budget as number | undefined,
  }, brainEnvFor(tenantId));
  // Continuity meter: a delta catch-up replaces a full legacy session-start
  // re-read, same as context_boot. Fire-and-forget.
  void recordContextServed(tenantId, {
    repo: args.repo as string | undefined,
    tool: 'brain_delta',
    tokens: result.tokenEstimate,
    baselineTokens: estimateLegacyBootTokens(),
    userId: args.userId as string | undefined,
  });
  // Activation funnel: first delta catch-up = the tenant reached "first brain
  // delta" — a returning session got the cheap diff. Idempotent, fire-and-forget.
  void recordActivation(tenantId, 'first_brain_delta', { repo: args.repo as string | undefined });
  return result;
}
