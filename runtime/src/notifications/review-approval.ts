/**
 * Telegram remote-approve — the C1 two-way action loop for review-gated tasks.
 *
 * Distinct from `notifications/service.ts` (which fans task-lifecycle events
 * out to SSE + DB history only — deliberately silent on Telegram/Discord to
 * avoid noise): THIS module fires an explicit, actionable Telegram message
 * whenever a task flips into `review`, with inline Approve/Reject buttons that
 * close the loop — ship it (→ done) or reject (→ reopened as pending) — from
 * the phone, no dashboard required.
 *
 * Subscribes to the same `notifyBus` as the notification service (started
 * once via `startReviewApprovalService()`, called from `createHttpServer()`)
 * rather than being called directly from task-store.ts — keeps this module a
 * leaf dependency (DB + channel registry only) with no edge back into
 * task-store, which the callback-resolution path would otherwise cycle
 * through (task-store → mcp/tools → ... → this module → task-store).
 *
 * Token design mirrors magic-link.ts: an opaque, DB-backed, single-use,
 * TTL'd token — NOT a self-contained signed payload — because Telegram's
 * `callback_data` has a 64-byte budget, too tight to carry a taskId + tenantId
 * + signature safely. `resolvePendingReview()` burns the token atomically
 * (status:'pending' → 'resolved' in one update) so a double-tap or two
 * near-simultaneous taps only ever apply once.
 */
import crypto from 'node:crypto';
import { ReviewApprovalModel, isConnected } from '../shared/db.js';
import type { IReviewApproval, ReviewApprovalResolution } from '../shared/db.js';
import { notifyBus } from './event-bus.js';
import type { NotifyEvent } from './event-bus.js';
import { getAdapter } from '../channels/registry.js';
import type { TelegramAdapter } from '../channels/telegram.js';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'review-approval' });

// A review may sit unattended for days — TTL is generous, not a UX timeout.
const REVIEW_APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReviewTaskInfo {
  taskId: string;
  title: string;
  repo: string;
  priority?: string;
}

function reviewChatId(): string | undefined {
  return process.env.TELEGRAM_DEFAULT_CHAT;
}

/** Escape Telegram Markdown special chars so a task title can't break formatting. */
function escapeMd(s: string): string {
  return s.replace(/([_*[\]`])/g, '\\$1');
}

/**
 * Fire the "review ready" Telegram prompt with Approve/Reject buttons.
 * No-op (never throws) when Telegram isn't configured or the DB is down —
 * this must never fail the task-status write that triggered it.
 */
export async function requestReviewApproval(tenantId: string, task: ReviewTaskInfo): Promise<void> {
  if (!isConnected() || !ReviewApprovalModel) return;

  const adapter = getAdapter('telegram') as TelegramAdapter | undefined;
  if (!adapter || !adapter.enabled) return;

  const chatId = reviewChatId();
  if (!chatId) {
    log.debug('TELEGRAM_DEFAULT_CHAT not set — skipping review-approval prompt');
    return;
  }

  // 12 URL-safe chars — short enough that `rvw:a:<id>` sits well under
  // Telegram's 64-byte callback_data limit.
  const reviewId = crypto.randomBytes(9).toString('base64url');

  try {
    const text =
      `*Review ready*\n${escapeMd(task.title)}\n` +
      `Repo: ${escapeMd(task.repo)}${task.priority ? ` · Priority: ${task.priority}` : ''}\n` +
      `Task: \`${task.taskId}\``;

    const messageId = await adapter.sendWithButtons(chatId, text, [
      [
        { text: '✅ Ship it', callback_data: `rvw:a:${reviewId}` },
        { text: '❌ Reject', callback_data: `rvw:r:${reviewId}` },
      ],
    ]);

    await ReviewApprovalModel.create({
      reviewId,
      tenantId,
      taskId: task.taskId,
      status: 'pending',
      telegramChatId: chatId,
      telegramMessageId: messageId ?? undefined,
      expiresAt: new Date(Date.now() + REVIEW_APPROVAL_TTL_MS),
    });

    log.info({ taskId: task.taskId, reviewId }, 'Review-approval prompt sent');
  } catch (err) {
    log.warn({ err, taskId: task.taskId }, 'Failed to send review-approval prompt');
  }
}

export interface ReviewCallbackOutcome {
  ok: boolean;
  /** User-facing text — shown in the callback-query toast and appended to the edited message. */
  text: string;
  tenantId?: string;
  taskId?: string;
  /** Target task status the caller should apply via tasks_update. */
  targetStatus?: 'done' | 'pending';
}

/**
 * Burn a review token and report the transition the caller should apply.
 * Does NOT touch the task itself — the caller (the Telegram adapter's
 * callback_query handler) applies `targetStatus` via the ordinary tenant-
 * scoped `tasks_update` tool so every other side effect (usage meter, SSE,
 * preemption resume) fires exactly as a manual dashboard edit would.
 */
export async function resolvePendingReview(
  reviewId: string,
  action: 'a' | 'r',
  resolvedByUserId: string,
): Promise<ReviewCallbackOutcome> {
  if (!isConnected() || !ReviewApprovalModel) {
    return { ok: false, text: 'Gateway database unavailable — try again shortly.' };
  }

  const doc = await ReviewApprovalModel.findOne({ reviewId }).lean<IReviewApproval>();
  if (!doc) return { ok: false, text: 'This review prompt is no longer valid.' };
  if (doc.status !== 'pending') {
    return { ok: false, text: `Already ${doc.resolution ?? 'resolved'} — no action taken.` };
  }
  if (doc.expiresAt.getTime() < Date.now()) {
    return { ok: false, text: 'This review prompt expired.' };
  }

  const resolution: ReviewApprovalResolution = action === 'a' ? 'approved' : 'rejected';
  const burn = await ReviewApprovalModel.updateOne(
    { reviewId, status: 'pending' },
    { $set: { status: 'resolved', resolution, resolvedByUserId, resolvedAt: new Date() } },
  );
  if (burn.modifiedCount !== 1) {
    // Lost the race to a concurrent tap on the same button pair.
    return { ok: false, text: 'Already resolved — no action taken.' };
  }

  const verb = action === 'a' ? 'Shipped' : 'Reopened';
  return {
    ok: true,
    text: `${verb}: ${doc.taskId}`,
    tenantId: doc.tenantId,
    taskId: doc.taskId,
    targetStatus: action === 'a' ? 'done' : 'pending',
  };
}

// ── Bus wiring ───────────────────────────────────────────

let unsubscribe: (() => void) | null = null;

async function handleEvent(event: NotifyEvent): Promise<void> {
  if (event.type !== 'task.updated' || event.data?.status !== 'review') return;
  const taskId = event.data?.taskId as string | undefined;
  const repo = event.data?.repo as string | undefined;
  const taskTitle = event.data?.taskTitle as string | undefined;
  const priority = event.data?.priority as string | undefined;
  if (!taskId || !repo || !taskTitle) return;
  await requestReviewApproval(event.tenantId, { taskId, title: taskTitle, repo, priority });
}

/** Start the review-approval listener (idempotent). Mirrors startNotificationService(). */
export function startReviewApprovalService(): void {
  if (unsubscribe) return;
  unsubscribe = notifyBus.on(handleEvent);
  log.info('Review-approval service started — bus → Telegram remote-approve');
}

/** Stop the listener (test isolation / shutdown). */
export function stopReviewApprovalService(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}
