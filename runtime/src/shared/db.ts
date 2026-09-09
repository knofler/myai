import mongoose, { Schema, type Document, type Model } from 'mongoose';
import { getConfig } from './config.js';
import { getLogger } from './logger.js';
import { readOnlyGuardPlugin, activateDbFailover } from './db-failover.js';

// Re-exported so callers keep a single db entry point for failover state.
export { getDbFailoverState, resetDbFailover, assertDbWritable, DbReadOnlyError } from './db-failover.js';

// ── Multi-tenancy (ADR-010, M1) ─────────────────────────
// The tenant every existing/single-operator record maps to. Used as the
// schema `default` on every tenant-scoped collection so the data model is
// non-breaking: legacy rows + any write that predates the auth layer land in
// this tenant rather than null (a null tenantId would silently escape
// per-tenant filters). Read from env so it matches `config.tenancy.defaultTenantId`
// — defined here (not via getConfig) because schema defaults are evaluated at
// module-load, before the gateway config is necessarily loaded.
export const DEFAULT_TENANT_ID = process.env.DEFAULT_TENANT_ID || 'default';

/** Reusable schema field for a tenant-scoped collection. */
const tenantField = { type: String, required: true, default: DEFAULT_TENANT_ID, index: true } as const;

// ── Gateway Session ─────────────────────────────────────

export interface IGatewaySession extends Document {
  tenantId: string;
  sessionId: string;
  agentName: string;
  status: 'active' | 'idle' | 'compacting' | 'closed';
  messages: Array<{
    id: string;
    role: string;
    content: string;
    agentName?: string;
    channelType?: string;
    channelId?: string;
    metadata: Record<string, unknown>;
    timestamp: Date;
  }>;
  workspace: string;
  compactionCount: number;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
}

const gatewayMessageSubSchema = new Schema({
  id: { type: String, required: true },
  role: { type: String, required: true, enum: ['user', 'assistant', 'system', 'channel'] },
  content: { type: String, required: true },
  agentName: String,
  channelType: String,
  channelId: String,
  metadata: { type: Schema.Types.Mixed, default: {} },
  timestamp: { type: Date, default: Date.now },
}, { _id: false });

const gatewaySessionSchema = new Schema<IGatewaySession>({
  tenantId: tenantField,
  sessionId: { type: String, required: true, unique: true, index: true },
  agentName: { type: String, required: true, index: true },
  status: { type: String, required: true, enum: ['active', 'idle', 'compacting', 'closed'], default: 'active' },
  messages: [gatewayMessageSubSchema],
  workspace: { type: String, default: '' },
  compactionCount: { type: Number, default: 0 },
  metadata: { type: Schema.Types.Mixed, default: {} },
  closedAt: Date,
}, { timestamps: true });

gatewaySessionSchema.index({ status: 1, updatedAt: -1 });
gatewaySessionSchema.index({ tenantId: 1, status: 1, updatedAt: -1 });

// ── SONA Pattern (extended with embedding) ──────────────

export interface IAIPattern extends Document {
  patternId: string;
  title: string;
  description: string;
  tags: string[];
  category: string;
  context: Record<string, unknown>;
  pattern: Record<string, unknown>;
  outcome: Record<string, unknown>;
  confidence: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  lastUsed: Date;
  lastScored: Date;
  embedding?: number[];
  createdBy: string;
  createdAt: Date;
}

const aiPatternSchema = new Schema<IAIPattern>({
  patternId: { type: String, required: true, unique: true, index: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  tags: { type: [String], index: true },
  category: { type: String, default: 'approach' },
  context: { type: Schema.Types.Mixed, default: {} },
  pattern: { type: Schema.Types.Mixed, default: {} },
  outcome: { type: Schema.Types.Mixed, default: {} },
  confidence: { type: Number, default: 0.5, index: true },
  usageCount: { type: Number, default: 0 },
  successCount: { type: Number, default: 0 },
  failureCount: { type: Number, default: 0 },
  lastUsed: { type: Date, default: Date.now },
  lastScored: { type: Date, default: Date.now },
  embedding: { type: [Number], select: false },
  createdBy: { type: String, default: 'system' },
  createdAt: { type: Date, default: Date.now },
});

aiPatternSchema.index({ tags: 1, confidence: -1 });

// ── Agent Definition ───────────────────────────────────

export interface IAgent extends Document {
  name: string;
  description: string;
  tools: string[];
  category: string;
  instructions: string;
  filePath: string;
  contentHash?: string;
  embedding?: number[];
  loadedAt: Date;
}

const agentSchema = new Schema<IAgent>({
  name: { type: String, required: true, unique: true, index: true },
  description: { type: String, default: '' },
  tools: { type: [String], default: [] },
  category: { type: String, default: 'core', index: true },
  instructions: { type: String, default: '' },
  filePath: { type: String, default: '' },
  contentHash: { type: String, default: '' },
  embedding: { type: [Number], select: false },
  loadedAt: { type: Date, default: Date.now },
});

agentSchema.index({ category: 1, name: 1 });

// ── Skill Definition ──────────────────────────────────

export interface ISkill extends Document {
  name: string;
  description: string;
  triggers: string[];
  playbook: string;
  filePath: string;
  contentHash?: string;
  embedding?: number[];
  loadedAt: Date;
}

const skillSchema = new Schema<ISkill>({
  name: { type: String, required: true, unique: true, index: true },
  description: { type: String, default: '' },
  triggers: { type: [String], default: [] },
  playbook: { type: String, default: '' },
  filePath: { type: String, default: '' },
  contentHash: { type: String, default: '' },
  embedding: { type: [Number], select: false },
  loadedAt: { type: Date, default: Date.now },
});

skillSchema.index({ triggers: 1 });

// ── Hook Definition ───────────────────────────────────

/** Governance record of the most recent PATCH /api/hooks toggle (task-bd18a5ec). */
export interface IHookLastToggle {
  actorUserId?: string;
  role: string;
  via: string;
  previousState: boolean;
  newState: boolean;
  at: Date;
}

export interface IHook extends Document {
  name: string;
  events: string[];
  priority: number;
  timeout: number;
  enabled: boolean;
  source: 'builtin' | 'user' | 'bash';
  scriptPath?: string;
  loadedAt: Date;
  lastToggle?: IHookLastToggle;
}

const hookLastToggleSchema = new Schema<IHookLastToggle>(
  {
    actorUserId: { type: String },
    role: { type: String, required: true },
    via: { type: String, required: true },
    previousState: { type: Boolean, required: true },
    newState: { type: Boolean, required: true },
    at: { type: Date, required: true },
  },
  { _id: false },
);

const hookSchema = new Schema<IHook>({
  name: { type: String, required: true, unique: true, index: true },
  events: { type: [String], required: true },
  priority: { type: Number, default: 50 },
  timeout: { type: Number, default: 5000 },
  enabled: { type: Boolean, default: true },
  source: { type: String, enum: ['builtin', 'user', 'bash'], default: 'user' },
  scriptPath: { type: String },
  loadedAt: { type: Date, default: Date.now },
  lastToggle: { type: hookLastToggleSchema },
});

hookSchema.index({ events: 1, enabled: 1 });

// ── Rule Definition ───────────────────────────────────

export interface IRule extends Document {
  name: string;
  description: string;
  category: string;
  content: string;
  filePath: string;
  contentHash?: string;
  loadedAt: Date;
}

const ruleSchema = new Schema<IRule>({
  name: { type: String, required: true, unique: true, index: true },
  description: { type: String, default: '' },
  category: { type: String, default: 'general', index: true },
  content: { type: String, default: '' },
  filePath: { type: String, default: '' },
  contentHash: { type: String, default: '' },
  loadedAt: { type: Date, default: Date.now },
});

// ── Vector (RAG) ─────────────────────────────────────────

export interface IVector extends Document {
  tenantId: string;
  repo: string;
  source: 'state' | 'handoff' | 'commit' | 'pr' | 'pattern' | 'bug' | 'code' | 'feature' | 'archive' | 'external' | 'brain';
  content: string;
  embedding: number[];
  tags: string[];
  sessionId: string;
  metadata: Record<string, unknown>;
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
}

const vectorSchema = new Schema<IVector>({
  tenantId: tenantField,
  repo: { type: String, required: true, index: true },
  source: { type: String, required: true, enum: ['state', 'handoff', 'commit', 'pr', 'pattern', 'bug', 'code', 'feature', 'archive', 'external', 'brain'], index: true },
  content: { type: String, required: true },
  embedding: { type: [Number], required: true },
  tags: { type: [String], default: [], index: true },
  sessionId: { type: String, default: '' },
  metadata: { type: Schema.Types.Mixed, default: {} },
  contentHash: { type: String, required: true, index: true },
}, { timestamps: true });

// Unique key leads with tenantId so two tenants can embed the same repo/source/content.
// The old { repo, source, contentHash } unique index is dropped by migration 001 (syncIndexes).
vectorSchema.index({ tenantId: 1, repo: 1, source: 1, contentHash: 1 }, { unique: true });
vectorSchema.index({ tenantId: 1, repo: 1, tags: 1 });

// ── Task (Phase 2 queue) ─────────────────────────────────

export type TaskStatus = 'pending' | 'working' | 'review' | 'done' | 'blocked' | 'paused' | 'dead_letter';
export type TaskPriority = 'P0' | 'P1' | 'P2' | 'P3';
export type TaskSource = 'manual' | 'connect-hub' | 'auto-detected' | 'scheduler' | 'telegram' | 'github';

export interface ITask extends Document {
  tenantId: string;
  taskId: string;
  repo: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  assignedAgent?: string;
  recommendedModel?: string;
  source: TaskSource;
  sourceId?: string;
  prUrl?: string;
  notes?: string;
  telegramMessageId?: number;
  // Router audit trail (task-d9300dac) — the capability×cost×availability
  // router's (route_task_model, cli_task_runner.sh) actual per-task decision,
  // stamped by the runner at claim time so it's queryable after the fact
  // instead of only ever existing in the runner's stdout log.
  routedProfile?: string;
  routedModel?: string;
  routedComplexity?: string;
  // Execution-lane stamp (task-b1776200) — which backend actually produced
  // the shipped diff: the normal Claude CLI session, or the non-Claude
  // agentic FALLBACK lane (scripts/lib/openai_agent.py, DeepSeek/Kimi) that
  // engages when the Claude session window is exhausted. Stamped by the
  // runner at review close-off, once USED_MODEL is settled — distinct from
  // routedModel/recommendedModel, which reflect the *planned* route, not
  // necessarily what actually executed after any fallback.
  executionLane?: 'claude' | 'agentic-fallback';
  executionProvider?: string;
  // Work-type routing stamp (task-de8b40ff) — the 13-work-type routing table
  // (WORK_TYPE_TIER_MAP, plan/MULTI_PROVIDER_ORCHESTRATION.md §3, wired in
  // db9e937) resolves a `workType` hint to a primary tier plus a documented
  // first-hop failover, but that decision only ever existed as an MCP
  // routing_info response or a line in the runner's stdout log — never on the
  // task doc itself. Stamped by the runner at claim time (same edge as
  // routedProfile/routedModel/routedComplexity above) so an operator can see
  // WHICH work-type lane + failover hop a task was actually routed through.
  workType?: string;
  workTypeTier?: string;
  workTypeFailoverHop?: string;
  // ADR-011 slice 2 — atomic cross-machine claim/lease. Set by claimTask()
  // (findOneAndUpdate pending→working) so two runners can never double-pick.
  claimedBy?: string;
  claimedAt?: Date;
  leaseUntil?: Date;
  startedAt?: Date;
  completedAt?: Date;
  // Priority preemption (ADR-011 follow-on) — set when a P0/P1 task arrives
  // and every runner-lease slot is busy on lower-priority work: the lowest-
  // priority in-flight task is paused (status → 'paused') in its favour and
  // resumed (paused → 'pending') once the urgent task clears.
  preemptedBy?: string;
  preemptedAt?: Date;
  // Bulk-block guard (tasks/bulk-block-guard.ts) — explicit supersession
  // record. Set when a pending→blocked transition is authorized because a
  // named replacement task takes over the work, exempting it from the guard's
  // unauthorized-transition counter without needing operatorAuthorized:true.
  supersededBy?: string;
  // Bounded retry-with-backoff (dead-letter queue). failTask() bumps
  // retryCount on every genuine runner failure; while under maxRetries the
  // task is released back to 'pending' with nextRetryAt pushed out by
  // exponential backoff (claimTask()'s pending filter honors it), so it isn't
  // immediately re-picked and hammered. Once exhausted, status → 'dead_letter'
  // (deadLetteredAt stamped) instead of silently re-looping forever — surfaced
  // on the dashboard's Dead Letter tab for operator triage.
  retryCount: number;
  maxRetries: number;
  nextRetryAt?: Date;
  deadLetteredAt?: Date;
  lastError?: string;
  // Consecutive route_task_model exhaustion-defer streak (task-1a74f8c3,
  // monitoring/task-defer-alerter.ts's in-process counter, mirrored onto the
  // doc so it's queryable — same pattern as retryCount above). Stamped by
  // task-store.ts's updateTaskImpl on every routeExhausted:true defer; reset
  // to 0 the next time the task re-stamps `working` with a real routed model.
  deferCount?: number;
  // Team-tier per-member budget scoping (task-82854b12) — the tenant member
  // (User.userId) this task is attributed to, when created on behalf of a
  // signed-in member (dashboard). Absent on system/CLI/scheduler-created
  // tasks, which are never subject to a per-member cap. This is the field
  // claimTask() reads to exclude a capped-out member's tasks from the
  // claimable set — see tasks/member-budget-guard.ts.
  requestedByUserId?: string;
  // Task dependency graph (task-cafdd778) — upstream taskIds this task waits
  // on. claimTask() refuses to hand out a task until EVERY listed upstream is
  // status 'done' (DAG scheduling: "migrate DB → then build UI" plans the
  // flat queue can't express). createTask/updateTask validate that upstreams
  // exist (tenant-scoped) and that an edit never introduces a cycle. Absent /
  // empty = independent task, exactly the pre-existing flat-queue behaviour.
  dependsOn?: string[];
  createdAt: Date;
  updatedAt: Date;
}

const taskSchema = new Schema<ITask>({
  tenantId: tenantField,
  taskId: { type: String, required: true, unique: true, index: true },
  repo: { type: String, required: true, index: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  priority: { type: String, required: true, enum: ['P0', 'P1', 'P2', 'P3'], default: 'P2', index: true },
  status: { type: String, required: true, enum: ['pending', 'working', 'review', 'done', 'blocked', 'paused', 'dead_letter'], default: 'pending', index: true },
  assignedAgent: { type: String },
  recommendedModel: { type: String },
  source: { type: String, required: true, enum: ['manual', 'connect-hub', 'auto-detected', 'scheduler', 'telegram', 'github'], default: 'manual' },
  sourceId: { type: String },
  prUrl: { type: String },
  notes: { type: String },
  telegramMessageId: { type: Number },
  routedProfile: { type: String },
  executionLane: { type: String, enum: ['claude', 'agentic-fallback'] },
  executionProvider: { type: String },
  workType: { type: String },
  workTypeTier: { type: String },
  workTypeFailoverHop: { type: String },
  routedModel: { type: String },
  routedComplexity: { type: String },
  claimedBy: { type: String },
  claimedAt: { type: Date },
  leaseUntil: { type: Date },
  startedAt: { type: Date },
  completedAt: { type: Date },
  preemptedBy: { type: String },
  preemptedAt: { type: Date },
  supersededBy: { type: String },
  retryCount: { type: Number, required: true, default: 0 },
  maxRetries: { type: Number, required: true, default: 3 },
  nextRetryAt: { type: Date },
  deadLetteredAt: { type: Date },
  lastError: { type: String },
  deferCount: { type: Number, default: 0 },
  requestedByUserId: { type: String },
  // default undefined (not []) so dependency-free docs — including every
  // pre-existing task — carry no field at all and claimTask()'s
  // {$exists:false} fast path matches them without a migration.
  dependsOn: { type: [String], default: undefined },
}, { timestamps: true });

// ── Task index strategy (hot path — polled every runner fire) ───────────
// Every runtime query is tenant-scoped (scoped-query.ts pins tenantId as the
// leading equality), so serving indexes lead with tenantId:
//   • claimTask()/nextTask() — filter {tenantId, status:'pending'} sorted
//     {priority:1, createdAt:1}. The 4-key index satisfies filter AND sort in
//     one pass (no in-memory SORT stage on the runner pickup query).
//   • listTasks()/countTasks() with a repo filter — {tenantId, repo, status}.
//   • updateTask() — {tenantId, taskId}; served by the unique taskId index
//     (taskId is globally unique, tenantId is a residual filter on ≤1 doc).
// The old {tenantId, status, priority} declaration was dropped as a strict
// prefix of the 4-key index; existing deployments keep it harmlessly until a
// migration drops it.
taskSchema.index({ tenantId: 1, status: 1, priority: 1, createdAt: 1 });
taskSchema.index({ tenantId: 1, repo: 1, status: 1 });
// Per-member budget scoping (task-82854b12) — claimTask()'s $nin exclusion
// filter on requestedByUserId piggybacks the above compound index (sparse
// residual field); a dedicated index isn't warranted until per-member caps
// see real Team-tier traffic.
// Legacy pre-tenancy (ADR-010) shapes — kept declared for unscoped
// admin/migration queries; drop via migration once nothing unscoped remains.
taskSchema.index({ repo: 1, status: 1, priority: 1 });
taskSchema.index({ status: 1, priority: 1, createdAt: 1 });

// ── RunnerLease (ADR-011 slice 3 — fleet-wide runner concurrency) ──
// One document per slot per tenant. The N slots (N = active Claude accounts,
// start 2) cap concurrent autonomous sessions ACROSS machines — replacing the
// per-machine /tmp slot dirs, which could never see the other Mac's runners.

export interface IRunnerLease extends Document {
  tenantId: string;
  slot: number;
  /** Runner identity holding the slot, e.g. "runner-host/12345". */
  holder: string;
  /** Hostname, for fleet visibility (holder already embeds it by convention). */
  machine?: string;
  /** Claude account/profile bound to this slot, e.g. "claude-tech" (slice 6). */
  account?: string;
  /** Task being worked under this lease, for dashboard visibility. */
  taskId?: string;
  acquiredAt: Date;
  heartbeatAt: Date;
  leaseUntil: Date;
  createdAt: Date;
  updatedAt: Date;
}

const runnerLeaseSchema = new Schema<IRunnerLease>({
  tenantId: tenantField,
  slot: { type: Number, required: true },
  holder: { type: String, required: true },
  machine: { type: String },
  account: { type: String },
  taskId: { type: String },
  acquiredAt: { type: Date, required: true },
  heartbeatAt: { type: Date, required: true },
  leaseUntil: { type: Date, required: true },
}, { timestamps: true, collection: 'runner_leases' });   // ADR-011 names the collection

// The atomic upsert in acquireLease() relies on this unique index: two runners
// racing for the same free slot → one insert wins, the loser gets E11000 and
// tries the next slot. Never double-granted.
runnerLeaseSchema.index({ tenantId: 1, slot: 1 }, { unique: true });
// TTL garbage collection: purge a lease ~1h after it expires. Stale-slot RECLAIM
// is handled atomically inside acquireLease (leaseUntil < now → new holder takes
// over immediately); this index only sweeps leftovers of crashed runners so the
// collection stays tiny. Mongo's TTL monitor lags up to 60s — never rely on it
// for correctness.
runnerLeaseSchema.index({ leaseUntil: 1 }, { expireAfterSeconds: 3600 });

// ── RunnerLeaseHistory (ADR-011 slice 7 — runs log) ──
// RunnerLease only exists while a slot is HELD — release deletes the doc, so
// there is no operator-visible record of "which account/slot ran which task
// and for how long" once the run ends (today: grep raw Mongo / gateway logs).
// This is an append-only history row written whenever a slot stops being held
// (runner-lease-store.ts: explicit release, or a forced release on account
// mismatch) — the source for the runs-log dashboard view. A TTL index bounds
// growth automatically; this is diagnostic history, not a system of record.

export interface IRunnerLeaseHistory extends Document {
  tenantId: string;
  slot: number;
  holder: string;
  machine?: string;
  account?: string;
  taskId?: string;
  acquiredAt: Date;
  releasedAt: Date;
  durationMs: number;
  reason: 'released' | 'reclaimed' | 'account_mismatch';
  createdAt: Date;
  updatedAt: Date;
}

const runnerLeaseHistorySchema = new Schema<IRunnerLeaseHistory>({
  tenantId: tenantField,
  slot: { type: Number, required: true },
  holder: { type: String, required: true },
  machine: { type: String },
  account: { type: String },
  taskId: { type: String },
  acquiredAt: { type: Date, required: true },
  releasedAt: { type: Date, required: true },
  durationMs: { type: Number, required: true },
  reason: { type: String, enum: ['released', 'reclaimed', 'account_mismatch'], required: true },
}, { timestamps: true, collection: 'runner_lease_history' });

// Newest-first per-tenant listing is the only query shape the dashboard/MCP
// tool needs.
runnerLeaseHistorySchema.index({ tenantId: 1, releasedAt: -1 });
// TTL: keep ~60 days of runs-log history, then GC — bounds an append-only
// collection without a separate rotation job.
runnerLeaseHistorySchema.index({ releasedAt: 1 }, { expireAfterSeconds: 60 * 24 * 3600 });

// ── RunnerBacklogCursor (task-e9163eb9 — cross-machine backlog-well cursor) ──
// scripts/queue_topup.sh computed REMAINING = TOTAL - CONSUMED from CONSUMED
// read out of a gitignored, machine-local file (config/.runner_backlog.cursor).
// In a fresh checkout/worktree (no local file) CONSUMED silently reads 0
// regardless of the real consumption state on whichever machine actually
// drives the runner, so `--report` and the low-backlog check gave different
// answers depending on which checkout ran them. One document per tenant now
// holds the authoritative consumed-count in Mongo, mirroring how RunnerLease
// above (and tasks_list) are already the cross-machine source of truth for
// other runner state.

export interface IRunnerBacklogCursor extends Document {
  tenantId: string;
  consumed: number;
  createdAt: Date;
  updatedAt: Date;
}

const runnerBacklogCursorSchema = new Schema<IRunnerBacklogCursor>({
  tenantId: tenantField,
  consumed: { type: Number, required: true, default: 0 },
}, { timestamps: true, collection: 'runner_backlog_cursor' });

// One cursor doc per tenant — upserted in place, never duplicated.
runnerBacklogCursorSchema.index({ tenantId: 1 }, { unique: true });

// ── RunnerHeartbeat (liveness alerting — distinct from RunnerLease above) ──
// RunnerLease only has a document while a runner HOLDS a task-concurrency
// slot, i.e. mid-session. It says nothing about whether the off-hours runner
// process itself is alive between fires. This is a separate, always-updated
// per-machine "I fired" pulse, written once per launchd fire regardless of
// whether a task was claimed, so an operator (or health-alerter) can tell
// "no heartbeat in N minutes" apart from "no work to do right now".

export interface IRunnerHeartbeat extends Document {
  tenantId: string;
  /** Hostname the runner fired on, e.g. "runner-host". */
  machine: string;
  /** Runner identity for this fire, e.g. "runner-host/12345". */
  holder: string;
  lastHeartbeatAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const runnerHeartbeatSchema = new Schema<IRunnerHeartbeat>({
  tenantId: tenantField,
  machine: { type: String, required: true },
  holder: { type: String, required: true },
  lastHeartbeatAt: { type: Date, required: true },
}, { timestamps: true, collection: 'runner_heartbeats' });

// One doc per machine per tenant — each fire upserts its own machine's pulse.
runnerHeartbeatSchema.index({ tenantId: 1, machine: 1 }, { unique: true });

// ── FleetMaintenance (operator kill-switch — distinct from RunnerHeartbeat) ──
// RunnerHeartbeat/RunnerLease report runner *liveness*; this controls whether a
// live runner is *allowed* to claim work. One doc per tenant (the fleet-wide
// switch), read by task-store.claimTask on every claim and mirrored read-only
// by the dashboard (dashboard/src/lib/db.ts) for the maintenance banner — a
// Mongo-backed store (not an in-memory registry like llm/provider-maintenance.ts)
// because both the gateway process and the separate dashboard process need to
// see the same state.

export interface IFleetMaintenance extends Document {
  tenantId: string;
  active: boolean;
  reason?: string;
  operator?: string;
  enteredAt?: Date;
  /** Schedulable auto-resume time. Absent = paused indefinitely until explicit exit. */
  resumeAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const fleetMaintenanceSchema = new Schema<IFleetMaintenance>({
  tenantId: tenantField,
  active: { type: Boolean, required: true, default: false },
  reason: { type: String },
  operator: { type: String },
  enteredAt: { type: Date },
  resumeAt: { type: Date },
}, { timestamps: true, collection: 'fleet_maintenance' });

// One doc per tenant — the fleet-wide switch is a singleton per tenant.
fleetMaintenanceSchema.index({ tenantId: 1 }, { unique: true });

// ── Schedule (Phase 3 autonomous scheduler) ──────────────

export type ScheduleKind = 'agent' | 'skill' | 'tool';
export type ScheduleStatus = 'never' | 'success' | 'error';

export interface ISchedule extends Document {
  tenantId: string;
  scheduleId: string;
  name: string;
  cronExpr: string;
  kind: ScheduleKind;
  target: string;
  message: string;
  repo?: string;
  includeMemoryContext: boolean;
  enabled: boolean;
  lastRun?: Date;
  nextRun?: Date;
  lastStatus: ScheduleStatus;
  lastError?: string;
  lastResultSummary?: string;
  runCount: number;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const scheduleSchema = new Schema<ISchedule>({
  tenantId: tenantField,
  scheduleId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  cronExpr: { type: String, required: true },
  kind: { type: String, required: true, enum: ['agent', 'skill', 'tool'] },
  target: { type: String, required: true },
  message: { type: String, required: true },
  repo: { type: String },
  includeMemoryContext: { type: Boolean, default: false },
  enabled: { type: Boolean, default: true, index: true },
  lastRun: { type: Date },
  nextRun: { type: Date, index: true },
  lastStatus: { type: String, required: true, enum: ['never', 'success', 'error'], default: 'never' },
  lastError: { type: String },
  lastResultSummary: { type: String },
  runCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
}, { timestamps: true });

scheduleSchema.index({ enabled: 1, nextRun: 1 });
scheduleSchema.index({ tenantId: 1, enabled: 1, nextRun: 1 });

// ── RecurringTask (first-class repeating runner jobs — task-b8ddab7d) ──
//
// A cron-cadenced TEMPLATE that the recurring sweep re-enqueues into the Task
// queue as ordinary one-shot entries (source='scheduler', sourceId=recurringId)
// for the launchd CLI runner to claim. Distinct from ISchedule: a Schedule
// dispatches an MCP tool/agent/skill in-gateway at fire time; a RecurringTask
// schedules WORK — it creates a queue Task the runner executes in a repo
// worktree (e.g. nightly state rotation, weekly dep-scan) so the operator
// stops re-adding the same one-shots by hand.

/** 'skip' (default): don't enqueue while the previously fired task is still
 *  open (not done/dead_letter) — no pileup of identical maintenance tasks.
 *  'stack': always enqueue on cadence regardless of the previous instance. */
export type RecurringOverlapPolicy = 'skip' | 'stack';
export type RecurringFireStatus = 'never' | 'enqueued' | 'skipped' | 'error';

export interface IRecurringTask extends Document {
  tenantId: string;
  recurringId: string;
  name: string;
  cronExpr: string;
  /** Task template — mirrors CreateTaskInput (tasks/task-store.ts). */
  repo: string;
  title: string;
  description: string;
  priority: TaskPriority;
  assignedAgent?: string;
  recommendedModel?: string;
  notes?: string;
  overlapPolicy: RecurringOverlapPolicy;
  enabled: boolean;
  nextFireAt?: Date;
  lastFiredAt?: Date;
  lastFireStatus: RecurringFireStatus;
  /** taskId of the most recently enqueued one-shot — the overlap-check anchor. */
  lastTaskId?: string;
  lastError?: string;
  enqueueCount: number;
  skipCount: number;
  errorCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const recurringTaskSchema = new Schema<IRecurringTask>({
  tenantId: tenantField,
  recurringId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  cronExpr: { type: String, required: true },
  repo: { type: String, required: true },
  title: { type: String, required: true },
  description: { type: String, default: '' },
  priority: { type: String, required: true, enum: ['P0', 'P1', 'P2', 'P3'], default: 'P2' },
  assignedAgent: { type: String },
  recommendedModel: { type: String },
  notes: { type: String },
  overlapPolicy: { type: String, required: true, enum: ['skip', 'stack'], default: 'skip' },
  enabled: { type: Boolean, default: true, index: true },
  nextFireAt: { type: Date, index: true },
  lastFiredAt: { type: Date },
  lastFireStatus: { type: String, required: true, enum: ['never', 'enqueued', 'skipped', 'error'], default: 'never' },
  lastTaskId: { type: String },
  lastError: { type: String },
  enqueueCount: { type: Number, default: 0 },
  skipCount: { type: Number, default: 0 },
  errorCount: { type: Number, default: 0 },
}, { timestamps: true, collection: 'recurring_tasks' });

// Same index strategy as scheduleSchema: the cross-tenant due sweep reads
// {enabled, nextFireAt}; tenant-scoped lists read {tenantId, enabled, nextFireAt}.
recurringTaskSchema.index({ enabled: 1, nextFireAt: 1 });
recurringTaskSchema.index({ tenantId: 1, enabled: 1, nextFireAt: 1 });

// ── Notification ────────────────────────────────────────

export interface INotification extends Document {
  tenantId: string;
  channel: string;
  chatId: string;
  message: string;
  level: 'info' | 'warning' | 'error' | 'critical';
  title?: string;
  source?: string;
  sentAt: Date;
  success: boolean;
  error?: string;
  /** Burst id from the delivery-path dedup tracker — repeat events with the same
   *  (tenantId, type, subject) inside the dedup window collapse into this same
   *  row (via upsert) instead of creating a new one per event. */
  dedupKey?: string;
  /** Number of events collapsed into this row so far (>1 renders as an "xN" suffix). */
  count?: number;
}

const notificationSchema = new Schema<INotification>({
  tenantId: tenantField,
  channel: { type: String, required: true, index: true },
  chatId: { type: String, required: true },
  message: { type: String, required: true },
  level: { type: String, required: true, enum: ['info', 'warning', 'error', 'critical'], default: 'info' },
  title: { type: String },
  source: { type: String, index: true },
  sentAt: { type: Date, required: true, default: Date.now, index: true },
  success: { type: Boolean, required: true, default: true },
  error: { type: String },
  dedupKey: { type: String },
  count: { type: Number },
});

// ── Notification index strategy (dashboard history poll) ────────────────
// getNotificationHistory() reads {tenantId} sorted {sentAt:-1} limit N on
// every dashboard refresh — the tenant+timestamp index serves filter AND
// sort together, so history never in-memory-sorts as the collection grows.
notificationSchema.index({ tenantId: 1, sentAt: -1 });
notificationSchema.index({ sentAt: -1 });             // unscoped ops/admin view
notificationSchema.index({ channel: 1, sentAt: -1 }); // per-channel delivery audit
notificationSchema.index({ tenantId: 1, dedupKey: 1 }, { sparse: true }); // storm-collapse upsert lookup

// ── Push Subscription (REALTIME_NOTIFICATIONS Phase 6) ───
//
// One browser's Web Push subscription (endpoint + encryption keys), as returned
// by PushManager.subscribe() on the dashboard. Endpoint is globally unique per
// the Push API spec, so it doubles as the natural upsert/delete key.

export interface IPushSubscription extends Document {
  tenantId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  createdAt: Date;
  updatedAt: Date;
}

const pushSubscriptionSchema = new Schema<IPushSubscription>({
  tenantId: tenantField,
  endpoint: { type: String, required: true, unique: true },
  keys: {
    p256dh: { type: String, required: true },
    auth: { type: String, required: true },
  },
  userAgent: { type: String },
}, { timestamps: true });

// ── Notification Preferences (REALTIME_NOTIFICATIONS Phase 7) ───
//
// Per-tenant delivery preferences: channel toggles (in-app SSE / web push /
// email), per-event-family mutes, and quiet hours during which the out-of-app
// channels (push + email) are suppressed. One doc per tenant; absent doc = all
// defaults (see notifications/preferences).

export interface INotificationPrefs extends Document {
  tenantId: string;
  inApp: boolean;
  push: boolean;
  /** Email digest of background events. Opt-in (default off) — requires SMTP. */
  email: boolean;
  /** Slack delivery of background events. Opt-in (default off) — requires
   *  `slackWebhookUrl` to be set (the tenant's own Incoming Webhook). */
  slack: boolean;
  /** Tenant's Slack Incoming Webhook URL (https://hooks.slack.com/services/...).
   *  Write-only from the API's perspective — never echoed back in full once set. */
  slackWebhookUrl?: string;
  /** Event-family toggles keyed by the first dotted segment, e.g. { task: true }. */
  events: Record<string, boolean>;
  /** "HH:MM" 24h server-local time. Both set → quiet window active. */
  quietStart?: string;
  quietEnd?: string;
}

const notificationPrefsSchema = new Schema<INotificationPrefs>({
  tenantId: { ...tenantField, unique: true },
  inApp: { type: Boolean, required: true, default: true },
  push: { type: Boolean, required: true, default: true },
  email: { type: Boolean, required: true, default: false },
  slack: { type: Boolean, required: true, default: false },
  slackWebhookUrl: { type: String },
  events: { type: Schema.Types.Mixed, default: {} },
  quietStart: { type: String },
  quietEnd: { type: String },
}, { timestamps: true, minimize: false });

// ── Budget Usage (Phase 5b spend audit log) ──────────────

export interface IBudgetUsage extends Omit<Document, 'model'> {
  tenantId: string;
  callId: string;
  channelId?: string;
  channelType?: string;
  agentName?: string;
  /** M2 Team tier — the tenant member (User.userId) this call is attributed
   *  to, when the caller carried a user identity. Absent on system/agent
   *  traffic and on all pre-M2 rows. */
  userId?: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  toolIterations?: number;
  cappedToolUses?: boolean;
  /** Phase 5d — tokens written to Anthropic prompt cache on this call. */
  cacheCreationInputTokens?: number;
  /** Phase 5d — tokens read from Anthropic prompt cache on this call. */
  cacheReadInputTokens?: number;
  /** Phase 5f — true when this call was dispatched via Anthropic Message
   *  Batches API (50% discount applied). Used by the dashboard to compute
   *  batch share-of-traffic + realised savings. */
  batchMode?: boolean;
  /** Cost-attribution (this change) — the repo this call was made on behalf
   *  of, when known (e.g. `agents_invoke` carries the caller's `repo` arg).
   *  Absent for repo-agnostic traffic (plain chat, scheduler sweeps without
   *  a target repo). */
  repo?: string;
  /** Cost-attribution — the specialist/agent category this call ran under
   *  (e.g. `solution-architect`, `dev-backend`), mirroring `agentName` but
   *  normalised for grouping (see `router.ts` TASK_TYPE table). Absent for
   *  non-agent traffic (plain chat completions). */
  taskType?: string;
  /** Cost-attribution — true for a runner-claimed autonomous agentic session
   *  (the billable "premium" unit — same semantics as the product meter's
   *  `task.executed` + `metadata.premium`, ADR-014 follow-up 2). False/absent
   *  for the gateway-inline interactive lane. */
  premium?: boolean;
  createdAt: Date;
  metadata?: Record<string, unknown>;
}

const budgetUsageSchema = new Schema<IBudgetUsage>({
  tenantId: tenantField,
  callId: { type: String, required: true, unique: true },
  channelId: { type: String },
  channelType: { type: String },
  agentName: { type: String },
  userId: { type: String },
  provider: { type: String, required: true },
  model: { type: String, required: true },
  inputTokens: { type: Number, required: true, default: 0 },
  outputTokens: { type: Number, required: true, default: 0 },
  costUsd: { type: Number, required: true, default: 0 },
  toolIterations: { type: Number },
  cappedToolUses: { type: Boolean },
  cacheCreationInputTokens: { type: Number },
  cacheReadInputTokens: { type: Number },
  batchMode: { type: Boolean },
  repo: { type: String },
  taskType: { type: String },
  premium: { type: Boolean },
  metadata: { type: Schema.Types.Mixed },
}, { timestamps: true });

budgetUsageSchema.index({ createdAt: -1 });
budgetUsageSchema.index({ channelId: 1, createdAt: -1 });
budgetUsageSchema.index({ provider: 1, createdAt: -1 });
budgetUsageSchema.index({ tenantId: 1, createdAt: -1 });
budgetUsageSchema.index({ tenantId: 1, userId: 1, createdAt: -1 }); // per-member breakdown/filter
budgetUsageSchema.index({ tenantId: 1, repo: 1, createdAt: -1 }); // cost-attribution breakdown

// ── Budget Usage Rollup (Phase 5b §3.1 — daily/weekly analytics) ────
// PHASE_5B_BUDGET_GUARDS.md §3.1 originally deferred this as "premature
// optimization until volume forces it" — BudgetUsage stayed one immutable
// document per LLM call, aggregated on read. Call volume has since grown
// enough that repeatedly summing the full per-call log for dashboards/
// analytics is worth pre-aggregating. This collection is a DERIVED cache —
// one document per tenant per period (day or ISO-week, UTC) — never the
// source of truth. `BudgetUsageModel` remains the audit log; a rollup can
// always be recomputed from it (see `llm/budget-rollup.ts`).

export type BudgetRollupPeriod = 'daily' | 'weekly';

export interface IBudgetRollupBucket {
  key: string;    // provider name / model name / channelId ('unattributed' when null)
  costUsd: number;
  calls: number;
}

export interface IBudgetUsageRollup extends Omit<Document, 'model'> {
  tenantId: string;
  period: BudgetRollupPeriod;
  /** 'YYYY-MM-DD' (daily, UTC) or 'YYYY-Www' (ISO week, UTC) — dedupe/upsert key. */
  periodKey: string;
  periodStart: Date;
  periodEnd: Date;
  totalCostUsd: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  byProvider: IBudgetRollupBucket[];
  byModel: IBudgetRollupBucket[];
  byChannel: IBudgetRollupBucket[];
  /** When this document was last (re)computed — a same-day/week rollup is
   *  recomputed repeatedly until the period closes, so this differs from
   *  Mongoose's `updatedAt` in intent even though it tracks the same event. */
  computedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const budgetRollupBucketSchema = new Schema<IBudgetRollupBucket>({
  key: { type: String, required: true },
  costUsd: { type: Number, required: true, default: 0 },
  calls: { type: Number, required: true, default: 0 },
}, { _id: false });

const budgetUsageRollupSchema = new Schema<IBudgetUsageRollup>({
  tenantId: tenantField,
  period: { type: String, required: true, enum: ['daily', 'weekly'] },
  periodKey: { type: String, required: true },
  periodStart: { type: Date, required: true },
  periodEnd: { type: Date, required: true },
  totalCostUsd: { type: Number, required: true, default: 0 },
  totalCalls: { type: Number, required: true, default: 0 },
  totalInputTokens: { type: Number, required: true, default: 0 },
  totalOutputTokens: { type: Number, required: true, default: 0 },
  byProvider: { type: [budgetRollupBucketSchema], default: [] },
  byModel: { type: [budgetRollupBucketSchema], default: [] },
  byChannel: { type: [budgetRollupBucketSchema], default: [] },
  computedAt: { type: Date, required: true, default: () => new Date() },
}, { timestamps: true });

// One document per tenant per period per key — upsert target for the rollup job.
budgetUsageRollupSchema.index({ tenantId: 1, period: 1, periodKey: 1 }, { unique: true });
// Range queries for analytics ("last 30 daily rollups", "last 12 weekly rollups").
budgetUsageRollupSchema.index({ tenantId: 1, period: 1, periodStart: -1 });

// ── Budget Cap Override (Phase 5b §8 follow-up — operator per-tenant caps) ──
// One document per tenant, written by the dashboard's PATCH /api/budget-caps
// (dashboard/src/app/api/budget-caps/route.ts, backing the "Apply suggestion"
// button on the adaptive budget-cap suggestions panel). Unlike most schemas in
// this file, the GATEWAY does not write this collection — the dashboard is the
// sole writer; the gateway's budget-guard.ts only reads it (read-only mirror,
// inverse of the usual direction) to override the BUDGET_* env-var caps for a
// tenant that has applied a suggestion. A field left unset on the document
// falls back to the corresponding env-configured cap in budget-guard.ts.
export interface IBudgetCapOverride extends Document {
  tenantId: string;
  monthlyHardCapUsd?: number;
  dailyCapUsd?: number;
  perChannelCapUsd?: number;
  /** Tenant-wide off-hours runner minutes cap (usage-store.ts 'offhours.minutes'
   *  meter), UTC calendar month. Distinct from IMemberBudgetCap's field of the
   *  same name — that one scopes a single member, this scopes the whole tenant.
   *  Read by tasks/tenant-budget-gate.ts at task-claim time, unset = uncapped. */
  offHoursMinutesCapPerMonth?: number;
  updatedAt: Date;
}

const budgetCapOverrideSchema = new Schema<IBudgetCapOverride>({
  tenantId: { type: String, required: true, unique: true, index: true },
  monthlyHardCapUsd: { type: Number },
  dailyCapUsd: { type: Number },
  perChannelCapUsd: { type: Number },
  offHoursMinutesCapPerMonth: { type: Number },
}, { timestamps: { createdAt: false, updatedAt: true }, collection: 'budgetcapoverrides' });

// ── Member Budget Cap (task-82854b12 — Team-tier per-member scoping) ────
// One document per (tenant, member), written by an owner/admin via
// POST /api/auth/members/budget-cap (core/invites.ts's setMemberBudgetCap,
// gated behind the same `members` RBAC capability as changeMemberRole). This
// nests the existing per-TENANT cost-aware budget cap (llm/budget-guard.ts,
// BudgetCapOverride above) down to an individual member: a Team owner can
// bound one member's autonomous $ spend and off-hours runner minutes without
// touching the tenant-wide caps. A field left unset is unlimited for that
// member (not "falls back to the tenant cap" — the tenant cap still applies
// independently on top, via budget-guard.ts). No document at all means the
// member is never scoped by this guard. Read by tasks/member-budget-guard.ts
// at task-claim time; never written by the gateway itself.
export interface IMemberBudgetCap extends Document {
  tenantId: string;
  userId: string;
  monthlyHardCapUsd?: number;
  dailyCapUsd?: number;
  /** Off-hours runner minutes (usage-store.ts 'offhours.minutes' meter), UTC calendar month. */
  offHoursMinutesCapPerMonth?: number;
  updatedAt: Date;
}

const memberBudgetCapSchema = new Schema<IMemberBudgetCap>({
  tenantId: tenantField,
  userId: { type: String, required: true },
  monthlyHardCapUsd: { type: Number },
  dailyCapUsd: { type: Number },
  offHoursMinutesCapPerMonth: { type: Number },
}, { timestamps: { createdAt: false, updatedAt: true }, collection: 'memberbudgetcaps' });

memberBudgetCapSchema.index({ tenantId: 1, userId: 1 }, { unique: true });

// ── MRR Snapshot (nightly per-tenant revenue history) ────────────────
// Closes the gap noted on dashboard /revenue and /revenue/nrr: those pages
// used to reconstruct a single "now" MRR point per tenant (no historical
// series existed), so cohort expansion/contraction always read as a proxy
// rather than a real trend. `analytics/mrr-snapshot-job.ts`'s
// `runMrrSnapshotSweep` writes one document per (tenant, UTC day) — an
// immutable point-in-time fact, never recomputed once written for a past
// day (unlike the rollup above, which is a derived cache). The unique
// {tenantId, snapshotDate} index is the idempotency guard: re-running the
// sweep the same day upserts (overwrites) that day's row instead of
// duplicating it.
export interface IMrrSnapshot extends Document {
  tenantId: string;
  mrr: number;
  plan: TenantPlan;
  capturedAt: Date;
  /** 'YYYY-MM-DD' (UTC) — the per-tenant daily dedupe/upsert key. */
  snapshotDate: string;
  createdAt: Date;
  updatedAt: Date;
}

const mrrSnapshotSchema = new Schema<IMrrSnapshot>({
  tenantId: { type: String, required: true },
  mrr: { type: Number, required: true, default: 0 },
  plan: { type: String, required: true, enum: ['free', 'solo', 'team', 'scale'] },
  capturedAt: { type: Date, required: true },
  snapshotDate: { type: String, required: true },
}, { timestamps: true });

mrrSnapshotSchema.index({ tenantId: 1, snapshotDate: 1 }, { unique: true });
mrrSnapshotSchema.index({ tenantId: 1, capturedAt: -1 }); // "this tenant's history, newest first"

// ── Spend Alert State (FINOPS tenant-facing spend alert) ─────────────
// Dedup watermark so the customer-facing "80%/100% of plan-included spend"
// alert (llm/spend-alert.ts) fires AT MOST ONCE per threshold per tenant per
// billing period. Billing period is approximated as the calendar month (UTC),
// matching the MTD convention already used by budget-guard.ts/budget-stats.ts.
// One tiny doc per tenant per period — NOT a substitute for BudgetUsage (the
// raw per-call audit log this alert reads from via getBudgetStatus().mtd).

export interface ISpendAlertState extends Document {
  tenantId: string;
  /** 'YYYY-MM' UTC — the billing period this watermark applies to. */
  period: string;
  /** Highest threshold (0, 80, or 100) already alerted for this period. */
  maxThresholdSent: number;
  createdAt: Date;
  updatedAt: Date;
}

const spendAlertStateSchema = new Schema<ISpendAlertState>({
  tenantId: tenantField,
  period: { type: String, required: true },
  maxThresholdSent: { type: Number, required: true, default: 0 },
}, { timestamps: true });

spendAlertStateSchema.index({ tenantId: 1, period: 1 }, { unique: true });

// ── Tenant Budget Gate Alert State (runner claim-time budget-exhausted alert) ──
// Dedup watermark so the runner's tenant-level budget-exhaustion gate
// (tasks/tenant-budget-gate.ts) emits its 'runner.budget_exhausted' notification
// AT MOST ONCE per (tenant, window, reason) instead of on every claim-poll cycle
// while a tenant stays over budget. `windowKey` is reason-scoped (daily reasons
// key off the UTC day, monthly/off-hours reasons key off the UTC month) so a
// tenant that trips the daily cap gets alerted again the next calendar day even
// within the same billing month.

export interface ITenantBudgetGateAlertState extends Document {
  tenantId: string;
  /** e.g. 'daily:2026-08-21' or 'monthly:2026-08' — see tenant-budget-gate.ts. */
  windowKey: string;
  reason: string;
  createdAt: Date;
  updatedAt: Date;
}

const tenantBudgetGateAlertStateSchema = new Schema<ITenantBudgetGateAlertState>({
  tenantId: tenantField,
  windowKey: { type: String, required: true },
  reason: { type: String, required: true },
}, { timestamps: true });

tenantBudgetGateAlertStateSchema.index({ tenantId: 1, windowKey: 1 }, { unique: true });


// ── Atlas Vector Index Health (self-heal repeat-non-ok alert) ─────
// ensureAtlasVectorSearchIndex() (memory/atlas-search-index.ts) self-heals
// the `vectors` Atlas Search index on every gateway boot — action is one of
// created/updated/recreated/ok/skipped/failed. A ONE-TIME create/update/
// recreate (first boot ever, or Atlas UI drift repaired) is healthy; the
// SAME non-'ok' outcome firing on every boot in a row means something keeps
// fighting the index definition (an M0 tier silently dropping the index, two
// gateway replicas racing on createSearchIndex, etc). This state carries the
// consecutive-non-ok streak ACROSS PROCESS RESTARTS (an in-memory counter
// can't — each boot is a new process), so monitoring/atlas-index-health-
// alerter.ts can tell "fixed it once" (a boot landing on 'ok' or 'skipped'
// resets the streak to 0) from "something keeps breaking it" (the streak
// crosses the alert threshold). One tiny doc per index name — there is
// currently only one (`vector_index`).

export interface IAtlasIndexHealthState extends Document {
  /** Atlas Search index name, e.g. "vector_index" (atlasVectorIndexName()). */
  index: string;
  /** Consecutive boots in a row whose ensureAtlasVectorSearchIndex() action was NOT 'ok'/'skipped'. */
  consecutiveNonOk: number;
  /** Set once the alert has fired for the CURRENT streak; cleared when the streak resets. */
  alertedThisIncident: boolean;
  /** The most recent ensureAtlasVectorSearchIndex() action, for diagnostics. */
  lastAction: string;
  createdAt: Date;
  updatedAt: Date;
}

const atlasIndexHealthStateSchema = new Schema<IAtlasIndexHealthState>({
  index: { type: String, required: true },
  consecutiveNonOk: { type: Number, required: true, default: 0 },
  alertedThisIncident: { type: Boolean, required: true, default: false },
  lastAction: { type: String, required: true, default: '' },
}, { timestamps: true });

atlasIndexHealthStateSchema.index({ index: 1 }, { unique: true });


// ── Usage Event (product meter — ADR-014, S2 slice 1) ───────
// The SECOND meter alongside BudgetUsage. Where BudgetUsage is the *resource*
// meter (tokens/$ per LLM call), UsageEvent is the *product* meter: the billable
// business units the pricing page sells (a runner task executed, off-hours
// minutes consumed, an app generated, an agent invoked). Append-only,
// tenant-scoped, idempotent by `eventId`. No TTL — this becomes invoice
// evidence; retention is decided when invoicing (the add-on billing follow-up)
// lands. Emitted fire-and-forget from existing gateway chokepoints via
// `usage-store.ts::recordUsage` — a meter failure NEVER fails the metered op.
export type UsageEventType =
  | 'task.executed'        // a runner/agent finished a queued task (the wedge unit)
  | 'offhours.minutes'     // off-hours runner wall-clock consumed (quantity = minutes)
  | 'app.generated'        // new_app / blueprint pipeline produced a repo
  | 'ticket.bridged'       // Connect Hub ticket → gateway task (S1 bridge)
  | 'agent.invoked'        // agents_invoke / skills_invoke (interactive premium surface)
  | 'schedule.dispatched'; // a cron schedule fired a dispatch

export type UsageEventSource = 'runner' | 'gateway' | 'scheduler' | 'connect' | 'dashboard';

export interface IUsageEvent extends Omit<Document, 'model'> {
  tenantId: string;        // tenantField — scoped, required (ADR-010)
  eventId: string;         // unique — idempotency key (deterministic where re-emission is possible)
  type: UsageEventType;
  quantity: number;        // default 1; minutes for offhours.minutes
  unit: 'count' | 'minutes';
  repo?: string;
  taskId?: string;         // provenance links — never joined at write time
  userId?: string;         // human principal when known (ADR-013 ctx.userId)
  source: UsageEventSource;
  occurredAt: Date;        // event time (client-supplied for runner batches; ±24h clamped at insert)
  metadata?: Record<string, unknown>;  // e.g. { model, premium: true, durationSec }
  createdAt: Date;         // ingest time (server-side, always)
}

const usageEventSchema = new Schema<IUsageEvent>({
  tenantId: tenantField,
  eventId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  quantity: { type: Number, required: true, default: 1 },
  unit: { type: String, required: true, default: 'count', enum: ['count', 'minutes'] },
  repo: { type: String },
  taskId: { type: String },
  userId: { type: String },
  source: { type: String, required: true },
  occurredAt: { type: Date, required: true, default: () => new Date() },
  metadata: { type: Schema.Types.Mixed },
}, { timestamps: { createdAt: true, updatedAt: false } });

// { eventId } unique gives idempotent insert (duplicate-key → no-op).
usageEventSchema.index({ tenantId: 1, type: 1, occurredAt: -1 }); // the aggregation hot path
usageEventSchema.index({ tenantId: 1, occurredAt: -1 });          // period-bounded summary / export


// ── Repo Card (app directory — one point pointer per repo) ───
// Each managed repo contributes its own card on `wrap up`: where it runs
// (localhost), its app/api URLs, its MongoDB (non-secret label only), its
// Vercel/DNS URLs, a short description, and a rolling last-update status.

export interface IRepoCard extends Document {
  tenantId: string;
  repoName: string;
  description: string;
  group?: string;
  localhostUrl?: string;
  appUrl?: string;
  apiUrl?: string;
  mongo?: string;       // non-secret label, e.g. "Atlas cluster0 / db myapp" or "local :27017/myapp"
  vercelUrl?: string;
  dnsUrl?: string;
  lastStatus?: string;  // free-text rolling status (git summary / what shipped)
  lastStatusLevel: 'ok' | 'warn' | 'error' | 'unknown';
  reportedBy?: string;  // agent/profile that last updated the card
  commitsAhead?: number; // `git rev-list --count origin/main..origin/test` — unshipped work on test
  createdAt: Date;
  updatedAt: Date;
}

const repoCardSchema = new Schema<IRepoCard>({
  tenantId: tenantField,
  // repoName uniqueness is now per-tenant (compound index below) — two tenants
  // may each track a repo with the same name. Old standalone unique index on
  // repoName is dropped by migration 001 (syncIndexes).
  repoName: { type: String, required: true, index: true },
  description: { type: String, default: '' },
  group: { type: String },
  localhostUrl: { type: String },
  appUrl: { type: String },
  apiUrl: { type: String },
  mongo: { type: String },
  vercelUrl: { type: String },
  dnsUrl: { type: String },
  lastStatus: { type: String },
  lastStatusLevel: { type: String, enum: ['ok', 'warn', 'error', 'unknown'], default: 'unknown' },
  reportedBy: { type: String },
  commitsAhead: { type: Number },
}, { timestamps: true });

repoCardSchema.index({ tenantId: 1, repoName: 1 }, { unique: true });
repoCardSchema.index({ tenantId: 1, updatedAt: -1 });

// ── Repo (fleet ROSTER, per-tenant) — ADR-021 ────────────────
// The source of truth for which repos a tenant tracks, replacing the flat
// config/managed_repos.txt (a single-operator artifact). Self-registered via
// `myai init` / `myai scan`. `path` is that user's machine-local checkout path.
// Complements RepoCard (display metadata) — joined by (tenantId, name).
export interface IRepo extends Document {
  tenantId: string;
  name: string;
  path: string;
  gitRemote?: string;
  brainNamespace?: string;
  stack: string[];
  group?: string;
  source: 'seed' | 'myai-init' | 'scan' | 'manual' | 'repocard' | 'headless-new-app';
  enabled: boolean;
  lastSeenAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const repoSchema = new Schema<IRepo>({
  tenantId: tenantField,
  name: { type: String, required: true, index: true },
  path: { type: String, required: true },
  gitRemote: { type: String },
  brainNamespace: { type: String },
  stack: { type: [String], default: [] },
  group: { type: String },
  source: { type: String, enum: ['seed', 'myai-init', 'scan', 'manual', 'repocard', 'headless-new-app'], default: 'manual' },
  enabled: { type: Boolean, default: true },
  lastSeenAt: { type: Date },
}, { timestamps: true });

repoSchema.index({ tenantId: 1, name: 1 }, { unique: true });
repoSchema.index({ tenantId: 1, enabled: 1, updatedAt: -1 });

// ── Connector (bundled MCP connector set, per-tenant) ────────
// A fresh betaC install ships with a curated bundle of MCP connectors (see
// repos/connector-bundle.ts) so it has working connectors day one. This
// collection holds the per-tenant ENABLED/DISABLED state of those bundled
// connectors plus any CUSTOM connectors the operator adds via the dashboard
// connector manager. Keyed per-tenant so two tenants can each enable a
// different set.

export type ConnectorTransport = 'http' | 'stdio';
export type ConnectorSource = 'bundled' | 'custom';

/**
 * OAuth token state for a connector that authenticates in-app (Vercel,
 * Dropbox). Present only once a tenant completes the OAuth flow; absent for
 * connectors that use a static env-var credential (e.g. GitHub PAT).
 */
export interface IConnectorOAuth {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: Date;
  tokenType?: string;
  scope?: string;
  lastRefreshedAt?: Date;
  lastRefreshError?: string;
  /** Last time we nudged the tenant to re-authenticate (throttles repeat nudges). */
  reauthNudgedAt?: Date;
}

export interface IConnector extends Document {
  tenantId: string;
  key: string;                 // slug, also the key under mcpServers in .mcp.json
  label: string;
  category: string;            // framework | docs | design | browser | vcs | deploy | storage | custom
  transport: ConnectorTransport;
  description?: string;
  url?: string;                // http transport
  command?: string;            // stdio transport
  args?: string[];
  env?: Record<string, string>;
  requiresEnv?: string[];      // env var names the operator must still supply
  enabled: boolean;
  source: ConnectorSource;
  oauth?: IConnectorOAuth;
  createdAt: Date;
  updatedAt: Date;
}

const connectorOAuthSchema = new Schema<IConnectorOAuth>({
  accessToken: { type: String },
  refreshToken: { type: String },
  expiresAt: { type: Date },
  tokenType: { type: String },
  scope: { type: String },
  lastRefreshedAt: { type: Date },
  lastRefreshError: { type: String },
  reauthNudgedAt: { type: Date },
}, { _id: false });

const connectorSchema = new Schema<IConnector>({
  tenantId: tenantField,
  key: { type: String, required: true, index: true },
  label: { type: String, required: true },
  category: { type: String, default: 'custom' },
  transport: { type: String, enum: ['http', 'stdio'], required: true },
  description: { type: String },
  url: { type: String },
  command: { type: String },
  args: { type: [String], default: undefined },
  env: { type: Schema.Types.Mixed },
  requiresEnv: { type: [String], default: undefined },
  enabled: { type: Boolean, default: true },
  source: { type: String, enum: ['bundled', 'custom'], default: 'custom' },
  oauth: { type: connectorOAuthSchema, default: undefined },
}, { timestamps: true });

// One row per (tenant, connector key). Re-seeding the bundle is an upsert.
connectorSchema.index({ tenantId: 1, key: 1 }, { unique: true });
// Cross-tenant sweep target for the OAuth auto-refresh worker (sparse — most
// connectors have no oauth subdocument at all).
connectorSchema.index({ 'oauth.expiresAt': 1 }, { sparse: true });

// ── Plan Day (10-day improvement schedule per repo) ──────────
// A repo's planning session produces one focus per day (fires 23:00 UTC ≈ 9am
// Sydney), rendered as a table on the dashboard /plan page. The actual work is
// the tasks in the queue; this is the day-by-day roadmap + status overlay.

export interface IPlanDay extends Document {
  tenantId: string;
  repo: string;
  day: number;          // 1..N
  fireAt: Date;         // when this day's work is scheduled to start (UTC)
  focus: string;        // one-line focus for the day
  status: 'enabled' | 'disabled' | 'done' | 'blocked';
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const planDaySchema = new Schema<IPlanDay>({
  tenantId: tenantField,
  repo: { type: String, required: true, index: true },
  day: { type: Number, required: true },
  fireAt: { type: Date, required: true },
  focus: { type: String, required: true },
  status: { type: String, enum: ['enabled', 'disabled', 'done', 'blocked'], default: 'enabled' },
  notes: { type: String },
}, { timestamps: true });

// Unique key leads with tenantId — two tenants may each plan the same repo/day.
// Old { repo, day } unique index is dropped by migration 001 (syncIndexes).
planDaySchema.index({ tenantId: 1, repo: 1, day: 1 }, { unique: true });
planDaySchema.index({ fireAt: 1 });

// ── Trash bin (soft-delete + restore for tasks/plans) ────────────────────
// A delete of a Task or a repo's PlanDay set moves full doc snapshot(s) into
// this collection instead of destroying them — recoverable via the
// tasks_restore / plan_restore MCP tools until the retention purge
// (core/data-retention.ts, TRASH_RETENTION_DAYS) hard-deletes the entry.
// A dedicated collection rather than an in-place `deletedAt` flag on the
// source docs: the flag variant would require every existing Task/PlanDay
// query (claim, list, count, DAG gates, monitoring sweeps) to remember an
// exclusion filter — the same "forgotten filter" failure mode ADR-010's
// scoped-query helpers exist to kill. Moving the doc out of the live
// collection makes un-deleted reads impossible by construction.

export type TrashKind = 'task' | 'plan';

export interface ITrashEntry extends Document {
  tenantId: string;
  /** `trash-<uuid>` — the handle restore/list tools address an entry by. */
  trashId: string;
  kind: TrashKind;
  /** Human-readable label for the trash listing (task title / "<repo> plan"). */
  label: string;
  repo: string;
  /** kind=task: the original taskId (restore-by-taskId lookup). kind=plan: unset. */
  sourceId?: string;
  /** Raw doc snapshot(s) — exactly one for a task, one per PlanDay for a plan. */
  snapshots: Record<string, unknown>[];
  /** Audit-mirrored actor identity (userId, or the actor `via` when anonymous). */
  deletedBy?: string;
  reason?: string;
  deletedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const trashEntrySchema = new Schema<ITrashEntry>({
  tenantId: tenantField,
  trashId: { type: String, required: true, unique: true, index: true },
  kind: { type: String, required: true, enum: ['task', 'plan'] },
  label: { type: String, required: true },
  repo: { type: String, required: true },
  sourceId: { type: String },
  // Mixed (not [Mixed]) so the raw snapshot array round-trips untyped — the
  // docs were validated by their source schema before trashing. Writers that
  // mutate it in place must markModified('snapshots') (restorePlan does).
  snapshots: { type: Schema.Types.Mixed, required: true },
  deletedBy: { type: String },
  reason: { type: String },
  deletedAt: { type: Date, required: true },
}, { timestamps: true });

// Trash listing (newest first per tenant) + restore-by-source lookups.
trashEntrySchema.index({ tenantId: 1, kind: 1, deletedAt: -1 });
trashEntrySchema.index({ tenantId: 1, sourceId: 1 });
// Retention purge scans cross-tenant by age (data-retention.ts) — no TTL index
// on purpose: the window is env-tunable at purge time, same posture as
// Task/PlanDay retention.
trashEntrySchema.index({ deletedAt: 1 });

// ── Task Artifact (per-task reviewable output) ───────────
// Structured, downloadable artifacts a runner session captures on completion —
// git diff, build/test console output, generated reports — so an operator can
// review autonomous work without re-running it. Distinct from the raw runner
// job-log rotation (scripts/runner_log_rotate.sh): that retains the FULL
// session transcript on the runner host's disk; this is a bounded, per-task
// slice stored centrally (Mongo — the same shared queue every machine already
// writes to, ADR-011) so the dashboard can serve a download link regardless of
// which Mac ran the task. Content is capped and gzip+base64-encoded past
// ARTIFACT_INLINE_THRESHOLD to keep documents small; truncated=true marks a
// capture that exceeded MAX_ARTIFACT_BYTES.
export type ArtifactKind = 'diff' | 'build-log' | 'test-report' | 'other';

export interface IArtifact extends Document {
  tenantId: string;
  artifactId: string;
  taskId: string;
  repo: string;
  kind: ArtifactKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
  encoding: 'utf8' | 'gzip+base64';
  content: string;
  truncated: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const artifactSchema = new Schema<IArtifact>({
  tenantId: tenantField,
  artifactId: { type: String, required: true, unique: true, index: true },
  taskId: { type: String, required: true, index: true },
  repo: { type: String, required: true },
  kind: { type: String, required: true, enum: ['diff', 'build-log', 'test-report', 'other'], default: 'other' },
  filename: { type: String, required: true },
  contentType: { type: String, required: true, default: 'text/plain' },
  sizeBytes: { type: Number, required: true },
  encoding: { type: String, required: true, enum: ['utf8', 'gzip+base64'], default: 'utf8' },
  content: { type: String, required: true },
  truncated: { type: Boolean, default: false },
}, { timestamps: true });

artifactSchema.index({ tenantId: 1, taskId: 1, createdAt: 1 });

// ── Runner job history (searchable overnight-run archive) ─────
// One document per runner fire (one ~/.ai-cli-runner/logs job log), indexed by
// repo / task / outcome so past runs are queryable from the dashboard instead
// of grepped off whichever Mac happened to run them. This stores the SUMMARY
// of a run (RESULT line + a bounded error excerpt), not the raw log body —
// the full transcript stays host-local under runner_log_rotate.sh's lifecycle,
// and the bounded reviewable slice lives in the artifact store (session.log).

export type JobHistoryStatus = 'done' | 'blocked' | 'failed' | 'no-result';

export interface IRunnerJobHistory extends Document {
  tenantId: string;
  jobId: string;
  repo: string;
  taskId: string;
  status: JobHistoryStatus;
  /** The run's final `RESULT: ` line (redacted + capped at write time). */
  resultLine: string;
  /** Bounded error/postmortem excerpt (3-strikes block, tail of a failed run). */
  errorExcerpt: string;
  exitCode?: number;
  machine?: string;
  /** Model the session ran on (`usedModel` — `model` collides with Document.model()). */
  usedModel?: string;
  /** Source log filename on the runner host — the idempotent-ingest dedupe key. */
  logFile?: string;
  /** When the runner fired the job (from the log filename timestamp). */
  startedAt: Date;
  durationSeconds?: number;
  createdAt: Date;
  updatedAt: Date;
}

const runnerJobHistorySchema = new Schema<IRunnerJobHistory>({
  tenantId: tenantField,
  jobId: { type: String, required: true, unique: true, index: true },
  repo: { type: String, required: true },
  taskId: { type: String, required: true },
  status: { type: String, required: true, enum: ['done', 'blocked', 'failed', 'no-result'], default: 'no-result' },
  resultLine: { type: String, required: true, default: '' },
  errorExcerpt: { type: String, required: true, default: '' },
  exitCode: { type: Number },
  machine: { type: String },
  usedModel: { type: String },
  logFile: { type: String },
  startedAt: { type: Date, required: true },
  durationSeconds: { type: Number },
}, { timestamps: true });

runnerJobHistorySchema.index({ tenantId: 1, startedAt: -1 });
runnerJobHistorySchema.index({ tenantId: 1, repo: 1, startedAt: -1 });
runnerJobHistorySchema.index({ tenantId: 1, taskId: 1 });
// Idempotent re-ingest: the same host log file never becomes two rows.
runnerJobHistorySchema.index(
  { tenantId: 1, logFile: 1 },
  { unique: true, partialFilterExpression: { logFile: { $type: 'string' } } },
);

// ── Fleet Run (morning "agent mode -resume all" console) ─────
// One document per fleet-wide morning sweep. The master repo aggregates each
// managed repo's overnight state (commits / open PRs / runner activity / queued
// review+blocked tasks) into `repos[]` with a recommendation, then — as the
// operator approves actions from the master terminal — flips each repo's
// `actionStatus` live. The dashboard /fleet page renders this with auto-refresh,
// so the morning sweep + the work it triggers are visible in realtime.

export type FleetRepoActionStatus = 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped';

export interface IFleetRunRepo {
  repo: string;
  group?: string;
  overnight: string;        // one-line summary of overnight state
  recommendation: string;   // ship | review | merge | fix | wrap-up | idle | attention
  branch?: string;
  ahead?: number;           // test ahead of main
  uncommitted?: number;
  openPrs?: number;
  reviewTasks?: number;     // gateway tasks in `review` for this repo
  blockedTasks?: number;
  decision?: string;        // what the operator chose (free text)
  action?: string;          // ship | fix | merge | test | wrap-up | skip
  actionStatus: FleetRepoActionStatus;
  detail?: string;          // rolling progress / result line
  prUrl?: string;
  updatedAt: Date;
}

export interface IFleetRun extends Document {
  tenantId: string;
  runId: string;            // e.g. "fleet-20260616-0830"
  type: string;             // 'morning-resume-all'
  status: 'running' | 'completed' | 'aborted';
  machine?: string;
  agent?: string;
  startedAt: Date;
  finishedAt?: Date;
  repos: IFleetRunRepo[];
  summary?: Record<string, unknown>;  // { total, needsAction, shipped, failed }
  createdAt: Date;
  updatedAt: Date;
}

const fleetRunRepoSchema = new Schema<IFleetRunRepo>({
  repo: { type: String, required: true },
  group: { type: String },
  overnight: { type: String, default: '' },
  recommendation: { type: String, default: 'idle' },
  branch: { type: String },
  ahead: { type: Number },
  uncommitted: { type: Number },
  openPrs: { type: Number },
  reviewTasks: { type: Number },
  blockedTasks: { type: Number },
  decision: { type: String },
  action: { type: String },
  actionStatus: { type: String, enum: ['pending', 'in-progress', 'done', 'failed', 'skipped'], default: 'pending' },
  detail: { type: String },
  prUrl: { type: String },
  updatedAt: { type: Date, default: () => new Date() },
}, { _id: false });

const fleetRunSchema = new Schema<IFleetRun>({
  tenantId: tenantField,
  runId: { type: String, required: true },
  type: { type: String, default: 'morning-resume-all' },
  status: { type: String, enum: ['running', 'completed', 'aborted'], default: 'running', index: true },
  machine: { type: String },
  agent: { type: String },
  startedAt: { type: Date, default: () => new Date(), index: true },
  finishedAt: { type: Date },
  repos: { type: [fleetRunRepoSchema], default: [] },
  summary: { type: Schema.Types.Mixed },
}, { timestamps: true });

// ── FleetRun index strategy (dashboard /fleet auto-refresh) ─────────────
// fleet-run-store queries: get/update by {tenantId, runId} (unique index),
// latest/list by {tenantId} sorted {startedAt:-1} (tenant+timestamp index).
// Both shapes are fully covered — no additional indexes needed.
fleetRunSchema.index({ tenantId: 1, runId: 1 }, { unique: true });
fleetRunSchema.index({ tenantId: 1, startedAt: -1 });

// ── Handoff (betaC — first-class handoff store) ──────────────
// Replaces the git-synced AI_AGENT_HANDOFF.md with a queryable gateway
// primitive. Each `wrap up` / session close writes an append-only entry per
// repo; `handoff_read` returns the most recent entry (plus optional history).
// Append-only (not upsert) so the handoff trail is auditable across sessions
// and machines — the betaC headline: ask the gateway "what's the latest
// handoff for connect?" instead of pulling main to read a file.

export type HandoffStatus = 'active' | 'archived';

export interface IHandoff extends Document {
  tenantId: string;
  repo: string;
  content: string;          // the full handoff body (markdown)
  summary?: string;         // optional one-line "what's next" headline
  author?: string;          // agent/profile/machine that wrote it
  branch?: string;          // git branch the handoff was written from
  machine?: string;         // hostname the session ran on
  sessionId?: string;       // originating gateway session, if any
  status: HandoffStatus;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const handoffSchema = new Schema<IHandoff>({
  tenantId: tenantField,
  repo: { type: String, required: true, index: true },
  content: { type: String, required: true },
  summary: { type: String },
  author: { type: String },
  branch: { type: String },
  machine: { type: String },
  sessionId: { type: String },
  status: { type: String, required: true, enum: ['active', 'archived'], default: 'active', index: true },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });

// Latest-handoff lookup is the hot path: newest entry for a tenant+repo.
handoffSchema.index({ tenantId: 1, repo: 1, createdAt: -1 });
handoffSchema.index({ tenantId: 1, createdAt: -1 });

// ── ContinuityMetric (cold-start tokens-saved meter) ─────────
// One row per context served by the continuity layer (context_boot /
// memory_context). `tokens` is the estimated size of the context block the
// gateway handed a blank agent — i.e. the re-teaching cost the operator did
// NOT pay by hand. Aggregated per month this is the marketing number:
// "myAI saved N tokens this month." Tenant-scoped like every other collection.

export type ContinuityTool = 'context_boot' | 'memory_context' | 'brain_delta';

export interface IContinuityMetric extends Document {
  tenantId: string;
  repo: string;              // repo the context was assembled for ('unknown' when unresolved)
  tool: ContinuityTool;      // which continuity surface served it
  tokens: number;            // estimated tokens served (~4 chars/token upstream)
  baselineTokens?: number;   // measured legacy file-read boot cost at serve time (B7 today-vs-brain)
  durationMs?: number;       // measured wall-clock time to assemble+serve this context block (time-to-context)
  userId?: string;           // M2 Team tier — tenant member the boot was served to (absent on system/agent traffic)
  sessionId?: string;        // originating gateway session, when known
  createdAt: Date;
  updatedAt: Date;
}

const continuityMetricSchema = new Schema<IContinuityMetric>({
  tenantId: tenantField,
  repo: { type: String, required: true, default: 'unknown' },
  tool: { type: String, required: true, enum: ['context_boot', 'memory_context', 'brain_delta'] },
  tokens: { type: Number, required: true, min: 0 },
  baselineTokens: { type: Number, min: 0 },
  durationMs: { type: Number, min: 0 },
  userId: { type: String },
  sessionId: { type: String },
}, { timestamps: true });

// Month/window rollups scan by tenant+time; per-repo drill-down adds repo.
continuityMetricSchema.index({ tenantId: 1, createdAt: -1 });
continuityMetricSchema.index({ tenantId: 1, repo: 1, createdAt: -1 });
// Per-user cumulative savings view + share card (ADR-014 per-member attribution).
continuityMetricSchema.index({ tenantId: 1, userId: 1, createdAt: -1 });

// ── ActivationEvent (product analytics — the activation funnel) ──
// One row per (tenant, step) the FIRST time that tenant reaches an onboarding
// milestone. Append-only, tenant-scoped, idempotent by unique {tenantId, step}
// (first-wins upsert — re-emission is a no-op, so a chokepoint that fires on
// every wrap-up/boot only ever stamps the first occurrence). This is the
// product meter for signup→activation conversion; it reuses the ADR-014
// usage-metering posture (fire-and-forget at existing gateway chokepoints, a
// meter write must NEVER fail the metered operation). No third-party tracker —
// activation is derived entirely from data that already flows through the
// gateway, so it inherits the tenant's data locality (ADR-010).
//
// Funnel order (see monitoring/activation-funnel.ts ACTIVATION_STEPS):
//   signup → init → first_brain_boot → first_brain_delta → wrapup_merge
// The last step is the "continuity aha": a wrap-up merged the session into the
// brain, closing the continuity loop the product sells.
//
// `first_task` and `first_ship` are NOT part of that 5-step funnel display
// (ACTIVATION_STEPS stays fixed at 5) — they reuse this same idempotent
// first-wins recorder purely as the trigger for the lifecycle email sequence
// (notifications/lifecycle-emails.ts): first task queued, first task shipped.
//
// `first_hosted_brain` (ADR-023 Slice P3) is also outside the 5-step display
// funnel, for the same reason: it's the countable numerator for the
// cross-machine-sync conversion KPI (GO_LIVE_PLAN §6), stamped once per tenant
// at their first successful `brain_host_provision` call — see
// mcp/tools.ts:handleBrainHostProvision and
// monitoring/activation-funnel.ts:getHostedBrainConversion.

export type ActivationStep =
  | 'signup'            // a fresh tenant was provisioned (account created)
  | 'init'             // a repo/project was registered with myAI (app-directory card)
  | 'first_brain_boot' // the tenant's first context_boot bundle served
  | 'first_brain_delta'// the tenant's first brain_delta catch-up served
  | 'wrapup_merge'     // the tenant's first wrap-up brain_merge (continuity aha)
  | 'first_task'       // the tenant's first task queued (lifecycle email only)
  | 'first_ship'       // the tenant's first task shipped/done (lifecycle email only)
  | 'first_hosted_brain'; // the tenant's first hosted-brain provision (cross-machine sync conversion KPI)

export interface IActivationEvent extends Document {
  tenantId: string;        // tenantField — scoped, required (ADR-010)
  step: ActivationStep;
  repo?: string;           // repo the milestone was reached for, when known
  source: 'gateway' | 'signup' | 'runner' | 'dashboard';
  occurredAt: Date;        // when the milestone was first reached
  metadata?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const activationEventSchema = new Schema<IActivationEvent>({
  tenantId: tenantField,
  step: {
    type: String,
    required: true,
    enum: ['signup', 'init', 'first_brain_boot', 'first_brain_delta', 'wrapup_merge', 'first_task', 'first_ship', 'first_hosted_brain'],
  },
  repo: { type: String },
  source: { type: String, required: true, enum: ['gateway', 'signup', 'runner', 'dashboard'], default: 'gateway' },
  occurredAt: { type: Date, required: true, default: Date.now },
  metadata: { type: Schema.Types.Mixed },
}, { timestamps: true });

// One row per tenant per step — the idempotency key for first-wins recording.
activationEventSchema.index({ tenantId: 1, step: 1 }, { unique: true });
// Funnel rollup hot path: distinct tenants reaching each step over a window.
activationEventSchema.index({ step: 1, occurredAt: -1 });
activationEventSchema.index({ tenantId: 1, occurredAt: -1 });

// ── TenantRequestQuota (per-tenant monthly request counter) ──
// One row per (tenant, calendar-month) holding a monotonically-incremented
// request count. The gateway edge middleware (core/tenant-quota.ts) does an
// atomic `$inc` (upsert) on every billable request and enforces the plan's
// monthlyRequests cap, returning 429 + Retry-After when exceeded. A dedicated
// counter (not an aggregation over UsageEvent) keeps the hot-path cost to one
// indexed upsert. `period` is the UTC `YYYY-MM` bucket; quota resets naturally
// on the calendar-month boundary because the next month is a fresh row.
export interface ITenantRequestQuota extends Document {
  tenantId: string;        // tenantField — scoped, required (ADR-010)
  period: string;          // UTC calendar month, "YYYY-MM"
  count: number;           // requests counted this period (monotonic within the month)
  createdAt: Date;
  updatedAt: Date;
}

const tenantRequestQuotaSchema = new Schema<ITenantRequestQuota>({
  tenantId: tenantField,
  period: { type: String, required: true },
  count: { type: Number, required: true, default: 0 },
}, { timestamps: true });

// One counter row per tenant per month — the atomic-upsert key.
tenantRequestQuotaSchema.index({ tenantId: 1, period: 1 }, { unique: true });

// ── WebhookEndpoint (outbound integrations) ──────────────
// A tenant-registered outbound webhook. On task/plan/runner lifecycle events
// the dispatcher (webhooks/webhook-dispatcher.ts) POSTs an HMAC-signed payload
// to `url` for every active endpoint subscribed to the event. `secret` signs
// the body (`X-Myai-Signature`) so the receiver can verify authenticity;
// `events` is the subscription list (`["*"]` = all). Delivery attempts are
// tracked per-delivery in WebhookDelivery, not here.
export interface IWebhookEndpoint extends Document {
  tenantId: string;        // tenantField — scoped, required (ADR-010)
  endpointId: string;      // stable public id, "wh_<uuid>"
  url: string;             // HTTPS destination
  secret: string;          // HMAC signing secret ("whsec_…"); returned only on create
  events: string[];        // canonical event names or ["*"]
  active: boolean;         // paused endpoints are skipped by the dispatcher
  description?: string;
  lastStatus?: 'delivered' | 'failed' | 'dead'; // last delivery outcome (ops view)
  lastDeliveryAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const webhookEndpointSchema = new Schema<IWebhookEndpoint>({
  tenantId: tenantField,
  endpointId: { type: String, required: true },
  url: { type: String, required: true },
  secret: { type: String, required: true },
  events: { type: [String], default: ['*'] },
  active: { type: Boolean, default: true },
  description: { type: String },
  lastStatus: { type: String, enum: ['delivered', 'failed', 'dead'] },
  lastDeliveryAt: { type: Date },
}, { timestamps: true });

webhookEndpointSchema.index({ tenantId: 1, endpointId: 1 }, { unique: true });
webhookEndpointSchema.index({ tenantId: 1, active: 1 });

// ── WebhookDelivery (at-least-once delivery queue + dead-letter) ──────
// One row per (event × endpoint) delivery attempt-chain. Created 'pending', the
// retry worker claims due rows ({status, nextAttemptAt}), POSTs, and on failure
// either reschedules with exponential backoff ('retrying') or dead-letters
// ('dead') once attempts are exhausted. A delivered row is the durable
// at-least-once record; dead rows are the dead-letter queue for manual replay.
export type WebhookDeliveryStatus = 'pending' | 'delivering' | 'retrying' | 'delivered' | 'dead';

export interface IWebhookDelivery extends Document {
  tenantId: string;        // tenantField — scoped, required (ADR-010)
  deliveryId: string;      // stable public id, "whd_<uuid>"
  endpointId: string;      // FK → WebhookEndpoint.endpointId
  url: string;             // snapshot of the destination at enqueue time
  event: string;           // canonical event name
  payload: Record<string, unknown>; // the JSON body sent to the endpoint
  status: WebhookDeliveryStatus;
  attempts: number;        // delivery attempts made so far
  maxAttempts: number;     // dead-letter threshold (snapshot)
  nextAttemptAt: Date;     // due time for the next attempt (worker claim key)
  lastError?: string;
  lastStatusCode?: number;
  deliveredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const webhookDeliverySchema = new Schema<IWebhookDelivery>({
  tenantId: tenantField,
  deliveryId: { type: String, required: true },
  endpointId: { type: String, required: true },
  url: { type: String, required: true },
  event: { type: String, required: true },
  payload: { type: Schema.Types.Mixed, default: {} },
  status: { type: String, required: true, default: 'pending', index: true },
  attempts: { type: Number, required: true, default: 0 },
  maxAttempts: { type: Number, required: true, default: 6 },
  nextAttemptAt: { type: Date, required: true, default: () => new Date() },
  lastError: { type: String },
  lastStatusCode: { type: Number },
  deliveredAt: { type: Date },
}, { timestamps: true });

webhookDeliverySchema.index({ tenantId: 1, deliveryId: 1 }, { unique: true });
// Worker claim hot path: due, un-terminal deliveries ordered by when they came due.
webhookDeliverySchema.index({ status: 1, nextAttemptAt: 1 });
webhookDeliverySchema.index({ tenantId: 1, endpointId: 1, createdAt: -1 });

// ── InboundWebhookDelivery (dedup guard for the GitHub receiver) ──────
// GitHub retries a delivery on a non-2xx/timeout response, and can also
// re-send the same delivery id after a receiver-side blip — the dedupe key
// is the unique (tenantId, source, deliveryId) index below, so a repeat
// insert throws E11000 and the receiver treats that as "already processed"
// rather than double-creating a task. TTL matches GitHub's own delivery
// redelivery window (a few days); no durable history is needed past that.
export interface IInboundWebhookDelivery extends Document {
  tenantId: string;
  source: string;      // 'github' | 'connect' | ...
  deliveryId: string;   // the sender's delivery id (e.g. x-github-delivery)
  receivedAt: Date;
}

const inboundWebhookDeliverySchema = new Schema<IInboundWebhookDelivery>({
  tenantId: tenantField,
  source: { type: String, required: true },
  deliveryId: { type: String, required: true },
  receivedAt: { type: Date, required: true, default: () => new Date() },
});

inboundWebhookDeliverySchema.index({ tenantId: 1, source: 1, deliveryId: 1 }, { unique: true });
// TTL: reap dedup records 7 days after receipt — well past any realistic redelivery window.
inboundWebhookDeliverySchema.index({ receivedAt: 1 }, { expireAfterSeconds: 7 * 24 * 3600 });

// ── TenantToolPlugin (custom MCP tool plugin registry — env-gated) ────
// One row per tenant-registered custom MCP tool: a name + JSON-Schema input
// contract + an HTTPS handler URL the gateway PROXIES tools/call to with a
// per-plugin timeout. Extends the built-in tool surface at runtime without a
// redeploy. Feature is off by default (MYAI_TENANT_TOOL_PLUGINS env gate);
// rows are strictly tenant-scoped — a plugin never appears in another
// tenant's tools/list and can never shadow a built-in tool (built-ins win at
// dispatch). See runtime/src/mcp/plugin-tools.ts.
export interface ITenantToolPlugin extends Document {
  tenantId: string;                       // tenantField — scoped, required (ADR-010)
  name: string;                           // snake_case tool name, unique per tenant
  description: string;
  inputSchema: Record<string, unknown>;   // MCP tool inputSchema (JSON Schema, type:'object')
  handlerUrl: string;                     // HTTPS endpoint the gateway POSTs the call to
  timeoutMs: number;                      // per-call proxy timeout (clamped at registration)
  enabled: boolean;                       // disabled plugins are hidden + refuse dispatch
  createdAt: Date;
  updatedAt: Date;
}

const tenantToolPluginSchema = new Schema<ITenantToolPlugin>({
  tenantId: tenantField,
  name: { type: String, required: true },
  description: { type: String, required: true },
  inputSchema: { type: Schema.Types.Mixed, required: true },
  handlerUrl: { type: String, required: true },
  timeoutMs: { type: Number, required: true },
  enabled: { type: Boolean, default: true },
}, { timestamps: true });

tenantToolPluginSchema.index({ tenantId: 1, name: 1 }, { unique: true });

// ── Tenant (M1 multi-tenancy — the isolation root, ADR-010) ──
// One row per paying account. Every scoped collection carries this row's
// `tenantId`. Per-tenant API keys authenticate gateway requests: the caller
// presents the raw key, the auth middleware looks it up by `apiKeyPrefix`
// (indexed, non-secret) then verifies the full key against `apiKeyHash`
// (sha256, never returned). Key generation/hashing is owned by the auth layer
// (next slice); this schema is the storage contract.

export type TenantPlan = 'free' | 'solo' | 'team' | 'scale';
export type TenantStatus = 'active' | 'suspended' | 'deleted';
// Stripe subscription lifecycle (M5 / Day 7). 'none' = never subscribed.
// Mirrors the subset of Stripe subscription.status we act on; the billing gate
// (core/billing.ts) treats only 'active'/'trialing' as entitling.
export type SubscriptionStatus =
  | 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';
// Data-residency / region pinning (ADR-023). 'us' is the implicit region of
// every pre-ADR-023 tenant (see migration 003) — it MUST stay first/default so
// existing single-region deployments are unaffected.
export type TenantRegion = 'us' | 'eu' | 'au';
// Physical DB isolation tier (ADR-030). 'shared' is the implicit tier of every
// pre-ADR-030 tenant (see migration 004) — it MUST stay first/default so the
// shared-tier majority is unaffected.
export type TenantIsolationTier = 'shared' | 'dedicated-db' | 'dedicated-cluster';

export interface ITenant extends Document {
  tenantId: string;          // stable slug/uuid stamped on every scoped record
  name: string;
  apiKeyHash: string;        // sha256 hex of the per-tenant key (NEVER the raw key)
  apiKeyPrefix: string;      // non-secret lookup prefix (e.g. "myai_live_8Kf2")
  // Rotation grace overlap (`myai rotate-keys tenant`, core/tenant-keys.ts
  // rotateApiKey): the key rotated OUT of `apiKeyHash`/`apiKeyPrefix` above,
  // still valid until `apiKeyPreviousExpiresAt` so a rotation never 401s a
  // caller mid-swap. Cleared (graceMinutes=0) for an immediate cutover.
  apiKeyHashPrevious?: string;
  apiKeyPrefixPrevious?: string;
  apiKeyPreviousExpiresAt?: Date;
  plan: TenantPlan;
  status: TenantStatus;
  // Data-residency / region pinning (ADR-023): the region this tenant's
  // records + off-hours runner work are pinned to, enforced by
  // core/region-guard.ts against the serving gateway's configured
  // `GATEWAY_REGION`. Set at provisioning (tenant-keys.ts provisionTenant);
  // changing it post-signup is a support-assisted operation (no self-serve
  // move endpoint in the MVP — moving data between regions is the hard part,
  // deliberately out of scope here same as ADR-010 deferred physical
  // per-tenant DB isolation).
  region: TenantRegion;
  ownerEmail?: string;       // self-serve signup owner (M2)
  stripeCustomerId?: string; // billing link (M5 / Day 7)
  stripeSubscriptionId?: string;        // M5 — active subscription id (Solo tier)
  subscriptionStatus?: SubscriptionStatus; // M5 — Stripe subscription state; gate reads this
  currentPeriodEnd?: Date;              // M5 — paid-through date (renewal boundary)
  paymentFailureCount?: number;         // dunning — consecutive failed invoice attempts (reset on recovery)
  lastPaymentFailedAt?: Date;           // dunning — timestamp of the most recent failed payment
  creditBalance?: number;    // GROWTH — gift/redeemable-code credit grants (core/gift-codes.ts); Stripe never writes this
  // Per-tenant TOTP enforcement policy (core/totp.ts): when true, login()
  // refuses to issue a full session for a member without totpEnabled — it
  // returns `totpEnrollmentRequired` instead so the dashboard forces enrolment
  // before granting access. Owner/admin-only toggle (POST /api/auth/tenant/2fa-policy).
  require2fa?: boolean;
  // Inbound GitHub webhook receiver (GATEWAY inbound-webhook task): each
  // tenant gets its own signing secret so GitHub events for that tenant's
  // repos verify against POST /api/webhooks/github/:tenantId with a secret
  // only that tenant knows — mirrors the outbound WebhookEndpoint.secret
  // model but in the receive direction. select:false like apiKeyHash so a
  // generic tenant read never leaks it; resolved explicitly in
  // webhooks/inbound-webhook-store.ts.
  githubWebhookSecret?: string;
  // Per-tenant transactional-email branding (notifications/email-templates.ts):
  // the shared template layer resolves these for the From/Reply-To headers and
  // the logo shown in the rendered layout. All optional — unset fields fall
  // back to the product defaults (SMTP_FROM/MAIL_FROM env, "myAI").
  emailBranding?: {
    fromName?: string;
    fromAddress?: string;
    replyTo?: string;
    logoUrl?: string;
    primaryColor?: string;
  };
  // Legal/litigation hold (compliance): when true, the data-retention purge
  // (core/data-retention.ts) skips EVERY collection for this tenant outright,
  // regardless of how far past its retention window a row is. Support/operator
  // toggle only — no self-serve endpoint, same posture as `region` above.
  legalHold?: boolean;
  // Operator-side data-retention purge-on-cancel (core/tenant-lifecycle.ts) —
  // distinct from account-erasure.ts's user-initiated right-to-erasure flow
  // (see that file's header). Set when the Stripe subscription is fully
  // canceled (billing webhook `customer.subscription.deleted`): a grace
  // window (CANCELLATION_PURGE_GRACE_DAYS, default 30) precedes the
  // irreversible purge, so a resubscribe before the deadline clears this
  // field instead. `cancellationPurgedAt` is stamped once the sweep tombstones
  // the row (mirrors ErasureRequest.purgedAt).
  cancellationPurgeAt?: Date;
  cancellationPurgedAt?: Date;
  // Per-org MCP tool visibility override (Wave-2 #15, core/rbac.ts
  // `isToolVisibleForTenant`). Orthogonal to the RBAC role→capability gate:
  // `mcpToolDenylist` additionally hides an otherwise-visible tool from THIS
  // org; `mcpToolAllowlist` punches a documented hole through the default
  // `OPERATOR_ONLY_TOOLS` hiding for THIS org. Both empty/absent for every
  // tenant by default — operator-set only, no self-serve endpoint (same
  // posture as `legalHold`/`region`).
  mcpToolAllowlist?: string[];
  mcpToolDenylist?: string[];
  // Physical isolation tier (ADR-030, data-model-only slice — no routing code
  // reads this yet, that's the getConnectionForTenant chokepoint, a separate
  // queued follow-up). 'shared' is the default for every tenant, including
  // every pre-existing row backfilled by migration 004 — zero behavior change
  // until the Phase-3 enterprise tier is actually sold.
  isolationTier: TenantIsolationTier;
  metadata: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

const tenantSchema = new Schema<ITenant>({
  tenantId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  apiKeyHash: { type: String, required: true, select: false },
  apiKeyPrefix: { type: String, required: true, unique: true, index: true },
  apiKeyHashPrevious: { type: String, select: false },
  githubWebhookSecret: { type: String, select: false },
  apiKeyPrefixPrevious: { type: String, index: true, sparse: true },
  apiKeyPreviousExpiresAt: { type: Date },
  plan: { type: String, required: true, enum: ['free', 'solo', 'team', 'scale'], default: 'free', index: true },
  status: { type: String, required: true, enum: ['active', 'suspended', 'deleted'], default: 'active', index: true },
  // ADR-023 data residency. 'us' default keeps every pre-existing tenant row
  // (backfilled by migration 003) and every non-region-aware caller unchanged.
  region: { type: String, required: true, enum: ['us', 'eu', 'au'], default: 'us', index: true },
  ownerEmail: { type: String },
  stripeCustomerId: { type: String },
  stripeSubscriptionId: { type: String },
  subscriptionStatus: {
    type: String,
    enum: ['none', 'trialing', 'active', 'past_due', 'canceled', 'incomplete'],
    default: 'none',
    index: true,
  },
  currentPeriodEnd: { type: Date },
  paymentFailureCount: { type: Number, default: 0 }, // dunning — failed invoice attempts
  lastPaymentFailedAt: { type: Date },               // dunning — last failure timestamp
  creditBalance: { type: Number, default: 0 },       // gift/redeemable-code credit grants
  require2fa: { type: Boolean, default: false },     // per-tenant TOTP enforcement policy
  legalHold: { type: Boolean, default: false, index: true }, // data-retention purge exemption
  cancellationPurgeAt: { type: Date, index: true },   // purge-on-cancel grace-window cutoff
  cancellationPurgedAt: { type: Date },               // stamped once the cancellation sweep purges
  mcpToolAllowlist: { type: [String], default: undefined },  // per-org MCP tool visibility override (allow)
  mcpToolDenylist: { type: [String], default: undefined },   // per-org MCP tool visibility override (deny)
  // ADR-030 physical isolation tier. 'shared' default keeps every pre-existing
  // tenant row (backfilled by migration 004) and every isolation-unaware
  // caller unchanged.
  isolationTier: {
    type: String,
    required: true,
    enum: ['shared', 'dedicated-db', 'dedicated-cluster'],
    default: 'shared',
    index: true,
  },
  emailBranding: {
    type: new Schema({
      fromName: { type: String },
      fromAddress: { type: String },
      replyTo: { type: String },
      logoUrl: { type: String },
      primaryColor: { type: String },
    }, { _id: false }),
    required: false,
  },
  metadata: { type: Schema.Types.Mixed, default: {} },
}, { timestamps: true });

tenantSchema.index({ apiKeyPrefix: 1, status: 1 }); // auth hot path

// ── TenantApiKey (M2 — scoped, rotatable per-tenant keys, ADR-010 §3.6) ──────
// The tenant doc's single `apiKeyHash`/`apiKeyPrefix` (above) is the legacy
// bootstrap credential; this collection holds the NAMED, SCOPED keys an
// owner/admin mints from the dashboard. Multiple live keys per tenant enable
// zero-downtime rotation (a grace window where the old key still authenticates)
// and least-privilege scoping. Same storage posture as the tenant key: only the
// sha256 hash is persisted (select:false) and the raw key is shown once. The
// auth middleware looks a key up by `apiKeyPrefix` (indexed, non-secret) across
// BOTH this collection and the tenant doc, then verifies against `apiKeyHash`.

export type ApiKeyStatus = 'active' | 'revoked';

export interface ITenantApiKey extends Document {
  keyId: string;             // stable id (key_<hex>) — the handle for rotate/revoke
  tenantId: string;          // owning tenant (isolation root)
  name: string;              // human label ("CI runner", "Zapier", …)
  scopes: string[];          // granted scopes; ['*'] = full access
  apiKeyHash: string;        // sha256 hex of the raw key (NEVER the raw key)
  apiKeyPrefix: string;      // non-secret lookup prefix (indexed, unique)
  env: 'live' | 'test';
  status: ApiKeyStatus;
  createdBy?: string;        // userId of the owner/admin who minted it
  lastUsedAt?: Date;         // stamped by the auth hot path (best-effort)
  expiresAt?: Date;          // rotation grace cutoff — auth rejects past this
  rotatedFromKeyId?: string; // the key this one replaced (rotation lineage)
  rotatedToKeyId?: string;   // the key that replaced this one (set on rotate)
  createdAt: Date;
  updatedAt: Date;
}

const tenantApiKeySchema = new Schema<ITenantApiKey>({
  keyId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, index: true },
  name: { type: String, required: true },
  scopes: { type: [String], required: true, default: ['*'] },
  apiKeyHash: { type: String, required: true, select: false },
  apiKeyPrefix: { type: String, required: true, unique: true, index: true },
  env: { type: String, required: true, enum: ['live', 'test'], default: 'live' },
  status: { type: String, required: true, enum: ['active', 'revoked'], default: 'active', index: true },
  createdBy: { type: String },
  lastUsedAt: { type: Date },
  expiresAt: { type: Date },
  rotatedFromKeyId: { type: String },
  rotatedToKeyId: { type: String },
}, { timestamps: true });

tenantApiKeySchema.index({ tenantId: 1, status: 1 }); // per-tenant list + hot path
tenantApiKeySchema.index({ apiKeyPrefix: 1, status: 1 }); // auth hot path

// ── TenantDbBinding (ADR-030 §4 — physical isolation routing table) ────────
// Gateway-internal, lives in the *shared* cluster alongside Tenant (it has to
// — it's what tells the gateway where a tenant's dedicated database is, so it
// can't itself be behind that indirection). Data-model-only in this slice:
// nothing reads/writes it yet — the routing chokepoint (`getConnectionForTenant`
// in a future `tenant-db-registry.ts`) and the provisioning/migration flow
// (ADR-030 §3) are separate queued follow-ups. A row only ever exists for a
// tenant that has opted into `dedicated-db`/`dedicated-cluster`; `shared`-tier
// tenants (the default, unconditionally today) have no binding at all.
export interface ITenantDbBinding extends Document {
  tenantId: string;              // unique, indexed — FK to Tenant.tenantId
  isolationTier: Exclude<TenantIsolationTier, 'shared'>;
  // Live credentials to the tenant's dedicated infrastructure — same
  // select:false + never-logged posture as Tenant.apiKeyHash. Any logging of
  // this field MUST go through the existing redactMongoUri() helper, never a
  // reimplementation (ADR-030 "Severity flags for implementers", HIGH).
  mongoUri: string;
  dbName: string;
  // ADR-032 §3.3 adds the terminal 'decommissioned' value (additive to this
  // ADR-030 field): dedicated is the sole copy, shared-tier rows for this
  // tenant no longer exist, and — per §2.1's routing table — this status
  // must route identically to 'active' (dedicated-only), never fall back to
  // shared, since shared no longer has the data at all.
  status: 'provisioning' | 'migrating' | 'active' | 'suspended' | 'decommissioned';
  provisionedAt: Date;
  migratedAt?: Date;
  // ADR-032 §3.3 — set only once the decommission sweep (`decommission-sweep.ts`)
  // has bulk-deleted this tenant's shared-tier rows and flipped `status` to
  // 'decommissioned'. Irreversible by design (§3.4) — absent until then.
  decommissionedAt?: Date;
  // ADR-031 §5 step 4 — persisted output of the periodic reconciliation sweep
  // (`dual-write-reconciler.ts`), so the cutover gate can check "is the *last*
  // sweep clean and recent" without re-running a full checksum synchronously
  // at cutover time. Absent until the first sweep runs for this tenant.
  lastReconciledAt?: Date;
  lastReconcileClean?: boolean;
  // ADR-032 §1.4 — durable poll state for the `dedicated-cluster` async
  // provisioning flow (`tenant-provisioning-worker.ts`). Present only while
  // `status === 'provisioning'` AND `atlasClusterName` is set; cleared on
  // success (readiness check passes, §1.6). `dedicated-db` provisioning runs
  // synchronously (§1.3) and never sets this field.
  provisioning?: {
    requestedAt: Date;
    attempts: number;
    nextPollAt: Date;
    lastError?: string;
  };
  // ADR-032 §1.4 — `dedicated-cluster` only. Identifies the Atlas project +
  // cluster this binding's dedicated infrastructure lives in, so the worker
  // and `teardownTenantProvisioning` (§1.7) can re-derive Atlas Admin API
  // targets from persisted state after a crash, never from in-memory state.
  atlasProjectId?: string;
  atlasClusterName?: string;
  createdAt: Date;
  updatedAt: Date;
}

const tenantDbBindingSchema = new Schema<ITenantDbBinding>({
  tenantId: { type: String, required: true, unique: true, index: true },
  isolationTier: { type: String, required: true, enum: ['dedicated-db', 'dedicated-cluster'] },
  mongoUri: { type: String, required: true, select: false },
  dbName: { type: String, required: true },
  status: {
    type: String,
    required: true,
    enum: ['provisioning', 'migrating', 'active', 'suspended', 'decommissioned'],
    default: 'provisioning',
    index: true,
  },
  provisionedAt: { type: Date, required: true, default: Date.now },
  migratedAt: { type: Date },
  decommissionedAt: { type: Date },
  lastReconciledAt: { type: Date },
  lastReconcileClean: { type: Boolean },
  provisioning: {
    type: new Schema({
      requestedAt: { type: Date, required: true },
      attempts: { type: Number, required: true, default: 0 },
      nextPollAt: { type: Date, required: true },
      lastError: { type: String },
    }, { _id: false }),
    required: false,
  },
  atlasProjectId: { type: String },
  atlasClusterName: { type: String },
}, { timestamps: true });

// `tenant-provisioning-worker.ts` claim hot path (ADR-032 §1.4 step 2) — same
// shape as `dualWriteRetryItemSchema`'s `{status, nextAttemptAt}` claim index.
tenantDbBindingSchema.index({ status: 1, 'provisioning.nextPollAt': 1 });

// ── DualWriteRetryItem (ADR-031 §2 — dual-write shadow-copy retry queue) ────
// Durable "intent record" for a dual-write shadow-copy attempt. Lives in the
// shared cluster alongside Tenant/TenantDbBinding — same bootstrapping reason
// TenantDbBinding does: it is what tells the system a shadow copy is owed, so
// it cannot itself live behind the dedicated-connection indirection it's
// tracking. Data-model-only in this slice (this ADR's reconciliation sweep is
// the first consumer — it enqueues self-heal 'upsert' repair items on
// checksum/count divergence and reads this collection for the cutover gate);
// the inline-retry dispatcher and background drain worker (`dual-write-queue.ts`
// / `dual-write-worker.ts`) are separate queued follow-ups per ADR-031's file
// footprint list.
export type DualWriteRetryStatus = 'pending' | 'retrying' | 'resolved' | 'dead';
export type DualWriteOperation = 'upsert' | 'delete';

export interface IDualWriteRetryItem extends Document {
  tenantId: string;                  // FK -> Tenant.tenantId / TenantDbBinding.tenantId
  itemId: string;                    // stable id, "dwr_<uuid>"
  collectionName: string;            // scoped collection label, e.g. 'tasks', 'schedules'
  operation: DualWriteOperation;
  documentKey: string;               // the row's stable scoped id (e.g. taskId) - NOT
                                      // Mongo's _id, which differs across the two connections
  payload?: Record<string, unknown>; // resolved document snapshot to upsert; absent for 'delete'
  status: DualWriteRetryStatus;
  attempts: number;                  // background-worker attempts only (ADR-031 §1's inline
                                      // fast-retries are NOT counted here)
  maxAttempts: number;                // dead-letter threshold; default 20 (ADR-031 §3)
  nextAttemptAt: Date;                // worker claim key, same pattern as IWebhookDelivery
  lastError?: string;
  resolvedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const dualWriteRetryItemSchema = new Schema<IDualWriteRetryItem>({
  tenantId: { type: String, required: true, index: true },
  itemId: { type: String, required: true },
  collectionName: { type: String, required: true },
  operation: { type: String, required: true, enum: ['upsert', 'delete'] },
  documentKey: { type: String, required: true },
  payload: { type: Schema.Types.Mixed },
  status: { type: String, required: true, enum: ['pending', 'retrying', 'resolved', 'dead'], default: 'pending', index: true },
  attempts: { type: Number, required: true, default: 0 },
  maxAttempts: { type: Number, required: true, default: 20 },
  nextAttemptAt: { type: Date, required: true, default: () => new Date() },
  lastError: { type: String },
  resolvedAt: { type: Date },
}, { timestamps: true });

dualWriteRetryItemSchema.index({ tenantId: 1, itemId: 1 }, { unique: true });
// Worker claim hot path — identical shape to webhookDeliverySchema's.
dualWriteRetryItemSchema.index({ status: 1, nextAttemptAt: 1 });
// Cutover gate depth check (ADR-031 §5): "are there any unresolved items for this tenant."
dualWriteRetryItemSchema.index({ tenantId: 1, status: 1 });
// Reconciliation sweep's per-collection/key dedup lookup (avoid re-enqueuing a
// repair item every sweep interval while one is already pending/retrying).
dualWriteRetryItemSchema.index({ tenantId: 1, collectionName: 1, documentKey: 1, status: 1 });
// Resolved items are audit-adjacent, not durable state - reap 7 days after
// resolution, same precedent as IInboundWebhookDelivery's dedup-record TTL.
// Only applies to 'resolved'; 'dead' items are NOT TTL'd - they require
// operator action and must not silently vanish.
dualWriteRetryItemSchema.index(
  { resolvedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 3600, partialFilterExpression: { status: 'resolved' } },
);

// ── Tenant Secret Key (envelope encryption, ADR-010 §3.7) ──────────
// One per-tenant Data Encryption Key (DEK), itself wrapped ("envelope
// encrypted") by the gateway's master KMS-style key before it's persisted.
// `secret-crypto.ts` generates + wraps/unwraps the DEK; `tenant-secrets.ts`
// uses the unwrapped DEK to encrypt/decrypt the actual secret VALUES stored
// elsewhere (connector `env` values, OAuth tokens). A DB dump alone exposes
// only ciphertext + a wrapped key that is useless without the master key,
// which never lives in the database. `masterKeyVersion` records which master
// key wrapped this DEK, so master-key rotation can re-wrap every row (find by
// old version, unwrap, wrap with the new key, save) WITHOUT touching a single
// byte of the secret ciphertext it protects — that ciphertext was encrypted
// with the DEK, which never changes across a master-key rotation.
export interface ITenantSecretKey extends Document {
  tenantId: string;
  wrappedDek: string;       // base64 envelope: iv(12) + authTag(16) + ciphertext, master-key encrypted
  masterKeyVersion: string; // which master key (by version label) wrapped this DEK
  createdAt: Date;
  updatedAt: Date;
}

const tenantSecretKeySchema = new Schema<ITenantSecretKey>({
  tenantId: { type: String, required: true, unique: true, index: true },
  wrappedDek: { type: String, required: true },
  masterKeyVersion: { type: String, required: true },
}, { timestamps: true });

// ── User (M2 — dashboard auth, password-based) ────────────
// Human dashboard login lives here; the per-tenant API key (tenantSchema) stays
// the machine credential. A User belongs to exactly one tenant and carries a role.

export type UserRole = 'owner' | 'admin' | 'member' | 'viewer';

export interface IUser extends Document {
  userId: string;
  tenantId: string;
  email: string;
  passwordHash: string;
  displayName?: string;
  role: UserRole;
  lastLoginAt?: Date;
  // Lockout (see AccountUnlock below): count of consecutive failed logins
  // since the last success/unlock; lockedUntil is the hard-wait fallback the
  // self-serve unlock email lets a user skip. lockoutCount is separate — it
  // survives across lockout cycles (only reset on a SUCCESSFUL login) and
  // drives the exponential backoff on lockedUntil's duration, so an attacker
  // who keeps grinding through the unlock email each time still faces a
  // growing wait instead of a flat 30 minutes forever.
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
  lockoutCount?: number;
  // TOTP 2FA (core/totp.ts). `totpPendingSecret` holds the not-yet-confirmed
  // enrolment secret (set by /totp/enroll, cleared on verify-enroll success or
  // a fresh enroll call); `totpSecret` is the live, confirmed secret login
  // checks against. Only sha256 hashes of recovery codes are ever persisted —
  // same posture as API keys — and each is single-use (removed on redemption).
  totpSecret?: string;
  totpPendingSecret?: string;
  totpEnabled?: boolean;
  totpRecoveryCodes?: string[];
  totpVerifiedAt?: Date | null;
  // Email verification (M2 — signup wire-up, see core/email-verification.ts).
  // A fresh signup starts unverified; the welcome email doubles as the
  // verification email. Never gates login/dashboard access on its own (a
  // locked-out-of-your-own-account failure mode we specifically avoid) — it's
  // surfaced as a dismissible dashboard banner with a resend action instead.
  emailVerified?: boolean;
  emailVerifiedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSchema = new Schema<IUser>({
  userId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, index: true },
  email: { type: String, required: true, index: true },
  passwordHash: { type: String, required: true, select: false },
  displayName: { type: String },
  role: { type: String, required: true, enum: ['owner', 'admin', 'member', 'viewer'], default: 'member' },
  lastLoginAt: { type: Date },
  failedLoginAttempts: { type: Number, default: 0 },
  lockedUntil: { type: Date },
  lockoutCount: { type: Number, default: 0 },
  totpSecret: { type: String, select: false },
  totpPendingSecret: { type: String, select: false },
  totpEnabled: { type: Boolean, default: false },
  totpRecoveryCodes: { type: [String], select: false, default: undefined },
  totpVerifiedAt: { type: Date },
  emailVerified: { type: Boolean, default: false },
  emailVerifiedAt: { type: Date },
}, { timestamps: true });

userSchema.index({ email: 1, tenantId: 1 }, { unique: true });

// ── UserSession (device/session management) ─────────────────
// One row per minted JWT session — every login-method (password, magic-link,
// SSO, TOTP-verify) records one via core/user-sessions.ts so the dashboard can
// list a user's active devices, revoke one or all, and password-reset can
// force-revoke every outstanding session. `sessionId` is the JWT's `sid`
// claim; a row with no matching JWT (or vice versa) is inert — the JWT alone
// can never authenticate past the revocation check once revokedAt is set.

export interface IUserSession extends Document {
  sessionId: string;
  userId: string;
  tenantId: string;
  userAgent?: string;
  ip?: string;
  lastSeenAt: Date;
  revokedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const userSessionSchema = new Schema<IUserSession>({
  sessionId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true, index: true },
  userAgent: { type: String },
  ip: { type: String },
  lastSeenAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null },
}, { timestamps: true });

userSessionSchema.index({ userId: 1, revokedAt: 1 });

// ── Invite (Team tier — join an existing tenant) ────────────
// An owner/admin generates an email-addressed, expiring invite; the invitee's
// signup redeems it and joins the inviter's tenant (role from the invite,
// default `member`). Only the sha256 of the raw token is stored — the raw
// token travels out-of-band (invite link) and is shown once at creation.

export type InviteStatus = 'pending' | 'accepted' | 'revoked';

export interface IInvite extends Document {
  inviteId: string;
  tenantId: string;
  email: string;            // the address the invite is locked to
  role: UserRole;           // role granted on acceptance (never 'owner')
  tokenHash: string;        // sha256 hex of the raw token (NEVER the raw token)
  invitedBy: string;        // userId of the inviting owner/admin
  status: InviteStatus;
  expiresAt: Date;
  acceptedBy?: string;      // userId created on acceptance
  acceptedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const inviteSchema = new Schema<IInvite>({
  inviteId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, index: true },
  email: { type: String, required: true },
  role: { type: String, required: true, enum: ['admin', 'member', 'viewer'], default: 'member' },
  tokenHash: { type: String, required: true, unique: true, index: true },
  invitedBy: { type: String, required: true },
  status: { type: String, required: true, enum: ['pending', 'accepted', 'revoked'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true },
  acceptedBy: { type: String },
  acceptedAt: { type: Date },
}, { timestamps: true });

inviteSchema.index({ tenantId: 1, email: 1, status: 1 }); // one pending invite per address

// ── PasswordReset (Team tier — forgot-password flow) ────────
// A reset request mints an email-addressed, expiring, single-use token; only
// its sha256 is stored (same posture as invites/API keys). The raw token
// travels out-of-band (the reset email) and is never persisted or re-shown.
// Re-requesting supersedes any prior pending reset for the address.

export type PasswordResetStatus = 'pending' | 'used' | 'superseded';

export interface IPasswordReset extends Document {
  resetId: string;
  userId: string;
  tenantId: string;
  email: string;             // the address the reset is locked to
  tokenHash: string;         // sha256 hex of the raw token (NEVER the raw token)
  status: PasswordResetStatus;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const passwordResetSchema = new Schema<IPasswordReset>({
  resetId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true },
  email: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  status: { type: String, required: true, enum: ['pending', 'used', 'superseded'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date },
}, { timestamps: true });

passwordResetSchema.index({ email: 1, status: 1 }); // one pending reset per address

// ── AccountUnlock (self-serve auto-unlock-via-email after lockout) ──────────
// Distinct from PasswordReset (user-initiated credential change) and MagicLink
// (passwordless login): this is the AUTOMATIC post-lockout recovery path —
// core/user-auth.ts fires it the moment a login trips the failed-attempt
// threshold, so the user can self-serve unlock instead of waiting out the
// lockout window or filing a support ticket. Same posture as the others: only
// the sha256 of the raw token is stored; a fresh lockout supersedes any prior
// pending unlock for the address.

export type AccountUnlockStatus = 'pending' | 'used' | 'superseded';

export interface IAccountUnlock extends Document {
  unlockId: string;
  userId: string;
  tenantId: string;
  email: string;             // the address the unlock is locked to
  tokenHash: string;         // sha256 hex of the raw token (NEVER the raw token)
  status: AccountUnlockStatus;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const accountUnlockSchema = new Schema<IAccountUnlock>({
  unlockId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true },
  email: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  status: { type: String, required: true, enum: ['pending', 'used', 'superseded'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date },
}, { timestamps: true });

accountUnlockSchema.index({ email: 1, status: 1 }); // one pending unlock per address
// TTL: reap rows 24h past expiry so consumed/expired email-bearing rows do not
// accumulate indefinitely (same posture as MagicLink).
accountUnlockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

// ── MagicLink (passwordless email login — primary auth path alongside
// password sign-in, distinct from PasswordReset/email-verification) ────────
// A login request mints an email-addressed, short-TTL, single-use token; only
// its sha256 is stored (same posture as PasswordReset/invites/API keys). The
// raw token travels out-of-band (the login email) and is never persisted or
// re-shown. Re-requesting supersedes any prior pending link for the address.

export type MagicLinkStatus = 'pending' | 'used' | 'superseded';

export interface IMagicLink extends Document {
  magicLinkId: string;
  userId: string;
  tenantId: string;
  email: string;             // the address the link is locked to
  tokenHash: string;         // sha256 hex of the raw token (NEVER the raw token)
  status: MagicLinkStatus;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ── ReviewApproval (Telegram remote-approve — C1 two-way action loop) ──────
// When a task flips to `review`, the gateway sends a Telegram message with
// inline Approve/Reject buttons. Telegram's callback_data has a 64-byte
// budget, so the button carries a short opaque `reviewId` rather than the
// taskId/tenantId themselves; this doc is the durable, tenant-scoped,
// single-use lookup the callback handler resolves it against — same posture
// as MagicLink (token out-of-band, DB row single-use + TTL'd).

export type ReviewApprovalStatus = 'pending' | 'resolved';
export type ReviewApprovalResolution = 'approved' | 'rejected';

export interface IReviewApproval extends Document {
  reviewId: string;
  tenantId: string;
  taskId: string;
  status: ReviewApprovalStatus;
  resolution?: ReviewApprovalResolution;
  telegramChatId: string;
  telegramMessageId?: number;
  resolvedByUserId?: string;  // Telegram user id that tapped the button
  resolvedAt?: Date;
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const reviewApprovalSchema = new Schema<IReviewApproval>({
  reviewId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, index: true },
  taskId: { type: String, required: true, index: true },
  status: { type: String, required: true, enum: ['pending', 'resolved'], default: 'pending', index: true },
  resolution: { type: String, enum: ['approved', 'rejected'] },
  telegramChatId: { type: String, required: true },
  telegramMessageId: { type: Number },
  resolvedByUserId: { type: String },
  resolvedAt: { type: Date },
  expiresAt: { type: Date, required: true },
}, { timestamps: true });

// TTL: reap rows a day past expiry — same posture as MagicLink/PasswordReset.
reviewApprovalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

// ── GiftCode + GiftRedemption (GROWTH — redeemable subscription codes) ─────
// An operator mints a code that grants a plan tier for N months or a pool of
// credits — for promos, partnerships, and the design-partner program. Distinct
// from a Stripe checkout coupon (percent off a purchase, see billing.ts) and a
// tenant invite (joins an existing tenant); this is a standalone comp/promo
// grant, redeemed independently of any purchase. `code` is a human-typed,
// shareable string (like a coupon code) — unlike invite/reset/API-key tokens it
// is stored in the clear (uppercased, unique-indexed): minting requires an
// authenticated operator and redeeming only ever grants a comp benefit, so
// there is no credential to protect by hashing it.

// `trial_days` (design-partner program, GRAND_PRODUCT §7.4): a day-granular
// variant of `plan_months` used specifically for time-boxed trials (e.g. a
// 60-day Solo trial) — redemption sets the tenant's subscriptionStatus to
// 'trialing' instead of 'active', so it reads correctly as a trial rather
// than a paid grant. `plan_months` stays month-granular for whole-month comp
// grants (promos/partnerships); the two are intentionally separate grant
// types rather than unifying on days, since minting a "3 month" comp code in
// days would be a lossy/awkward operator UX.
export type GiftCodeGrantType = 'plan_months' | 'credits' | 'trial_days';
export type GiftCodeStatus = 'active' | 'disabled' | 'exhausted' | 'expired';

export interface IGiftCode extends Document {
  codeId: string;
  code: string;                    // human-typed redemption code, e.g. "MYAI-7F3K-Q9RT"
  grantType: GiftCodeGrantType;
  grantPlan?: TenantPlan;          // set when grantType === 'plan_months' | 'trial_days' (never 'free')
  grantMonths?: number;            // set when grantType === 'plan_months'
  grantCredits?: number;           // set when grantType === 'credits'
  grantDays?: number;              // set when grantType === 'trial_days'
  maxRedemptions: number;          // distinct tenants that may redeem this code
  redemptionCount: number;
  status: GiftCodeStatus;
  note?: string;                   // operator-facing label ("Q3 design-partner batch")
  createdBy: string;               // operator identity (userId or system actor)
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ── AccountErasureRequest (GDPR/CCPA self-serve right-to-erasure) ───────────
// A tenant owner requests full account + data erasure from account settings
// (core/account-erasure.ts). A grace window (default 14 days,
// ERASURE_GRACE_DAYS) precedes the irreversible purge so the request can be
// canceled — the audit trail (core/audit-log.ts) records request/cancel/purge
// as the immutable evidence of the flow. Distinct from the operator-side
// data-retention purge-on-cancel (subscription lapse): this is the
// user-initiated legal right-to-erasure path. One active (pending) request per
// tenant at a time.

export type ErasureRequestStatus = 'pending' | 'canceled' | 'purged';

export interface IErasureRequest extends Document {
  requestId: string;
  tenantId: string;
  requestedBy: string;       // userId of the requesting owner
  status: ErasureRequestStatus;
  scheduledPurgeAt: Date;    // grace-window cutoff — the sweep acts at/after this
  reason?: string;           // optional free-text reason captured at request time
  canceledBy?: string;
  canceledAt?: Date;
  purgedAt?: Date;
  purgeSummary?: Record<string, number>; // collection -> deleted-doc count (evidence)
  createdAt: Date;
  updatedAt: Date;
}

const magicLinkSchema = new Schema<IMagicLink>({
  magicLinkId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true },
  email: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  status: { type: String, required: true, enum: ['pending', 'used', 'superseded'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date },
}, { timestamps: true });

magicLinkSchema.index({ email: 1, status: 1 }); // one pending link per address
// TTL: reap links 24h past expiry so consumed/expired email-bearing rows do not
// accumulate indefinitely (defense-in-depth vs. PII retention; on-demand erasure
// still purges the `magicLinks` collection immediately — see account-erasure.ts).
magicLinkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

// ── EmailVerification (M2 — verify the address behind a fresh signup) ──────
// Distinct from PasswordReset (credential change) and MagicLink (passwordless
// login): signup() auto-fires this the instant a user/tenant is provisioned
// (core/email-verification.ts), and the dashboard's resend banner can re-fire
// it any time the account is still unverified. Same posture as the sibling
// token flows: only the sha256 of the raw token is stored; a resend
// supersedes any prior pending verification for the address.

export type EmailVerificationStatus = 'pending' | 'used' | 'superseded';

export interface IEmailVerification extends Document {
  verificationId: string;
  userId: string;
  tenantId: string;
  email: string;             // the address the verification is locked to
  tokenHash: string;         // sha256 hex of the raw token (NEVER the raw token)
  status: EmailVerificationStatus;
  expiresAt: Date;
  usedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const emailVerificationSchema = new Schema<IEmailVerification>({
  verificationId: { type: String, required: true, unique: true, index: true },
  userId: { type: String, required: true, index: true },
  tenantId: { type: String, required: true },
  email: { type: String, required: true },
  tokenHash: { type: String, required: true, unique: true, index: true },
  status: { type: String, required: true, enum: ['pending', 'used', 'superseded'], default: 'pending', index: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date },
}, { timestamps: true });

emailVerificationSchema.index({ email: 1, status: 1 }); // one pending verification per address
// TTL: reap rows 24h past expiry — same posture as MagicLink/PasswordReset.
emailVerificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 86400 });

// ── LegalConsent (click-wrap acceptance record — core/legal.ts) ─────────────
// Append-only: one row per acceptance event (signup click-wrap or dashboard
// re-consent after a version bump). Never updated in place — the history IS
// the legal evidence. Latest row per tenant decides re-consent state. No TTL:
// consent records outlive the account (erasure anonymises, never deletes).
export interface ILegalConsent extends Document {
  consentId: string;
  tenantId: string;
  /** The user who clicked — consent is recorded per tenant, attributed to a user. */
  userId: string;
  email?: string;
  source: 'signup' | 'reconsent';
  ip?: string;
  termsVersion: string;
  privacyVersion: string;
  acceptableUseVersion: string;
  acceptedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const legalConsentSchema = new Schema<ILegalConsent>({
  consentId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, index: true },
  userId: { type: String, required: true, index: true },
  email: { type: String },
  source: { type: String, required: true, enum: ['signup', 'reconsent'] },
  ip: { type: String },
  termsVersion: { type: String, required: true },
  privacyVersion: { type: String, required: true },
  acceptableUseVersion: { type: String, required: true },
  acceptedAt: { type: Date, required: true },
}, { timestamps: true });

// Latest-acceptance lookup per tenant (consent status / re-consent check).
legalConsentSchema.index({ tenantId: 1, acceptedAt: -1 });

// ── FeatureFlag (core/feature-flags.ts — platform feature-flag service) ────
// One row per flag: global state (on/off/killed) + percentage rollout +
// per-tenant force-on/off overrides. Evaluation precedence lives in
// core/feature-flags.ts (killed beats overrides beats rollout).

export type FeatureFlagState = 'on' | 'off' | 'killed';

export interface IFeatureFlagOverride {
  tenantId: string;
  enabled: boolean;
}

export interface IFeatureFlag extends Document {
  key: string;
  description?: string;
  state: FeatureFlagState;
  /** 0–100 — only consulted when state === 'on'. */
  rolloutPercent: number;
  overrides: IFeatureFlagOverride[];
  updatedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const featureFlagSchema = new Schema<IFeatureFlag>({
  key: { type: String, required: true, unique: true, index: true },
  description: { type: String },
  state: { type: String, required: true, enum: ['on', 'off', 'killed'], default: 'off' },
  rolloutPercent: { type: Number, required: true, default: 0, min: 0, max: 100 },
  overrides: {
    type: [new Schema<IFeatureFlagOverride>({
      tenantId: { type: String, required: true },
      enabled: { type: Boolean, required: true },
    }, { _id: false })],
    default: [],
  },
  updatedBy: { type: String },
}, { timestamps: true });

// ── EmailDelivery (transactional-email delivery/bounce log) ────────────────
// One row per attempted transactional send through notifications/
// email-service.ts — which template (and version) went where, over which
// provider, and what happened to it. Provider webhooks (bounce, complaint,
// delivered) land on the same row via providerMessageId, so ops can answer
// "did the reset email for X actually arrive?" from one collection.

export type EmailDeliveryStatus =
  | 'sent'        // accepted by the transport
  | 'failed'      // transport threw — never left the gateway
  | 'suppressed'  // skipped: the address is on the suppression list
  | 'delivered'   // provider confirmed delivery (webhook)
  | 'bounced'     // provider reported a bounce (webhook)
  | 'complained'; // recipient marked it spam (webhook)

export interface IEmailDelivery extends Document {
  deliveryId: string;
  tenantId?: string;
  to: string;                  // recipient address (lowercased)
  template?: string;           // email-templates.ts template name, when rendered through one
  templateVersion?: number;    // version of that template at send time
  subject: string;
  provider: string;            // transport name: resend | smtp | console | …
  providerMessageId?: string;  // provider's own id — the webhook join key
  status: EmailDeliveryStatus;
  error?: string;              // transport error (status 'failed')
  lastEventAt?: Date;          // most recent provider webhook event
  createdAt: Date;
  updatedAt: Date;
}

const emailDeliverySchema = new Schema<IEmailDelivery>({
  deliveryId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String },
  to: { type: String, required: true },
  template: { type: String },
  templateVersion: { type: Number },
  subject: { type: String, required: true },
  provider: { type: String, required: true },
  providerMessageId: { type: String, index: true, sparse: true },
  status: {
    type: String,
    required: true,
    enum: ['sent', 'failed', 'suppressed', 'delivered', 'bounced', 'complained'],
    index: true,
  },
  error: { type: String },
  lastEventAt: { type: Date },
}, { timestamps: true });

emailDeliverySchema.index({ to: 1, createdAt: -1 }); // per-address history lookup
// Retention: the log is operational, not archival — reap rows after 90 days.
emailDeliverySchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 86400 });

// ── EmailSuppression (do-not-send list) ─────────────────────────────────────
// An address lands here on a hard bounce or a spam complaint (or a manual ops
// entry) and every future transactional send to it is skipped — repeatedly
// mailing a bouncing address is how a sending domain gets blocklisted.

export type EmailSuppressionReason = 'hard-bounce' | 'complaint' | 'manual';

export interface IEmailSuppression extends Document {
  email: string;  // lowercased, unique
  reason: EmailSuppressionReason;
  /** Where it came from: deliveryId of the triggering send, or an operator note. */
  source?: string;
  createdAt: Date;
  updatedAt: Date;
}

const emailSuppressionSchema = new Schema<IEmailSuppression>({
  email: { type: String, required: true, unique: true, index: true },
  reason: { type: String, required: true, enum: ['hard-bounce', 'complaint', 'manual'] },
  source: { type: String },
}, { timestamps: true });

const erasureRequestSchema = new Schema<IErasureRequest>({
  requestId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, index: true },
  requestedBy: { type: String, required: true },
  status: { type: String, required: true, enum: ['pending', 'canceled', 'purged'], default: 'pending', index: true },
  scheduledPurgeAt: { type: Date, required: true },
  reason: { type: String },
  canceledBy: { type: String },
  canceledAt: { type: Date },
  purgedAt: { type: Date },
  purgeSummary: { type: Schema.Types.Mixed },
}, { timestamps: true });

erasureRequestSchema.index({ tenantId: 1, status: 1 });
erasureRequestSchema.index({ status: 1, scheduledPurgeAt: 1 }); // sweep hot path

const giftCodeSchema = new Schema<IGiftCode>({
  codeId: { type: String, required: true, unique: true, index: true },
  code: { type: String, required: true, unique: true, index: true },
  grantType: { type: String, required: true, enum: ['plan_months', 'credits', 'trial_days'] },
  grantPlan: { type: String, enum: ['free', 'solo', 'team', 'scale'] },
  grantMonths: { type: Number },
  grantCredits: { type: Number },
  grantDays: { type: Number },
  maxRedemptions: { type: Number, required: true, default: 1 },
  redemptionCount: { type: Number, required: true, default: 0 },
  status: { type: String, required: true, enum: ['active', 'disabled', 'exhausted', 'expired'], default: 'active', index: true },
  note: { type: String },
  createdBy: { type: String, required: true },
  expiresAt: { type: Date },
}, { timestamps: true });

/** One redemption per tenant per code — the ledger row IS the dedupe guard. */
export interface IGiftRedemption extends Document {
  redemptionId: string;
  codeId: string;
  code: string;
  tenantId: string;
  grantType: GiftCodeGrantType;
  grantPlan?: TenantPlan;
  grantMonths?: number;
  grantCredits?: number;
  grantDays?: number;
  redeemedBy?: string;             // userId who redeemed, when known
  redeemedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const giftRedemptionSchema = new Schema<IGiftRedemption>({
  redemptionId: { type: String, required: true, unique: true, index: true },
  codeId: { type: String, required: true, index: true },
  code: { type: String, required: true },
  tenantId: { type: String, required: true, index: true },
  grantType: { type: String, required: true, enum: ['plan_months', 'credits', 'trial_days'] },
  grantPlan: { type: String, enum: ['free', 'solo', 'team', 'scale'] },
  grantMonths: { type: Number },
  grantCredits: { type: Number },
  grantDays: { type: Number },
  redeemedBy: { type: String },
  redeemedAt: { type: Date, required: true },
}, { timestamps: true });

giftRedemptionSchema.index({ codeId: 1, tenantId: 1 }, { unique: true }); // one redemption per tenant per code

// ── Feedback (design-partner program, GRAND_PRODUCT §7.4 — core/feedback.ts) ──
// Lightweight in-app capture surface: any signed-in member submits free-text
// feedback (bug/idea/general) from the dashboard widget, routed to the
// operator (email + this durable ledger for the admin list view). Distinct
// from a support ticket system — no reply thread, just capture + notify, the
// minimum viable loop for a design-partner cohort giving early feedback.

export type FeedbackCategory = 'bug' | 'idea' | 'general';
export type FeedbackStatus = 'new' | 'reviewed';

export interface IFeedback extends Document {
  feedbackId: string;
  tenantId: string;
  userId: string;
  email: string;
  category: FeedbackCategory;
  message: string;
  page?: string;              // client-side path the feedback was submitted from, e.g. "/apps"
  status: FeedbackStatus;
  createdAt: Date;
  updatedAt: Date;
}

const feedbackSchema = new Schema<IFeedback>({
  feedbackId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, index: true },
  userId: { type: String, required: true },
  email: { type: String, required: true },
  category: { type: String, required: true, enum: ['bug', 'idea', 'general'], default: 'general' },
  message: { type: String, required: true },
  page: { type: String },
  status: { type: String, required: true, enum: ['new', 'reviewed'], default: 'new', index: true },
}, { timestamps: true });

feedbackSchema.index({ tenantId: 1, createdAt: -1 });

// ── ReferralCode / ReferralSignup (GROWTH — referral program, core/referrals.ts) ──
// Every tenant gets one tracked invite code (created lazily on first lookup)
// backing a public `/welcome?ref=<code>` self-serve signup link. When a BRAND
// NEW tenant signs up through that link, both the referrer and the new tenant
// ("referee") are granted a one-time credit-balance bump (env-gated —
// REFERRAL_PROGRAM_ENABLED). Distinct from a gift code (operator-minted,
// arbitrary grant) and a tenant invite (joins an EXISTING tenant): a referral
// always provisions a brand-new tenant and rewards both sides. `code` is a
// short shareable string, stored in the clear like a gift code (no credential
// to protect).

export interface IReferralCode extends Document {
  referralCodeId: string;
  tenantId: string;         // the referring tenant (owner of this code)
  code: string;             // short shareable code, e.g. "R7K2M9QX"
  createdAt: Date;
  updatedAt: Date;
}

const referralCodeSchema = new Schema<IReferralCode>({
  referralCodeId: { type: String, required: true, unique: true, index: true },
  tenantId: { type: String, required: true, unique: true, index: true },
  code: { type: String, required: true, unique: true, index: true },
}, { timestamps: true });

/** One row per referred (referee) tenant — the ledger row IS the dedupe guard,
 *  so a tenant can be credited as a referee at most once, at its own signup. */
export interface IReferralSignup extends Document {
  referralId: string;
  code: string;
  referrerTenantId: string;
  refereeTenantId: string;
  referrerCredits: number;
  refereeCredits: number;
  createdAt: Date;
  updatedAt: Date;
}

const referralSignupSchema = new Schema<IReferralSignup>({
  referralId: { type: String, required: true, unique: true, index: true },
  code: { type: String, required: true, index: true },
  referrerTenantId: { type: String, required: true, index: true },
  refereeTenantId: { type: String, required: true, unique: true, index: true },
  referrerCredits: { type: Number, required: true },
  refereeCredits: { type: Number, required: true },
}, { timestamps: true });

// ── MigrationRecord (idempotent startup migration tracking) ──
// One row per migration id, written once its startup run completes
// successfully. Not tenant-scoped — migrations are gateway-wide schema/data
// changes. shared/migration-runner.ts checks this before re-running anything
// on every boot, and /readyz gates on every registered migration having a row
// here so a redeploy never serves traffic mid-migration or after a failed one.

export interface IMigrationRecord extends Document {
  migrationId: string;
  appliedAt: Date;
}

const migrationRecordSchema = new Schema<IMigrationRecord>({
  migrationId: { type: String, required: true, unique: true, index: true },
  appliedAt: { type: Date, required: true },
});

// ── Models ──────────────────────────────────────────────

// Hot-path schema handles exposed ONLY for index-strategy verification
// (tests/unit/db-indexes.test.ts) — runtime code must go through the Models.
export const hotPathSchemas = {
  taskSchema,
  notificationSchema,
  fleetRunSchema,
} as const;

export let TenantModel: Model<ITenant>;
export let TenantApiKeyModel: Model<ITenantApiKey>;
export let TenantDbBindingModel: Model<ITenantDbBinding>;
export let DualWriteRetryItemModel: Model<IDualWriteRetryItem>;
export let TenantSecretKeyModel: Model<ITenantSecretKey>;
export let GatewaySessionModel: Model<IGatewaySession>;
export let AIPatternModel: Model<IAIPattern>;
export let AgentModel: Model<IAgent>;
export let SkillModel: Model<ISkill>;
export let HookModel: Model<IHook>;
export let RuleModel: Model<IRule>;
export let VectorModel: Model<IVector>;
export let TaskModel: Model<ITask>;
export let RunnerLeaseModel: Model<IRunnerLease>;
export let RunnerLeaseHistoryModel: Model<IRunnerLeaseHistory>;
export let RunnerBacklogCursorModel: Model<IRunnerBacklogCursor>;
export let RunnerHeartbeatModel: Model<IRunnerHeartbeat>;
export let FleetMaintenanceModel: Model<IFleetMaintenance>;
export let ScheduleModel: Model<ISchedule>;
export let RecurringTaskModel: Model<IRecurringTask>;
export let BudgetUsageModel: Model<IBudgetUsage>;
export let BudgetUsageRollupModel: Model<IBudgetUsageRollup>;
export let BudgetCapOverrideModel: Model<IBudgetCapOverride>;
export let MemberBudgetCapModel: Model<IMemberBudgetCap>;
export let MrrSnapshotModel: Model<IMrrSnapshot>;
export let UsageEventModel: Model<IUsageEvent>;
export let NotificationModel: Model<INotification>;
export let PushSubscriptionModel: Model<IPushSubscription>;
export let NotificationPrefsModel: Model<INotificationPrefs>;
export let RepoCardModel: Model<IRepoCard>;
export let RepoModel: Model<IRepo>;
export let PlanDayModel: Model<IPlanDay>;
export let TrashEntryModel: Model<ITrashEntry>;
export let FleetRunModel: Model<IFleetRun>;
export let UserModel: Model<IUser>;
export let UserSessionModel: Model<IUserSession>;
export let InviteModel: Model<IInvite>;
export let PasswordResetModel: Model<IPasswordReset>;
export let AccountUnlockModel: Model<IAccountUnlock>;
export let MagicLinkModel: Model<IMagicLink>;
export let EmailVerificationModel: Model<IEmailVerification>;
export let EmailDeliveryModel: Model<IEmailDelivery>;
export let EmailSuppressionModel: Model<IEmailSuppression>;
export let ReviewApprovalModel: Model<IReviewApproval>;
export let GiftCodeModel: Model<IGiftCode>;
export let GiftRedemptionModel: Model<IGiftRedemption>;
export let FeedbackModel: Model<IFeedback>;
export let ReferralCodeModel: Model<IReferralCode>;
export let ReferralSignupModel: Model<IReferralSignup>;
export let ConnectorModel: Model<IConnector>;
export let HandoffModel: Model<IHandoff>;
export let ContinuityMetricModel: Model<IContinuityMetric>;
export let ActivationEventModel: Model<IActivationEvent>;
export let TenantRequestQuotaModel: Model<ITenantRequestQuota>;
export let WebhookEndpointModel: Model<IWebhookEndpoint>;
export let TenantToolPluginModel: Model<ITenantToolPlugin>;
export let WebhookDeliveryModel: Model<IWebhookDelivery>;
export let InboundWebhookDeliveryModel: Model<IInboundWebhookDelivery>;
export let ArtifactModel: Model<IArtifact>;
export let RunnerJobHistoryModel: Model<IRunnerJobHistory>;
export let ErasureRequestModel: Model<IErasureRequest>;
export let SpendAlertStateModel: Model<ISpendAlertState>;
export let TenantBudgetGateAlertStateModel: Model<ITenantBudgetGateAlertState>;
export let AtlasIndexHealthStateModel: Model<IAtlasIndexHealthState>;
export let MigrationRecordModel: Model<IMigrationRecord>;
export let LegalConsentModel: Model<ILegalConsent>;
export let FeatureFlagModel: Model<IFeatureFlag>;

// ── Connection ──────────────────────────────────────────

let connection: typeof mongoose | null = null;
let guardPluginRegistered = false;

/**
 * Driver pool size for the single shared connection, and the size any future
 * per-tenant `dedicated-db`/`dedicated-cluster` connection (ADR-030 §2,
 * `tenant-db-registry.ts`) MUST reuse rather than reinventing — exported so
 * `monitoring/dedicated-pool-alerter.ts` can size the dedicated-tier
 * connection-pool ceiling off the same number this connection actually uses,
 * instead of a second hardcoded constant the two could silently drift apart.
 */
export const SHARED_CONNECTION_MAX_POOL_SIZE = 20;

const CONNECT_OPTS = {
  serverSelectionTimeoutMS: 5000,
  connectTimeoutMS: 5000,
  maxPoolSize: SHARED_CONNECTION_MAX_POOL_SIZE,
  minPoolSize: 2,
  maxIdleTimeMS: 30000,
} as const;

/** Resolve the local-mirror URI for read-side failover. Explicit
 *  MYAI_DB_FAILOVER_URI wins; otherwise default to the compose local mongo
 *  (`mongo` service host, root creds matching docker-compose.yml / the
 *  `myai mirror` destination). */
function resolveFailoverUri(config: ReturnType<typeof getConfig>): string {
  if (config.database.failoverUri) return config.database.failoverUri;
  const user = process.env.LOCAL_MONGO_USER || 'admin';
  const pass = process.env.LOCAL_MONGO_PASS || 'password';
  const host = process.env.LOCAL_MONGO_HOST || 'mongo:27017';
  return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}/${config.database.name}?authSource=admin`;
}

export async function connectDB(): Promise<typeof mongoose> {
  const config = getConfig();
  const log = getLogger();

  if (connection) return connection;

  // Read-only failover guard (db-failover.ts) — global plugin so every model
  // compiled below rejects writes while failover is active. A no-op in the
  // normal (primary-connected) posture. Must register before mongoose.model().
  if (!guardPluginRegistered) {
    mongoose.plugin(readOnlyGuardPlugin);
    guardPluginRegistered = true;
  }

  try {
    try {
      connection = await mongoose.connect(config.database.uri, {
        dbName: config.database.name,
        ...CONNECT_OPTS,
      });
    } catch (primaryErr) {
      // Read-side local-first failover (MONGO_MIRROR.md follow-up). Explicit
      // opt-in (MYAI_DB_FAILOVER=local), loudly logged, READ-ONLY — never a
      // silent swap (2026-07-04 split-brain lesson). Surfaced on /health/deep
      // via getDbFailoverState() so the dashboard health panel shows it.
      const failoverUri = resolveFailoverUri(config);
      if (config.database.failover !== 'local' || failoverUri === config.database.uri) {
        throw primaryErr;
      }
      log.error(
        { err: primaryErr, primary: redactMongoUri(config.database.uri), mirror: redactMongoUri(failoverUri) },
        'Primary MongoDB unreachable — MYAI_DB_FAILOVER=local set, attempting READ-ONLY failover to the local mirror',
      );
      try {
        connection = await mongoose.connect(failoverUri, {
          dbName: config.database.name,
          ...CONNECT_OPTS,
        });
      } catch (failoverErr) {
        log.error(
          { err: failoverErr, mirror: redactMongoUri(failoverUri) },
          'DB FAILOVER FAILED: local mirror also unreachable — gateway running WITHOUT persistence',
        );
        throw primaryErr;
      }
      activateDbFailover({
        primaryUriHost: redactMongoUri(config.database.uri),
        failoverUriHost: redactMongoUri(failoverUri),
        reason: (primaryErr as Error).message,
      });
      log.error(
        {
          primary: redactMongoUri(config.database.uri),
          mirror: redactMongoUri(failoverUri),
          reason: (primaryErr as Error).message,
        },
        'DB FAILOVER ACTIVE: serving READS from the local mirror in READ-ONLY degraded mode. ' +
          'All writes are rejected until the primary is restored and the gateway restarted. ' +
          'Mirror freshness = last `myai mirror` run.',
      );
    }

    TenantModel = mongoose.model<ITenant>('Tenant', tenantSchema);
    TenantApiKeyModel = mongoose.model<ITenantApiKey>('TenantApiKey', tenantApiKeySchema);
    TenantDbBindingModel = mongoose.model<ITenantDbBinding>('TenantDbBinding', tenantDbBindingSchema);
    DualWriteRetryItemModel = mongoose.model<IDualWriteRetryItem>('DualWriteRetryItem', dualWriteRetryItemSchema);
    TenantSecretKeyModel = mongoose.model<ITenantSecretKey>('TenantSecretKey', tenantSecretKeySchema);
    GatewaySessionModel = mongoose.model<IGatewaySession>('GatewaySession', gatewaySessionSchema);
    AIPatternModel = mongoose.model<IAIPattern>('AIPattern', aiPatternSchema);
    AgentModel = mongoose.model<IAgent>('Agent', agentSchema);
    SkillModel = mongoose.model<ISkill>('Skill', skillSchema);
    HookModel = mongoose.model<IHook>('Hook', hookSchema);
    RuleModel = mongoose.model<IRule>('Rule', ruleSchema);
    VectorModel = mongoose.model<IVector>('Vector', vectorSchema);
    TaskModel = mongoose.model<ITask>('Task', taskSchema);
    RunnerLeaseModel = mongoose.model<IRunnerLease>('RunnerLease', runnerLeaseSchema);
    RunnerLeaseHistoryModel = mongoose.model<IRunnerLeaseHistory>('RunnerLeaseHistory', runnerLeaseHistorySchema);
    RunnerBacklogCursorModel = mongoose.model<IRunnerBacklogCursor>('RunnerBacklogCursor', runnerBacklogCursorSchema);
    RunnerHeartbeatModel = mongoose.model<IRunnerHeartbeat>('RunnerHeartbeat', runnerHeartbeatSchema);
    FleetMaintenanceModel = mongoose.model<IFleetMaintenance>('FleetMaintenance', fleetMaintenanceSchema);
    ScheduleModel = mongoose.model<ISchedule>('Schedule', scheduleSchema);
    RecurringTaskModel = mongoose.model<IRecurringTask>('RecurringTask', recurringTaskSchema);
    BudgetUsageModel = mongoose.model<IBudgetUsage>('BudgetUsage', budgetUsageSchema);
    BudgetUsageRollupModel = mongoose.model<IBudgetUsageRollup>('BudgetUsageRollup', budgetUsageRollupSchema);
    BudgetCapOverrideModel = mongoose.model<IBudgetCapOverride>('BudgetCapOverride', budgetCapOverrideSchema);
    MemberBudgetCapModel = mongoose.model<IMemberBudgetCap>('MemberBudgetCap', memberBudgetCapSchema);
    MrrSnapshotModel = mongoose.model<IMrrSnapshot>('MrrSnapshot', mrrSnapshotSchema);
    UsageEventModel = mongoose.model<IUsageEvent>('UsageEvent', usageEventSchema);
    NotificationModel = mongoose.model<INotification>('Notification', notificationSchema);
    PushSubscriptionModel = mongoose.model<IPushSubscription>('PushSubscription', pushSubscriptionSchema);
    NotificationPrefsModel = mongoose.model<INotificationPrefs>('NotificationPrefs', notificationPrefsSchema);
    RepoCardModel = mongoose.model<IRepoCard>('RepoCard', repoCardSchema);
    RepoModel = mongoose.model<IRepo>('Repo', repoSchema);
    PlanDayModel = mongoose.model<IPlanDay>('PlanDay', planDaySchema);
    TrashEntryModel = mongoose.model<ITrashEntry>('TrashEntry', trashEntrySchema);
    FleetRunModel = mongoose.model<IFleetRun>('FleetRun', fleetRunSchema);
    UserModel = mongoose.model<IUser>('User', userSchema);
    UserSessionModel = mongoose.model<IUserSession>('UserSession', userSessionSchema);
    InviteModel = mongoose.model<IInvite>('Invite', inviteSchema);
    PasswordResetModel = mongoose.model<IPasswordReset>('PasswordReset', passwordResetSchema);
    AccountUnlockModel = mongoose.model<IAccountUnlock>('AccountUnlock', accountUnlockSchema);
    MagicLinkModel = mongoose.model<IMagicLink>('MagicLink', magicLinkSchema);
    EmailVerificationModel = mongoose.model<IEmailVerification>('EmailVerification', emailVerificationSchema);
    EmailDeliveryModel = mongoose.model<IEmailDelivery>('EmailDelivery', emailDeliverySchema);
    EmailSuppressionModel = mongoose.model<IEmailSuppression>('EmailSuppression', emailSuppressionSchema);
    ReviewApprovalModel = mongoose.model<IReviewApproval>('ReviewApproval', reviewApprovalSchema);
    GiftCodeModel = mongoose.model<IGiftCode>('GiftCode', giftCodeSchema);
    GiftRedemptionModel = mongoose.model<IGiftRedemption>('GiftRedemption', giftRedemptionSchema);
    FeedbackModel = mongoose.model<IFeedback>('Feedback', feedbackSchema);
    ReferralCodeModel = mongoose.model<IReferralCode>('ReferralCode', referralCodeSchema);
    ReferralSignupModel = mongoose.model<IReferralSignup>('ReferralSignup', referralSignupSchema);
    ConnectorModel = mongoose.model<IConnector>('Connector', connectorSchema);
    HandoffModel = mongoose.model<IHandoff>('Handoff', handoffSchema);
    ContinuityMetricModel = mongoose.model<IContinuityMetric>('ContinuityMetric', continuityMetricSchema);
    ActivationEventModel = mongoose.model<IActivationEvent>('ActivationEvent', activationEventSchema);
    TenantRequestQuotaModel = mongoose.model<ITenantRequestQuota>('TenantRequestQuota', tenantRequestQuotaSchema);
    WebhookEndpointModel = mongoose.model<IWebhookEndpoint>('WebhookEndpoint', webhookEndpointSchema);
    TenantToolPluginModel = mongoose.model<ITenantToolPlugin>('TenantToolPlugin', tenantToolPluginSchema);
    WebhookDeliveryModel = mongoose.model<IWebhookDelivery>('WebhookDelivery', webhookDeliverySchema);
    InboundWebhookDeliveryModel = mongoose.model<IInboundWebhookDelivery>('InboundWebhookDelivery', inboundWebhookDeliverySchema);
    ArtifactModel = mongoose.model<IArtifact>('Artifact', artifactSchema);
    RunnerJobHistoryModel = mongoose.model<IRunnerJobHistory>('RunnerJobHistory', runnerJobHistorySchema);
    ErasureRequestModel = mongoose.model<IErasureRequest>('ErasureRequest', erasureRequestSchema);
    LegalConsentModel = mongoose.model<ILegalConsent>('LegalConsent', legalConsentSchema);
    FeatureFlagModel = mongoose.model<IFeatureFlag>('FeatureFlag', featureFlagSchema);
    SpendAlertStateModel = mongoose.model<ISpendAlertState>('SpendAlertState', spendAlertStateSchema);
    TenantBudgetGateAlertStateModel = mongoose.model<ITenantBudgetGateAlertState>('TenantBudgetGateAlertState', tenantBudgetGateAlertStateSchema);
    AtlasIndexHealthStateModel = mongoose.model<IAtlasIndexHealthState>('AtlasIndexHealthState', atlasIndexHealthStateSchema);
    MigrationRecordModel = mongoose.model<IMigrationRecord>('MigrationRecord', migrationRecordSchema);

    log.info({ db: config.database.name }, 'MongoDB connected');
    return connection;
  } catch (err) {
    log.error({ err }, 'MongoDB connection failed');
    throw err;
  }
}

// ── Boot-time reachability diagnostics ───────────────────
// The 2026-07-06 incident: a machine-local .env pointed MONGODB_URI at
// localhost:27017 instead of the compose service host `mongo`. connectDB()
// failed at boot, bootstrap() swallowed it as a one-line warning with the
// underlying error discarded, and the gateway ran for ~2 weeks with no
// persistence before anyone noticed. This state lets /health/deep surface
// WHY mongodb is down (not just that it is), even long after the failed
// boot attempt has scrolled out of the logs.

export interface MongoBootFailure {
  message: string;
  uriHost: string;
  at: string;
}

let bootFailure: MongoBootFailure | null = null;

/** Strip credentials from a Mongo URI, keeping only scheme/host/path for safe logging. */
export function redactMongoUri(uri: string): string {
  try {
    const u = new URL(uri);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable-uri>';
  }
}

export function recordMongoBootFailure(err: Error, uri: string): void {
  bootFailure = { message: err.message, uriHost: redactMongoUri(uri), at: new Date().toISOString() };
}

export function getMongoBootFailure(): MongoBootFailure | null {
  return bootFailure;
}

export async function disconnectDB(): Promise<void> {
  if (connection) {
    await mongoose.disconnect();
    connection = null;
    getLogger().info('MongoDB disconnected');
  }
}

export function isConnected(): boolean {
  return mongoose.connection.readyState === 1;
}
