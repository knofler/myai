/**
 * synthetic-canary — scheduled end-to-end control-plane probes for the myAI
 * gateway (task-d9350b1c).
 *
 * Where slo-alerter.ts is REACTIVE (it watches latency/error stats produced by
 * real traffic), this module is PROACTIVE synthetic monitoring: on a cadence it
 * runs one complete synthetic transaction through the critical control-plane
 * paths — the exact code real traffic exercises — and alerts when a stage
 * fails outright or degrades past its latency budget:
 *
 *   1. signup   — user-auth.signup() provisions a fresh (synthetic) tenant +
 *                 owner + session token, then verifyJwt() round-trips the token.
 *   2. dispatch — task-store.createTask() queues a task in that tenant.
 *   3. pickup   — task-store.claimTask() atomically claims it (the same
 *                 gateway↔runner boundary the bash runner's tasks_claim hits).
 *   4. ship     — task-store.updateTask() walks it working→review→done (the
 *                 `ship it` review→done flip).
 *
 * The synthetic tenant is fully isolated (tenant-scoped stores mean no real
 * runner can ever claim a canary task) and self-cleaning: every run ends with
 * account-erasure.purgeTenantData() plus a hard delete of the tenant row —
 * unlike a real GDPR erasure there is nothing to tombstone. A best-effort
 * orphan sweep at the start of each run purges canary tenants a crashed prior
 * run left behind (matched by the reserved @canary.invalid owner-email domain,
 * age-gated so an in-flight concurrent probe is never purged).
 *
 * Alerts go through the notification engine (notifications/event-bus.ts →
 * dashboard bell/toast + durable history), with best-effort Telegram/Slack
 * fan-out via the same channel adapters slo-alerter uses. Flap control:
 *   • a stage FAILURE alerts immediately (critical), then holds a per-stage
 *     cooldown (MYAI_CANARY_COOLDOWN_MIN, default 60m);
 *   • DEGRADED (over latency budget but succeeding) alerts at warning level
 *     only after MYAI_CANARY_DEGRADED_STREAK consecutive degraded runs
 *     (default 2) — one slow run is noise, a streak is a regression;
 *   • recovery emits a single `canary.probe.recovered` info event and clears
 *     the cooldown so the next regression alerts immediately.
 *
 * A gateway running without Mongo skips the probe entirely (DB reachability is
 * health-alerter's job — a canary alerting on an intentionally DB-less boot
 * would be pure noise). State lives in-process — this is a live operational
 * prober, not a store. Disable with SYNTHETIC_CANARY_DISABLED=1; tune cadence
 * with MYAI_CANARY_INTERVAL_MIN and budgets with MYAI_CANARY_BUDGETS_MS
 * (JSON, e.g. {"signup":5000,"dispatch":1500,"pickup":1500,"ship":1500}).
 */
import { randomUUID, randomBytes } from 'node:crypto';
import { createChildLogger } from '../shared/logger.js';
import { getAdapter } from '../channels/registry.js';
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { TenantModel, isConnected, DEFAULT_TENANT_ID } from '../shared/db.js';
import { signup, verifyJwt } from '../core/user-auth.js';
import { createTask, claimTask, updateTask } from '../tasks/task-store.js';
import { purgeTenantData } from '../core/account-erasure.js';

const log = createChildLogger({ module: 'synthetic-canary' });

// ── Constants ─────────────────────────────────────────────────

/** Reserved RFC-2606 domain — marks a tenant as synthetic and undeliverable. */
export const CANARY_EMAIL_DOMAIN = 'canary.invalid';

/** Repo name on canary tasks — reserved, never matches a managed repo. */
export const CANARY_REPO = '__synthetic-canary__';

/** claimedBy stamped on the synthetic pickup. */
const CANARY_CLAIMED_BY = 'synthetic-canary';

/** Orphaned canary tenants younger than this are assumed in-flight and kept. */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/** Max orphans purged per run — bounds sweep cost after a crash storm. */
const ORPHAN_SWEEP_LIMIT = 10;

/** Bounded in-process run history. */
const HISTORY_LIMIT = 20;

export const CANARY_STAGES = ['signup', 'dispatch', 'pickup', 'ship'] as const;
export type CanaryStage = (typeof CANARY_STAGES)[number];

// ── Config (read per run so a restart-free env change takes effect) ──────────

export interface CanaryBudgets {
  signup: number;
  dispatch: number;
  pickup: number;
  ship: number;
}

/** Per-stage latency budgets (ms) at/under which a passing stage is healthy. */
export const DEFAULT_BUDGETS_MS: CanaryBudgets = {
  signup: 5000,
  dispatch: 1500,
  pickup: 1500,
  ship: 1500,
};

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * Parse MYAI_CANARY_BUDGETS_MS, a JSON object keyed by stage. Partial
 * overrides fall back to the default per stage. Never throws.
 */
export function parseCanaryBudgets(raw: string | undefined): CanaryBudgets {
  const out = { ...DEFAULT_BUDGETS_MS };
  if (!raw) return out;
  try {
    const parsed = JSON.parse(raw) as Partial<Record<CanaryStage, number>>;
    for (const stage of CANARY_STAGES) {
      const v = parsed[stage];
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[stage] = v;
    }
    return out;
  } catch (err) {
    log.warn({ err }, 'MYAI_CANARY_BUDGETS_MS is not valid JSON — using default budgets');
    return out;
  }
}

function budgets(): CanaryBudgets {
  return parseCanaryBudgets(process.env.MYAI_CANARY_BUDGETS_MS);
}

function cooldownMs(): number {
  return envNum('MYAI_CANARY_COOLDOWN_MIN', 60) * 60 * 1000;
}

/** Consecutive degraded runs of a stage before a degradation alert fires. */
function degradedStreakThreshold(): number {
  const raw = Number(process.env.MYAI_CANARY_DEGRADED_STREAK);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 2;
}

// ── Result types ──────────────────────────────────────────────

export interface CanaryStageResult {
  stage: CanaryStage;
  ok: boolean;
  /** Upstream stage failed — this one never ran. */
  skipped: boolean;
  durationMs: number;
  budgetMs: number;
  /** Passed, but over its latency budget. */
  degraded: boolean;
  error?: string;
}

export interface CanaryRunResult {
  ranAt: Date;
  runId: string;
  /** False when the gateway has no DB — probe skipped, nothing alerted. */
  dbAvailable: boolean;
  /** Every stage ran and passed. */
  ok: boolean;
  /** At least one stage passed over budget. */
  degraded: boolean;
  stages: CanaryStageResult[];
  totalMs: number;
  cleanup: { attempted: boolean; purged: boolean; error?: string };
  orphansPurged: number;
  alertsSent: number;
}

// ── Alert state (in-process) ──────────────────────────────────

/** key: `${stage}:failed` | `${stage}:degraded` | 'cleanup:failed' → epoch ms alerted. */
const lastAlerted = new Map<string, number>();
const failStreak = new Map<CanaryStage, number>();
const degradedStreak = new Map<CanaryStage, number>();

/** Clear alert/streak state (test isolation helper / manual reset). */
export function clearCanaryAlertState(): void {
  lastAlerted.clear();
  failStreak.clear();
  degradedStreak.clear();
}

// ── Alert dispatch — notification engine + channel fan-out ───────────────────

type CanaryAlertKind = 'failed' | 'degraded' | 'recovered' | 'cleanup_failed';

interface CanaryAlert {
  kind: CanaryAlertKind;
  key: string;
  title: string;
  message: string;
  level: 'info' | 'warning' | 'critical';
  data: Record<string, unknown>;
}

async function dispatchAlert(alert: CanaryAlert): Promise<void> {
  // Dashboard bell/toast + durable history — in-process, always lands.
  emitNotifyEvent({
    type: `canary.probe.${alert.kind}`,
    tenantId: DEFAULT_TENANT_ID,
    title: alert.title,
    message: alert.message,
    level: alert.level,
    source: 'synthetic-canary',
    data: alert.data,
  });
  // Best-effort fleet ops channels — same posture as slo-alerter: Telegram and
  // Slack are independent, one being unset never blocks the other, and a send
  // failure never fails the probe.
  const text = `${alert.title}\n${alert.message}`;
  await sendVia('telegram', process.env.TELEGRAM_DEFAULT_CHAT, text);
  await sendVia('slack', process.env.SLACK_DEFAULT_WEBHOOK, text);
}

async function sendVia(channel: string, chatId: string | undefined, message: string): Promise<boolean> {
  const adapter = getAdapter(channel);
  if (!adapter || !adapter.enabled || !chatId) return false;
  try {
    await adapter.send(chatId, message);
    return true;
  } catch (err) {
    log.error({ channel, err }, 'Failed to send canary alert');
    return false;
  }
}

// ── Probe stages ──────────────────────────────────────────────

interface ProbeContext {
  runId: string;
  tenantId?: string;
  token?: string;
  taskId?: string;
}

async function stageSignup(ctx: ProbeContext): Promise<void> {
  const email = `canary-${ctx.runId}@${CANARY_EMAIL_DOMAIN}`;
  const result = await signup({
    email,
    // Throwaway high-entropy credential — never stored or reused.
    password: randomBytes(24).toString('base64url'),
    tenantName: `Synthetic canary ${ctx.runId} (auto-purged)`,
    acceptTerms: true,
  });
  ctx.tenantId = result.tenantId;
  ctx.token = result.token;
  const payload = verifyJwt(result.token);
  if (payload.tid !== result.tenantId || payload.sub !== result.userId) {
    throw new Error(`token round-trip mismatch: jwt(${payload.tid}/${payload.sub}) vs signup(${result.tenantId}/${result.userId})`);
  }
}

async function stageDispatch(ctx: ProbeContext): Promise<void> {
  if (!ctx.tenantId) throw new Error('no canary tenant from signup stage');
  const task = await createTask(ctx.tenantId, {
    repo: CANARY_REPO,
    title: `Synthetic canary probe ${ctx.runId}`,
    description: 'End-to-end control-plane canary transaction — auto-purged.',
    // P3 keeps the canary off the P0/P1 preemption path.
    priority: 'P3',
  });
  if (task.status !== 'pending') throw new Error(`created task status is '${task.status}', expected 'pending'`);
  ctx.taskId = task.taskId;
}

async function stagePickup(ctx: ProbeContext): Promise<void> {
  if (!ctx.tenantId || !ctx.taskId) throw new Error('no canary task from dispatch stage');
  const claimed = await claimTask(ctx.tenantId, { claimedBy: CANARY_CLAIMED_BY, taskId: ctx.taskId });
  if (!claimed) throw new Error('claimTask returned null — pending canary task was not claimable');
  if (claimed.taskId !== ctx.taskId) throw new Error(`claimed '${claimed.taskId}', expected '${ctx.taskId}'`);
  if (claimed.status !== 'working') throw new Error(`claimed task status is '${claimed.status}', expected 'working'`);
}

async function stageShip(ctx: ProbeContext): Promise<void> {
  if (!ctx.tenantId || !ctx.taskId) throw new Error('no canary task from dispatch stage');
  const review = await updateTask(ctx.tenantId, { taskId: ctx.taskId, status: 'review' });
  if (review?.status !== 'review') throw new Error(`working→review returned '${review?.status ?? 'null'}'`);
  const done = await updateTask(ctx.tenantId, { taskId: ctx.taskId, status: 'done' });
  if (done?.status !== 'done') throw new Error(`review→done returned '${done?.status ?? 'null'}'`);
}

const STAGE_RUNNERS: Record<CanaryStage, (ctx: ProbeContext) => Promise<void>> = {
  signup: stageSignup,
  dispatch: stageDispatch,
  pickup: stagePickup,
  ship: stageShip,
};

// ── Cleanup ───────────────────────────────────────────────────

/**
 * Purge every tenant-scoped record the probe created, then hard-delete the
 * tenant row itself — a synthetic tenant needs no erasure tombstone.
 */
async function cleanupCanaryTenant(tenantId: string): Promise<void> {
  await purgeTenantData(tenantId);
  await TenantModel.deleteOne({ tenantId });
}

/**
 * Purge canary tenants a crashed prior run left behind. Age-gated (older than
 * ORPHAN_MIN_AGE_MS) so a concurrently in-flight probe's tenant is never
 * ripped out from under it. Best-effort — failures are logged, never thrown.
 */
async function sweepOrphanCanaryTenants(now: number): Promise<number> {
  let purged = 0;
  try {
    const cutoff = new Date(now - ORPHAN_MIN_AGE_MS);
    const orphans = (await TenantModel.find({
      ownerEmail: { $regex: `@${CANARY_EMAIL_DOMAIN.replace(/\./g, '\\.')}$` },
      createdAt: { $lt: cutoff },
    })
      .limit(ORPHAN_SWEEP_LIMIT)
      .lean()) as Array<{ tenantId: string }>;
    for (const orphan of orphans) {
      try {
        await cleanupCanaryTenant(orphan.tenantId);
        purged++;
        log.warn({ tenantId: orphan.tenantId }, 'Purged orphaned canary tenant from a prior crashed run');
      } catch (err) {
        log.error({ err, tenantId: orphan.tenantId }, 'Failed to purge orphaned canary tenant');
      }
    }
  } catch (err) {
    log.error({ err }, 'Orphan canary sweep failed');
  }
  return purged;
}

// ── Main probe runner ─────────────────────────────────────────

let runInFlight = false;
let latestResult: CanaryRunResult | null = null;
const history: CanaryRunResult[] = [];

/**
 * Run one synthetic end-to-end transaction (signup → dispatch → pickup → ship),
 * clean up the synthetic tenant, evaluate regressions against streaks/cooldowns
 * and alert through the notification engine. Never throws. Returns null when a
 * previous probe is still in flight (re-entrancy guard).
 *
 * @param now injectable clock (epoch ms) for deterministic cooldown tests —
 *            stage durations always use the real clock (they measure real work).
 */
export async function runCanaryProbe(now: number = Date.now()): Promise<CanaryRunResult | null> {
  if (runInFlight) {
    log.warn('Canary probe already in flight — skipping this run');
    return null;
  }
  runInFlight = true;
  try {
    return await runCanaryProbeInner(now);
  } finally {
    runInFlight = false;
  }
}

async function runCanaryProbeInner(now: number): Promise<CanaryRunResult> {
  const runId = randomUUID().replace(/-/g, '').slice(0, 12);
  const budget = budgets();
  const result: CanaryRunResult = {
    ranAt: new Date(now),
    runId,
    dbAvailable: isConnected(),
    ok: false,
    degraded: false,
    stages: [],
    totalMs: 0,
    cleanup: { attempted: false, purged: false },
    orphansPurged: 0,
    alertsSent: 0,
  };

  // No DB → nothing to probe and nothing to alert: health-alerter owns DB
  // reachability, and an intentionally DB-less gateway must not page anyone.
  if (!result.dbAvailable) {
    log.debug('DB not connected — canary probe skipped');
    recordResult(result);
    return result;
  }

  result.orphansPurged = await sweepOrphanCanaryTenants(now);

  const ctx: ProbeContext = { runId };
  const startedAt = Date.now();
  let upstreamFailed = false;

  for (const stage of CANARY_STAGES) {
    if (upstreamFailed) {
      result.stages.push({ stage, ok: false, skipped: true, durationMs: 0, budgetMs: budget[stage], degraded: false });
      continue;
    }
    const stageStart = Date.now();
    try {
      await STAGE_RUNNERS[stage](ctx);
      const durationMs = Date.now() - stageStart;
      result.stages.push({
        stage,
        ok: true,
        skipped: false,
        durationMs,
        budgetMs: budget[stage],
        degraded: durationMs > budget[stage],
      });
    } catch (err) {
      upstreamFailed = true;
      result.stages.push({
        stage,
        ok: false,
        skipped: false,
        durationMs: Date.now() - stageStart,
        budgetMs: budget[stage],
        degraded: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  result.totalMs = Date.now() - startedAt;
  result.ok = result.stages.every(s => s.ok);
  result.degraded = result.stages.some(s => s.degraded);

  // Cleanup runs even after a stage failure — a half-built canary tenant must
  // never linger (the orphan sweep is the backstop, not the plan).
  if (ctx.tenantId) {
    result.cleanup.attempted = true;
    try {
      await cleanupCanaryTenant(ctx.tenantId);
      result.cleanup.purged = true;
    } catch (err) {
      result.cleanup.error = err instanceof Error ? err.message : String(err);
      log.error({ err, tenantId: ctx.tenantId }, 'Canary tenant cleanup failed');
    }
  }

  result.alertsSent = await evaluateAndAlert(result, now);
  recordResult(result);
  if (!result.ok) {
    log.warn({ runId, stages: result.stages.filter(s => !s.ok && !s.skipped).map(s => s.stage) }, 'Canary probe failed');
  }
  return result;
}

function recordResult(result: CanaryRunResult): void {
  latestResult = result;
  history.push(result);
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}

// ── Regression evaluation ─────────────────────────────────────

async function evaluateAndAlert(result: CanaryRunResult, now: number): Promise<number> {
  let sent = 0;
  const breachedKeys = new Set<string>();
  const timestamp = result.ranAt.toISOString().replace('T', ' ').slice(0, 19);

  for (const s of result.stages) {
    if (s.skipped) continue;

    if (!s.ok) {
      const streak = (failStreak.get(s.stage) ?? 0) + 1;
      failStreak.set(s.stage, streak);
      degradedStreak.set(s.stage, 0);
      // A failure supersedes any live degradation alert for the same stage —
      // drop it silently so the recovery pass below can't claim "degraded
      // recovered" on a stage that is now failing outright.
      lastAlerted.delete(`${s.stage}:degraded`);
      const key = `${s.stage}:failed`;
      breachedKeys.add(key);
      if (underCooldown(key, now)) continue;
      await dispatchAlert({
        kind: 'failed',
        key,
        title: `\u{1F6A8} Canary probe FAILED — ${s.stage}`,
        message: [
          `Synthetic ${s.stage} transaction failed (${streak} consecutive).`,
          `Error: ${s.error ?? 'unknown'}`,
          `After ${s.durationMs}ms. Detected at ${timestamp} UTC.`,
        ].join('\n'),
        level: 'critical',
        data: { stage: s.stage, runId: result.runId, durationMs: s.durationMs, error: s.error, consecutiveFailures: streak },
      });
      lastAlerted.set(key, now);
      sent++;
      continue;
    }

    failStreak.set(s.stage, 0);
    if (s.degraded) {
      const streak = (degradedStreak.get(s.stage) ?? 0) + 1;
      degradedStreak.set(s.stage, streak);
      const key = `${s.stage}:degraded`;
      // Below the streak threshold this is noise, not a regression — but an
      // already-alerted degradation stays "breached" so it doesn't flap
      // recovered/degraded while consistently slow.
      if (streak >= degradedStreakThreshold() || lastAlerted.has(key)) breachedKeys.add(key);
      if (streak < degradedStreakThreshold() || underCooldown(key, now)) continue;
      await dispatchAlert({
        kind: 'degraded',
        key,
        title: `\u{26A0}\u{FE0F} Canary probe degraded — ${s.stage}`,
        message: [
          `Synthetic ${s.stage} passed but took ${s.durationMs}ms (budget ${s.budgetMs}ms), ${streak} runs in a row.`,
          `Detected at ${timestamp} UTC.`,
        ].join('\n'),
        level: 'warning',
        data: { stage: s.stage, runId: result.runId, durationMs: s.durationMs, budgetMs: s.budgetMs, consecutiveDegraded: streak },
      });
      lastAlerted.set(key, now);
      sent++;
    } else {
      degradedStreak.set(s.stage, 0);
    }
  }

  // Cleanup failure is its own (warning) signal: the probe may be green while
  // synthetic tenants pile up.
  if (result.cleanup.attempted && !result.cleanup.purged) {
    const key = 'cleanup:failed';
    breachedKeys.add(key);
    if (!underCooldown(key, now)) {
      await dispatchAlert({
        kind: 'cleanup_failed',
        key,
        title: '\u{26A0}\u{FE0F} Canary cleanup failed',
        message: `Synthetic canary tenant purge failed: ${result.cleanup.error ?? 'unknown'} — the hourly orphan sweep will retry.`,
        level: 'warning',
        data: { runId: result.runId, error: result.cleanup.error },
      });
      lastAlerted.set(key, now);
      sent++;
    }
  }

  // Recovery: anything previously alerted that is no longer breaching emits a
  // single recovered event and clears its cooldown, so the next regression
  // alerts immediately. Skipped stages keep their breach keys alive above via
  // the upstream failure still breaching — a skipped stage is unknown, and
  // must not read as recovered.
  const skippedStages = new Set(result.stages.filter(s => s.skipped).map(s => s.stage));
  for (const key of [...lastAlerted.keys()]) {
    if (breachedKeys.has(key)) continue;
    const stage = key.split(':')[0];
    if (skippedStages.has(stage as CanaryStage)) continue;
    lastAlerted.delete(key);
    await dispatchAlert({
      kind: 'recovered',
      key,
      title: `\u{2705} Canary recovered — ${key.replace(':', ' ')}`,
      message: `Synthetic probe '${key}' is back within budget as of ${timestamp} UTC.`,
      level: 'info',
      data: { key, runId: result.runId },
    });
    sent++;
  }

  return sent;
}

function underCooldown(key: string, now: number): boolean {
  const prev = lastAlerted.get(key);
  return prev !== undefined && now - prev < cooldownMs();
}

// ── Lifecycle ─────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;

/** Default cadence: 30 minutes — each run writes (and purges) a synthetic tenant. */
const DEFAULT_INTERVAL_MINUTES = 30;

export function startSyntheticCanary(
  intervalMinutes: number = envNum('MYAI_CANARY_INTERVAL_MIN', DEFAULT_INTERVAL_MINUTES),
): void {
  if (intervalId) {
    log.warn('Synthetic canary already running');
    return;
  }
  log.info(
    { intervalMinutes, budgetsMs: budgets(), degradedStreak: degradedStreakThreshold() },
    'Starting synthetic canary probes',
  );
  // Interval-only (no boot-time run): probing mid-boot races index builds and
  // channel registration, and a restart storm must not become a signup storm.
  intervalId = setInterval(() => {
    runCanaryProbe().catch(err => log.error({ err }, 'Scheduled canary probe failed'));
  }, intervalMinutes * 60 * 1000);
}

export function stopSyntheticCanary(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Synthetic canary stopped');
  }
}

export function isSyntheticCanaryRunning(): boolean {
  return intervalId !== null;
}

export function getLatestCanaryResult(): CanaryRunResult | null {
  return latestResult;
}

export function getCanaryHistory(): CanaryRunResult[] {
  return [...history];
}

/** Current canary configuration + state for status queries (canary_status tool). */
export function getSyntheticCanaryStatus(): {
  active: boolean;
  intervalMinutes: number;
  budgetsMs: CanaryBudgets;
  cooldownMinutes: number;
  degradedStreakThreshold: number;
  lastRun: Date | null;
  lastRunOk: boolean | null;
  lastRunDegraded: boolean | null;
  trackedCooldowns: number;
  historyLength: number;
} {
  return {
    active: intervalId !== null,
    intervalMinutes: envNum('MYAI_CANARY_INTERVAL_MIN', DEFAULT_INTERVAL_MINUTES),
    budgetsMs: budgets(),
    cooldownMinutes: envNum('MYAI_CANARY_COOLDOWN_MIN', 60),
    degradedStreakThreshold: degradedStreakThreshold(),
    lastRun: latestResult?.ranAt ?? null,
    lastRunOk: latestResult?.ok ?? null,
    lastRunDegraded: latestResult?.degraded ?? null,
    trackedCooldowns: lastAlerted.size,
    historyLength: history.length,
  };
}

/** Reset run history + latest result (test isolation helper). */
export function clearCanaryHistory(): void {
  latestResult = null;
  history.length = 0;
}
