/**
 * repo-runner-staleness-alerter — per-repo runner-log staleness alert
 * (task-aa7c285d).
 *
 * Distinct from runner-heartbeat-store.ts's FLEET-WIDE "is the off-hours
 * runner process alive at all" check (health-alerter.ts's
 * checkRunnerLiveness): that alert only fires once NO machine anywhere has
 * heartbeated within the liveness threshold. A runner can be perfectly
 * alive — heartbeating, picking up other repos' tasks — while one SPECIFIC
 * repo's queue sits untouched (excluded by --repo scoping on every fire,
 * silently erroring on that one repo, etc). agentFlow's runner sat stalled
 * 2026-06-25 -> 2026-07-07 with pending queue work and this was only ever
 * caught by a human noticing during a manual session review — no proactive
 * signal existed for a single repo going quiet while the fleet overall
 * looked fine.
 *
 * This module closes that gap: for every repo with pending queue work, it
 * compares job-history-store's most recent run for that repo (the durable,
 * searchable index over the raw ~/.ai-cli-runner/logs — see
 * tasks/job-history-store.ts) against a staleness threshold and fires once
 * the gap exceeds it.
 *
 * A repo with pending tasks but NO job-history entry at all is deliberately
 * NOT flagged — that is "never run yet" (a brand-new repo, or one whose
 * first task was just queued), not "the log stopped advancing". This check
 * is specifically about a log that WAS advancing and then went quiet.
 *
 * Same in-process-state shape as queue-wait-alerter.ts: a pure evaluate
 * function for unit testing without I/O, a per-repo cooldown map for flap
 * suppression, Telegram dispatch. State lives in-process — a live
 * operational alerter, not a persisted store.
 */
import { TaskModel, RunnerJobHistoryModel, isConnected, DEFAULT_TENANT_ID } from '../shared/db.js';
import type { ITask, IRunnerJobHistory } from '../shared/db.js';
import { scopedFind } from '../shared/scoped-query.js';
import { createChildLogger } from '../shared/logger.js';
import { getAdapter } from '../channels/registry.js';

const log = createChildLogger({ module: 'repo-runner-staleness-alerter' });

function envHours(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** How long (no new job-history entry) before a repo's queue counts as stalled. */
export function stalenessThresholdHours(): number {
  return envHours('REPO_RUNNER_STALENESS_THRESHOLD_HOURS', 48);
}

/** Re-alert cooldown for a repo still stalled (hours) — avoids re-paging every tick. */
function cooldownHours(): number {
  return envHours('REPO_RUNNER_STALENESS_COOLDOWN_HOURS', 12);
}

// ── Breach evaluation (pure) ─────────────────────────────────────

export interface RepoQueueSnapshot {
  repo: string;
  pendingCount: number;
  /** Most recent job-history startedAt for this repo, or null if none ever recorded. */
  lastActivityAt: Date | null;
}

export interface RepoStalenessBreach {
  repo: string;
  pendingCount: number;
  lastActivityAt: Date;
  hoursSinceActivity: number;
}

/**
 * Decide which repos are "stalled": pending work queued, a runner log DID
 * exist for the repo, but it hasn't advanced within the threshold. Pure —
 * no I/O — so the decision is unit-testable without a database.
 */
export function evaluateRepoStaleness(
  snapshots: readonly RepoQueueSnapshot[],
  now: number,
  thresholdHours: number = stalenessThresholdHours(),
): RepoStalenessBreach[] {
  const breaches: RepoStalenessBreach[] = [];
  for (const s of snapshots) {
    if (s.pendingCount <= 0) continue;
    if (!s.lastActivityAt) continue; // never run — not "stalled", just new
    const hoursSinceActivity = (now - s.lastActivityAt.getTime()) / 3_600_000;
    if (hoursSinceActivity >= thresholdHours) {
      breaches.push({
        repo: s.repo,
        pendingCount: s.pendingCount,
        lastActivityAt: s.lastActivityAt,
        hoursSinceActivity: Math.round(hoursSinceActivity),
      });
    }
  }
  return breaches;
}

// ── Cooldown / flap suppression ───────────────────────────────────

const lastAlerted = new Map<string, number>(); // key: repo → epoch ms

/** Clear cooldown state (test helper / manual reset). */
export function clearRepoStalenessCooldowns(): void {
  lastAlerted.clear();
}

function cooldownMs(): number {
  return cooldownHours() * 60 * 60 * 1000;
}

// ── Alert dispatch ────────────────────────────────────────────────

function formatBreachMessage(b: RepoStalenessBreach, thresholdHours: number): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return [
    `\u{1F6A8} Runner Log Stalled — [${b.repo}]`,
    `${b.pendingCount} pending task(s) queued, but this repo's runner log hasn't advanced in ${b.hoursSinceActivity}h (threshold ${thresholdHours}h)`,
    `Last activity: ${b.lastActivityAt.toISOString()}`,
    '',
    'The fleet runner may be alive and heartbeating elsewhere while this one repo goes untouched — ' +
      'check --repo scoping, the consent list, and recent errors for this repo specifically.',
    `Detected at ${timestamp} UTC`,
  ].join('\n');
}

async function sendBreachAlert(b: RepoStalenessBreach, thresholdHours: number): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) {
    log.debug({ repo: b.repo }, 'No enabled Telegram adapter — repo-runner-staleness alert not sent');
    return false;
  }

  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) {
    log.debug({ repo: b.repo }, 'TELEGRAM_DEFAULT_CHAT not set — repo-runner-staleness alert not sent');
    return false;
  }

  try {
    await telegram.send(chatId, formatBreachMessage(b, thresholdHours));
    log.info({ repo: b.repo, hoursSinceActivity: b.hoursSinceActivity }, 'Repo-runner-staleness alert sent');
    return true;
  } catch (err) {
    log.error({ repo: b.repo, err }, 'Failed to send repo-runner-staleness alert');
    return false;
  }
}

// ── Main check runner ──────────────────────────────────────────────

export interface RepoStalenessCheckResult {
  ranAt: Date;
  breaches: RepoStalenessBreach[];
  alertsSent: number;
}

function requireDb(): void {
  if (!isConnected() || !TaskModel || !RunnerJobHistoryModel) {
    throw new Error('MongoDB not connected — repo runner staleness check unavailable');
  }
}

/**
 * Snapshot pending tasks grouped by repo, pair each against that repo's most
 * recent job-history run, evaluate the staleness threshold, and fire alerts
 * for newly-breaching (or cooldown-expired) repos. A repo that clears (queue
 * drained, or a fresh run recorded) has its cooldown reset so a future
 * breach alerts immediately. Never throws.
 *
 * @param now injectable clock (epoch ms) for deterministic tests.
 */
export async function runRepoStalenessCheck(now: number = Date.now()): Promise<RepoStalenessCheckResult> {
  const ranAt = new Date(now);

  let snapshots: RepoQueueSnapshot[];
  try {
    requireDb();
    const pendingDocs = (await scopedFind(TaskModel, DEFAULT_TENANT_ID, { status: 'pending' }).exec()) as Pick<ITask, 'repo'>[];
    const pendingCounts = new Map<string, number>();
    for (const d of pendingDocs) {
      pendingCounts.set(d.repo, (pendingCounts.get(d.repo) ?? 0) + 1);
    }

    // No early return when pendingCounts is empty — an empty snapshot list
    // still needs to flow through the recovery loop below so a repo whose
    // queue just drained gets its cooldown cleared (matching queue-wait-
    // alerter's semantics), not just skip straight to an empty result.
    const repos = [...pendingCounts.keys()];
    const historyDocs = repos.length === 0
      ? []
      : (await scopedFind(RunnerJobHistoryModel, DEFAULT_TENANT_ID, { repo: { $in: repos } })
          .sort({ startedAt: -1 })
          .exec()) as Pick<IRunnerJobHistory, 'repo' | 'startedAt'>[];
    const lastActivity = new Map<string, Date>();
    for (const d of historyDocs) {
      if (!lastActivity.has(d.repo)) lastActivity.set(d.repo, d.startedAt); // sorted desc — first hit is most recent
    }

    snapshots = repos.map(repo => ({
      repo,
      pendingCount: pendingCounts.get(repo) ?? 0,
      lastActivityAt: lastActivity.get(repo) ?? null,
    }));
  } catch (err) {
    log.warn({ err }, 'Repo-runner-staleness check skipped — DB unavailable');
    const result: RepoStalenessCheckResult = { ranAt, breaches: [], alertsSent: 0 };
    latestResult = result;
    return result;
  }

  const thresholdHours = stalenessThresholdHours();
  const breaches = evaluateRepoStaleness(snapshots, now, thresholdHours);
  const breachedRepos = new Set(breaches.map(b => b.repo));

  // Recovery: any previously-alerted repo no longer breaching (queue drained,
  // or a fresh run landed) clears its cooldown.
  for (const key of [...lastAlerted.keys()]) {
    if (!breachedRepos.has(key)) lastAlerted.delete(key);
  }

  let alertsSent = 0;
  for (const b of breaches) {
    const prev = lastAlerted.get(b.repo);
    const cooling = prev !== undefined && now - prev < cooldownMs();
    if (cooling) continue;

    const sent = await sendBreachAlert(b, thresholdHours);
    if (sent) {
      alertsSent++;
      lastAlerted.set(b.repo, now);
    }
  }

  const result: RepoStalenessCheckResult = { ranAt, breaches, alertsSent };
  latestResult = result;
  if (breaches.length > 0) {
    log.info({ breaches: breaches.length, alertsSent }, 'Repo-runner-staleness check complete — stalled repo(s) detected');
  }
  return result;
}

// ── Lifecycle ───────────────────────────────────────────────────────

let intervalId: ReturnType<typeof setInterval> | null = null;
let latestResult: RepoStalenessCheckResult | null = null;

/** Default check interval: 60 minutes — this is an hours-scale staleness signal, not a hot path. */
const DEFAULT_INTERVAL_MINUTES = 60;

export function startRepoStalenessAlerts(intervalMinutes: number = DEFAULT_INTERVAL_MINUTES): void {
  if (intervalId) {
    log.warn('Repo-runner-staleness alerts already running');
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  log.info({ intervalMinutes, thresholdHours: stalenessThresholdHours() }, 'Starting repo-runner-staleness alerts');

  intervalId = setInterval(() => {
    runRepoStalenessCheck().catch(err => log.error({ err }, 'Periodic repo-runner-staleness check failed'));
  }, intervalMs);
}

export function stopRepoStalenessAlerts(): void {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
    log.info('Repo-runner-staleness alerts stopped');
  }
}

export function isRepoStalenessAlertsRunning(): boolean {
  return intervalId !== null;
}

export function getLatestRepoStalenessCheckResult(): RepoStalenessCheckResult | null {
  return latestResult;
}

/** Current staleness alert configuration + state for status queries. */
export function getRepoStalenessAlertStatus(): {
  active: boolean;
  intervalMinutes: number;
  thresholdHours: number;
  cooldownHours: number;
  lastRun: Date | null;
  lastBreaches: number;
  trackedCooldowns: number;
} {
  return {
    active: intervalId !== null,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    thresholdHours: stalenessThresholdHours(),
    cooldownHours: cooldownHours(),
    lastRun: latestResult?.ranAt ?? null,
    lastBreaches: latestResult?.breaches.length ?? 0,
    trackedCooldowns: lastAlerted.size,
  };
}
