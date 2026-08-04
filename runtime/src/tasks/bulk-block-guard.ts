/**
 * bulk-block-guard — stops a runaway process from mass-transitioning pending
 * tasks to blocked without an explicit supersession record or operator
 * authorization.
 *
 * Root cause (observed 2026-07-06 and 2026-07-07 against `connect`, documented
 * in that repo's AI_AGENT_HANDOFF.md): the auto-enqueued PLANNER task (see
 * scripts/queue_topup.sh) runs as a fully-autonomous LLM session with
 * unrestricted MCP access. Its charter was only ever "append lines to
 * config/runner_backlog.jsonl", but nothing stopped it from calling
 * tasks_update directly against the live gateway queue instead — it wrote a
 * speculative roadmap straight into connect's queue and mass-flipped its 20
 * curated pending tasks to `blocked`, displacing them and idling the runner
 * overnight, twice. It was never a gateway cron (schedules_list showed 0
 * jobs) — it was this task overreaching its own prompt.
 *
 * scripts/queue_topup.sh (2026-07-20) fixed the ONE known offender by making
 * planner auto-generation opt-in and adding a hard-boundary prompt clause.
 * That is a prompt instruction to an LLM session, not an enforcement
 * mechanism — it does nothing for a different rogue process, a future
 * planner variant, or a human fat-fingering a loop. This module is the
 * code-level backstop in task-store.ts's updateTask(), the single choke point
 * every caller (MCP tools, REST API, webhooks, inline executor) goes through.
 *
 * Policy: a pending→blocked transition is authorized when the caller supplies
 * either
 *   (a) an explicit supersession record — `supersededBy` naming the task that
 *       replaces it, or
 *   (b) an operator-authorized flag (`operatorAuthorized: true`) — a human
 *       explicitly consented to a bulk block.
 * A single genuine blocker (a task hitting a real, individual obstacle) is
 * normal and never needs either — the guard only counts UNAUTHORIZED
 * transitions and allows up to `threshold` of them per repo within
 * `windowMinutes` for free. Once a repo crosses that count in the window,
 * every further unauthorized transition is rejected and an alert fires
 * (Telegram + dashboard bell) exactly once per burst.
 */
import { emitNotifyEvent } from '../notifications/event-bus.js';
import { getAdapter } from '../channels/registry.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'bulk-block-guard' });

export class BulkBlockGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BulkBlockGuardError';
  }
}

export interface BulkBlockGuardConfig {
  threshold: number;
  windowMinutes: number;
}

function envNum(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Read thresholds from env at call time so tests (and a gateway restart) pick up changes. */
export function bulkBlockGuardConfig(): BulkBlockGuardConfig {
  return {
    threshold: envNum('BULK_BLOCK_GUARD_THRESHOLD', 5),
    windowMinutes: envNum('BULK_BLOCK_GUARD_WINDOW_MINUTES', 15),
  };
}

interface RepoLedger {
  /** Timestamps (ms) of recent UNAUTHORIZED pending→blocked transitions that were allowed through. */
  timestamps: number[];
  /** Whether this burst has already alerted — cleared once the ledger ages back to empty. */
  alerted: boolean;
}

/** repo -> ledger. In-process only, same lifetime as the pool-capacity-alerter's watermark map. */
const ledgers = new Map<string, RepoLedger>();

/** Test/manual reset — clears all per-repo state. */
export function resetBulkBlockGuard(): void {
  ledgers.clear();
}

function pruneLedger(entry: RepoLedger, now: number, windowMs: number): void {
  entry.timestamps = entry.timestamps.filter(t => now - t < windowMs);
  if (entry.timestamps.length === 0) entry.alerted = false;
}

export interface BulkBlockCheckInput {
  tenantId: string;
  repo: string;
  taskId: string;
  title?: string;
  /** True when the caller supplied an explicit supersession record (supersededBy) or operatorAuthorized:true. */
  authorized: boolean;
  /** Injectable clock (epoch ms) for deterministic tests. */
  now?: number;
}

export interface BulkBlockCheckResult {
  /** false = the transition must be rejected (guard tripped and not authorized). */
  allowed: boolean;
  countInWindow: number;
  threshold: number;
  windowMinutes: number;
}

/**
 * Record and evaluate one pending→blocked transition attempt. Never throws —
 * callers decide what "not allowed" means (task-store.ts raises
 * BulkBlockGuardError from it).
 */
export async function checkBulkBlock(input: BulkBlockCheckInput): Promise<BulkBlockCheckResult> {
  const cfg = bulkBlockGuardConfig();
  const now = input.now ?? Date.now();
  const windowMs = cfg.windowMinutes * 60_000;

  const entry = ledgers.get(input.repo) ?? { timestamps: [], alerted: false };
  pruneLedger(entry, now, windowMs);
  ledgers.set(input.repo, entry);

  if (input.authorized) {
    // Authorized transitions never count against the guard and are always allowed.
    return { allowed: true, countInWindow: entry.timestamps.length, threshold: cfg.threshold, windowMinutes: cfg.windowMinutes };
  }

  if (entry.timestamps.length < cfg.threshold) {
    entry.timestamps.push(now);
    return { allowed: true, countInWindow: entry.timestamps.length, threshold: cfg.threshold, windowMinutes: cfg.windowMinutes };
  }

  // Threshold breached — reject. Alert once per burst; the burst resets once
  // the window ages the ledger back to empty (pruneLedger above), so a fresh
  // burst later can trip (and alert) again.
  if (!entry.alerted) {
    entry.alerted = true;
    await fireAlert(input, entry.timestamps.length, cfg).catch(err => {
      log.warn({ err, repo: input.repo }, 'bulk-block-guard alert dispatch failed (suppressed)');
    });
  }
  return { allowed: false, countInWindow: entry.timestamps.length, threshold: cfg.threshold, windowMinutes: cfg.windowMinutes };
}

function formatAlertMessage(input: BulkBlockCheckInput, countInWindow: number, cfg: BulkBlockGuardConfig): string {
  const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  return [
    `\u{1F6A8} Bulk-block guard tripped — ${input.repo}`,
    `${countInWindow}+ unauthorized pending→blocked transitions within ${cfg.windowMinutes}m (threshold ${cfg.threshold}).`,
    `Rejected: ${input.taskId}${input.title ? ` (${input.title})` : ''} — no supersededBy/operatorAuthorized flag.`,
    'A process is mass-blocking this repo\'s queue without authorization — investigate before it displaces curated pending work.',
    `Detected at ${timestamp} UTC`,
  ].join('\n');
}

async function sendTelegram(message: string): Promise<boolean> {
  const telegram = getAdapter('telegram');
  if (!telegram || !telegram.enabled) return false;
  const chatId = process.env.TELEGRAM_DEFAULT_CHAT;
  if (!chatId) return false;
  try {
    await telegram.send(chatId, message);
    return true;
  } catch (err) {
    log.error({ err }, 'Failed to send bulk-block-guard Telegram alert');
    return false;
  }
}

async function fireAlert(input: BulkBlockCheckInput, countInWindow: number, cfg: BulkBlockGuardConfig): Promise<void> {
  const message = formatAlertMessage(input, countInWindow, cfg);

  // Dashboard bell/toast + durable history — in-process, always lands even
  // when Telegram is unconfigured (same pattern as pool-capacity-alerter).
  emitNotifyEvent({
    type: 'task.bulk_block_guard',
    tenantId: input.tenantId,
    title: `Bulk-block guard tripped: ${input.repo}`,
    message,
    level: 'critical',
    source: 'bulk-block-guard',
    data: {
      repo: input.repo,
      taskId: input.taskId,
      countInWindow,
      threshold: cfg.threshold,
      windowMinutes: cfg.windowMinutes,
    },
  });

  const sent = await sendTelegram(message);
  log.warn({ repo: input.repo, countInWindow, threshold: cfg.threshold, telegramSent: sent }, 'Bulk-block guard tripped');
}
