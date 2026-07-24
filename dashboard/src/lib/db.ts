import mongoose from 'mongoose';

const MONGODB_URI = process.env.MONGODB_URI ?? 'mongodb://mongo:27017/myai';

let cached = (global as Record<string, unknown>).__mongooseCache as {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose> | null;
} | undefined;

if (!cached) {
  cached = { conn: null, promise: null };
  (global as Record<string, unknown>).__mongooseCache = cached;
}

export async function connectDB(): Promise<typeof mongoose> {
  if (cached!.conn && mongoose.connection.readyState === 1) return cached!.conn;
  if (cached!.conn && mongoose.connection.readyState === 0) {
    cached!.conn = null;
    cached!.promise = null;
  }

  if (!cached!.promise) {
    cached!.promise = mongoose.connect(MONGODB_URI, {
      dbName: 'myai',
      serverSelectionTimeoutMS: 5000,
      bufferCommands: false,
      // Atlas M0 free tier caps total connections at 500. The driver default
      // pool is 100 per process — with gateway + dashboard + mcp across repos
      // that exhausts the cluster. Cap tight and reap idle connections.
      maxPoolSize: 5,
      maxIdleTimeMS: 30000,
    });
  }

  cached!.conn = await cached!.promise;
  return cached!.conn;
}

// ── Schemas (read-only mirrors of gateway schemas) ─────

const agentSchema = new mongoose.Schema({
  name: String,
  description: String,
  tools: [String],
  category: String,
  instructions: String,
  filePath: String,
  contentHash: String,
  loadedAt: Date,
}, { collection: 'agents' });

const skillSchema = new mongoose.Schema({
  name: String,
  description: String,
  triggers: [String],
  playbook: String,
  filePath: String,
  contentHash: String,
  loadedAt: Date,
}, { collection: 'skills' });

const hookSchema = new mongoose.Schema({
  name: String,
  events: [String],
  priority: Number,
  timeout: Number,
  enabled: Boolean,
  source: String,
  loadedAt: Date,
}, { collection: 'hooks' });

const ruleSchema = new mongoose.Schema({
  name: String,
  description: String,
  category: String,
  content: String,
  filePath: String,
  contentHash: String,
  loadedAt: Date,
}, { collection: 'rules' });

const patternSchema = new mongoose.Schema({
  patternId: String,
  title: String,
  description: String,
  tags: [String],
  category: String,
  confidence: Number,
  usageCount: Number,
  successCount: Number,
  failureCount: Number,
  lastUsed: Date,
  createdAt: Date,
}, { collection: 'aipatterns' });

const sessionSchema = new mongoose.Schema({
  sessionId: String,
  agentName: String,
  status: String,
  messages: [{
    id: String,
    role: String,
    content: String,
    agentName: String,
    timestamp: Date,
  }],
  workspace: String,
  compactionCount: Number,
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: Date,
  updatedAt: Date,
  closedAt: Date,
}, { collection: 'gatewaysessions' });

const budgetUsageSchema = new mongoose.Schema({
  tenantId: String,   // ADR-010 — tenant discriminator (absent on pre-backfill rows)
  callId: String,
  channelId: String,
  channelType: String,
  agentName: String,
  userId: String,     // M2 Team tier — tenant member attribution (absent on system/agent traffic)
  provider: String,
  model: String,
  inputTokens: Number,
  outputTokens: Number,
  costUsd: Number,
  toolIterations: Number,
  cappedToolUses: Boolean,
  // Phase 5d — Anthropic prompt caching token counts.
  cacheCreationInputTokens: Number,
  cacheReadInputTokens: Number,
  // Phase 5f — true when this call was dispatched via Message Batches API (50% discount).
  batchMode: Boolean,
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: Date,
}, { collection: 'budgetusages', timestamps: true });

// ADR-014 S2 — product-usage meter (read-only mirror of the gateway's
// usageEventSchema in runtime/src/shared/db.ts). The SECOND meter alongside
// BudgetUsage: BudgetUsage meters the *resource* (tokens/$), UsageEvent meters
// the *product* (billable business units — tasks executed, off-hours minutes,
// apps generated, agents invoked). The gateway is the only writer (fire-and-
// forget from chokepoints); the dashboard's /system → Usage tab reads it.
const usageEventSchema = new mongoose.Schema({
  tenantId: String,   // ADR-010 — tenant discriminator
  eventId: String,    // unique idempotency key
  type: String,       // task.executed | offhours.minutes | app.generated | ticket.bridged | agent.invoked | schedule.dispatched
  quantity: Number,   // default 1; minutes for offhours.minutes
  unit: String,       // 'count' | 'minutes'
  repo: String,
  taskId: String,
  userId: String,     // human principal (tenant member) when known
  source: String,     // 'runner' | 'gateway' | 'scheduler' | 'connect' | 'dashboard'
  occurredAt: Date,   // event time (±24h clamped at insert)
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: Date,    // ingest time (server-side)
}, { collection: 'usageevents' });

// M2 Team tier — read-only mirror of the gateway's User schema. Dashboard auth
// itself lives at the gateway; this mirror only resolves userId → display
// name/email for per-member views (e.g. /budgets breakdown). passwordHash is
// deliberately not declared here so it can never be selected.
const userSchema = new mongoose.Schema({
  userId: String,
  tenantId: String,
  email: String,
  displayName: String,
  role: String,
  lastLoginAt: Date,
  createdAt: Date,
}, { collection: 'users' });

// Phase B6 — RAG corpus vector store (read-only mirror of gateway's Vector schema).
// NOTE: Never select `embedding` — it's a 384-dim float array, too large for the dashboard.
const vectorSchema = new mongoose.Schema({
  repo: String,
  source: String,        // 'state' | 'handoff' | 'commit' | 'pr' | 'pattern' | 'bug' | 'code' | 'feature' | 'archive'
  content: String,
  embedding: [Number],   // 384-dim — excluded from queries via .select('-embedding')
  tags: [String],
  sessionId: String,
  metadata: mongoose.Schema.Types.Mixed,
  contentHash: String,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'vectors' });

const taskSchema = new mongoose.Schema({
  tenantId: String,   // ADR-010 — tenant discriminator (absent on pre-backfill rows)
  taskId: String,
  repo: String,
  title: String,
  description: String,
  priority: { type: String, enum: ['P0', 'P1', 'P2', 'P3'] },
  status: { type: String, enum: ['pending', 'working', 'review', 'done', 'blocked', 'paused', 'dead_letter'] },
  assignedAgent: String,
  recommendedModel: String,
  source: { type: String, enum: ['manual', 'connect-hub', 'auto-detected', 'scheduler', 'telegram'] },
  sourceId: String,
  prUrl: String,
  notes: String,
  telegramMessageId: Number,
  startedAt: Date,
  completedAt: Date,
  // Bounded retry-with-backoff / dead-letter (runner failure path) — read-only
  // mirror of runtime/src/shared/db.ts ITask; the gateway (task-store.failTask)
  // is the only writer.
  retryCount: Number,
  maxRetries: Number,
  nextRetryAt: Date,
  deadLetteredAt: Date,
  lastError: String,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'tasks' });

// Runner liveness pulses — read-only mirror of the gateway's
// runnerHeartbeatSchema (runtime/src/shared/db.ts). One doc per machine per
// tenant, upserted on every runner fire via the runner_heartbeat MCP tool
// (scripts/cli_task_runner.sh). Distinct from runner-lease docs (only exist
// while a slot is held mid-session) — this tracks "the runner process fired",
// independent of whether it claimed any work.
const runnerHeartbeatSchema = new mongoose.Schema({
  tenantId: String,
  machine: String,
  holder: String,
  lastHeartbeatAt: Date,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'runner_heartbeats' });

// Fleet-wide task-claim kill switch — read-only mirror of the gateway's
// fleetMaintenanceSchema (runtime/src/shared/db.ts). One doc per tenant,
// flipped via the fleet_maintenance_enter / fleet_maintenance_exit MCP tools
// (runtime/src/tasks/fleet-maintenance-store.ts). Read here to render the
// maintenance banner — the gateway process and this dashboard process are
// separate, so the banner can't rely on the gateway's in-memory state.
const fleetMaintenanceSchema = new mongoose.Schema({
  tenantId: String,
  active: Boolean,
  reason: String,
  operator: String,
  enteredAt: Date,
  resumeAt: Date,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'fleet_maintenance' });

// Per-task reviewable artifacts (git diff / build-test output / reports) —
// read-only mirror of the gateway's artifactSchema (runtime/src/shared/db.ts).
// The gateway (via MCP tool artifacts_register, called by the runner) is the
// only writer; this route only reads metadata + decodes `content` for download.
const artifactSchema = new mongoose.Schema({
  tenantId: String,
  artifactId: String,
  taskId: String,
  repo: String,
  kind: { type: String, enum: ['diff', 'build-log', 'test-report', 'other'] },
  filename: String,
  contentType: String,
  sizeBytes: Number,
  encoding: { type: String, enum: ['utf8', 'gzip+base64'] },
  content: String,
  truncated: Boolean,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'artifacts' });

// Field names mirror the gateway's ISchedule (runtime/src/shared/db.ts) —
// cronExpr/lastStatus, NOT cron/lastRunStatus.
const scheduleSchema = new mongoose.Schema({
  tenantId: String,   // ADR-010 — tenant discriminator (absent on pre-backfill rows)
  scheduleId: String,
  name: String,
  cronExpr: String,
  kind: { type: String, enum: ['agent', 'skill', 'tool'] },
  target: String,
  message: String,
  repo: String,
  includeMemoryContext: Boolean,
  enabled: Boolean,
  lastRun: Date,
  lastStatus: { type: String, enum: ['never', 'success', 'error'] },
  lastError: String,
  lastResultSummary: String,
  runCount: Number,
  errorCount: Number,
  nextRun: Date,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'schedules' });

const repoCardSchema = new mongoose.Schema({
  tenantId: String,   // ADR-010 — tenant discriminator (absent on pre-backfill rows)
  repoName: String,
  description: String,
  group: String,
  localhostUrl: String,
  appUrl: String,
  apiUrl: String,
  mongo: String,
  vercelUrl: String,
  dnsUrl: String,
  lastStatus: String,
  lastStatusLevel: { type: String, enum: ['ok', 'warn', 'error', 'unknown'] },
  reportedBy: String,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'repocards' });

// Fleet Morning Console — read-only mirror of the gateway's FleetRun schema.
// One document per fleet sweep; `repos[]` updates live as the run progresses.
const fleetRunRepoSchema = new mongoose.Schema({
  repo: String,
  group: String,
  overnight: String,
  recommendation: String,   // 'ship' | 'review' | 'merge' | 'fix' | 'wrap-up' | 'idle' | 'attention'
  branch: String,
  ahead: Number,            // test ahead of main
  uncommitted: Number,
  openPrs: Number,
  reviewTasks: Number,
  blockedTasks: Number,
  decision: String,
  action: String,           // 'ship'|'fix'|'merge'|'test'|'wrap-up'|'skip' or ''
  actionStatus: String,     // 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped'
  detail: String,
  prUrl: String,
  updatedAt: Date,
}, { _id: false });

const fleetRunSchema = new mongoose.Schema({
  tenantId: String,
  runId: String,            // unique id like 'fleet-20260616-0830'
  type: String,             // e.g. 'morning-resume-all'
  status: String,           // 'running' | 'completed' | 'aborted'
  machine: String,
  agent: String,
  startedAt: Date,
  finishedAt: Date,
  repos: [fleetRunRepoSchema],
  summary: mongoose.Schema.Types.Mixed,  // { total, needsAction, shipped, failed }
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'fleetruns', timestamps: true });

// ADR-010 multi-tenancy — mirror of the gateway's `tenantSchema`
// (runtime/src/shared/db.ts). `apiKeyHash` is `select:false` exactly like the
// gateway so it is never returned by an accidental `.find()`; login must
// `.select('+apiKeyHash')` to validate. The dashboard signup/login routes are
// the only writers; everything else reads `tenantId`/`name`/`plan`/`status`.
const tenantSchema = new mongoose.Schema({
  tenantId: { type: String, required: true, unique: true, index: true },
  name: { type: String, required: true },
  apiKeyHash: { type: String, required: true, select: false },
  apiKeyPrefix: { type: String, required: true, unique: true, index: true },
  plan: { type: String, enum: ['free', 'solo', 'team', 'scale'], default: 'free', index: true },
  status: { type: String, enum: ['active', 'suspended', 'deleted'], default: 'active', index: true },
  ownerEmail: String,
  // M5 / §7.2 Day 7 — Stripe billing link + subscription state. The billing
  // webhook (api/billing/webhook) is the only writer; the gate reads them.
  stripeCustomerId: String,
  stripeSubscriptionId: String,
  subscriptionStatus: {
    type: String,
    enum: ['none', 'trialing', 'active', 'past_due', 'canceled', 'incomplete'],
    default: 'none',
    index: true,
  },
  currentPeriodEnd: Date,
  // Dunning / failed-payment recovery. The billing webhook increments
  // `paymentFailureCount` on each Stripe invoice.payment_failed and resets it to
  // 0 on recovery; `lastPaymentFailedAt` timestamps the most recent failure.
  paymentFailureCount: { type: Number, default: 0 },
  lastPaymentFailedAt: Date,
  // Active billing cadence ('month'|'year') + applied discount summary, set by
  // the billing webhook so the billing UI can reflect the interval/coupon.
  billingInterval: { type: String, enum: ['month', 'year'], default: 'month' },
  discount: mongoose.Schema.Types.Mixed,
  // GROWTH — gift/redeemable-code credit grants (gateway's core/gift-codes.ts
  // is the writer); mirrored here read-only so the billing UI can show it.
  creditBalance: { type: Number, default: 0 },
  metadata: mongoose.Schema.Types.Mixed,
}, { collection: 'tenants', timestamps: true });

const planDaySchema = new mongoose.Schema({
  tenantId: String,   // ADR-010 — tenant discriminator (absent on pre-backfill rows)
  repo: String,
  day: Number,
  fireAt: Date,
  focus: String,
  status: { type: String, enum: ['enabled', 'disabled', 'done', 'blocked'] },
  notes: String,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'plandays' });

// Bundled MCP connector set — read mirror of the gateway's connectorSchema
// (runtime/src/shared/db.ts). Holds per-tenant enabled/disabled state of the
// curated bundle + any custom connectors. The dashboard reads these; writes go
// through the gateway MCP tools (connectors_set/toggle/remove) via /api/connectors.
const connectorSchema = new mongoose.Schema({
  tenantId: String,
  key: String,
  label: String,
  category: String,
  transport: { type: String, enum: ['http', 'stdio'] },
  description: String,
  url: String,
  command: String,
  args: [String],
  env: mongoose.Schema.Types.Mixed,
  requiresEnv: [String],
  enabled: Boolean,
  source: { type: String, enum: ['bundled', 'custom'] },
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'connectors' });

// Continuity meter — read mirror of the gateway's continuityMetricSchema
// (runtime/src/shared/db.ts). One row per context block served by
// context_boot / brain_delta / memory_context; `tokens` is the estimated
// cold-start re-teaching cost the operator avoided, `baselineTokens` the
// measured legacy file-read boot cost at serve time (B7 today-vs-brain).
// Written by the gateway only.
const continuityMetricSchema = new mongoose.Schema({
  tenantId: String,
  repo: String,
  tool: { type: String, enum: ['context_boot', 'memory_context', 'brain_delta'] },
  tokens: Number,
  baselineTokens: Number,
  userId: String,      // M2 Team tier — tenant member the boot was served to (per-user savings view + share card)
  sessionId: String,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'continuitymetrics' });

// Activation funnel — read mirror of the gateway's activationEventSchema
// (runtime/src/shared/db.ts). One row per (tenant, step) the first time a
// tenant reaches an onboarding milestone (signup → init → first_brain_boot →
// first_brain_delta → wrapup_merge). 'first_task'/'first_ship' are additional
// steps stamped solely to drive the lifecycle email sequence (see the
// ActivationStep doc comment in runtime/src/shared/db.ts) — 'first_ship'
// (first task shipped) also doubles as the "first value" step of the
// self-serve conversion funnel below. Written by the gateway only. Privacy-
// respecting product analytics: no third-party tracker, tenant-scoped.
const activationEventSchema = new mongoose.Schema({
  tenantId: String,
  step: { type: String, enum: ['signup', 'init', 'first_brain_boot', 'first_brain_delta', 'wrapup_merge', 'first_task', 'first_ship'] },
  repo: String,
  source: { type: String, enum: ['gateway', 'signup', 'runner', 'dashboard'] },
  occurredAt: Date,
  metadata: mongoose.Schema.Types.Mixed,
  createdAt: Date,
  updatedAt: Date,
}, { collection: 'activationevents' });

// Per-tenant cost-aware routing policy (Phase 3 control-plane). Unlike most
// schemas here this one is WRITTEN by the dashboard (via /api/routing-policy),
// scoped to the active tenant — one policy document per tenant. The gateway
// router reads it to pick the model per task priority and enforce the monthly
// budget cap's soft/hard limits. See src/lib/routing-policy.ts for the shape.
const routingPolicySchema = new mongoose.Schema({
  tenantId: { type: String, required: true, unique: true, index: true },
  enabled: { type: Boolean, default: false },
  defaultModel: String,
  priorityOverrides: mongoose.Schema.Types.Mixed,  // Partial<Record<Priority, modelId>>
  monthlyBudgetUsd: Number,
  softLimitPct: Number,
  hardLimitPct: Number,
  updatedAt: Date,
}, { collection: 'routingpolicies' });

export const RoutingPolicy = mongoose.models.RoutingPolicy || mongoose.model('RoutingPolicy', routingPolicySchema);
export const ContinuityMetric = mongoose.models.ContinuityMetric || mongoose.model('ContinuityMetric', continuityMetricSchema);
export const ActivationEvent = mongoose.models.ActivationEvent || mongoose.model('ActivationEvent', activationEventSchema);
export const Connector = mongoose.models.Connector || mongoose.model('Connector', connectorSchema);
export const Tenant = mongoose.models.Tenant || mongoose.model('Tenant', tenantSchema);
export const FleetRun = mongoose.models.FleetRun || mongoose.model('FleetRun', fleetRunSchema);
export const PlanDay = mongoose.models.PlanDay || mongoose.model('PlanDay', planDaySchema);
export const RepoCard = mongoose.models.RepoCard || mongoose.model('RepoCard', repoCardSchema);
export const Agent = mongoose.models.Agent || mongoose.model('Agent', agentSchema);
export const Skill = mongoose.models.Skill || mongoose.model('Skill', skillSchema);
export const Hook = mongoose.models.Hook || mongoose.model('Hook', hookSchema);
export const Rule = mongoose.models.Rule || mongoose.model('Rule', ruleSchema);
export const Pattern = mongoose.models.Pattern || mongoose.model('Pattern', patternSchema);
export const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
export const BudgetUsage = mongoose.models.BudgetUsage || mongoose.model('BudgetUsage', budgetUsageSchema);
export const UsageEvent = mongoose.models.UsageEvent || mongoose.model('UsageEvent', usageEventSchema);
export const User = mongoose.models.User || mongoose.model('User', userSchema);
export const Vector = mongoose.models.Vector || mongoose.model('Vector', vectorSchema);
export const Task = mongoose.models.Task || mongoose.model('Task', taskSchema);
export const RunnerHeartbeat = mongoose.models.RunnerHeartbeat || mongoose.model('RunnerHeartbeat', runnerHeartbeatSchema);
export const FleetMaintenance = mongoose.models.FleetMaintenance || mongoose.model('FleetMaintenance', fleetMaintenanceSchema);
export const Schedule = mongoose.models.Schedule || mongoose.model('Schedule', scheduleSchema);
export const Artifact = mongoose.models.Artifact || mongoose.model('Artifact', artifactSchema);
