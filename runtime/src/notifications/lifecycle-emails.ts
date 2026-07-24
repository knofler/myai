/**
 * Lifecycle email sequence — transactional emails fired on key activation
 * milestones (signup, first task queued, first task shipped) to drive
 * re-engagement during onboarding.
 *
 * Distinct from notifications/service.ts: that system is opt-in, per-event,
 * preference-gated activity email (task.created, dispatch.completed, …) a
 * tenant can mute. THIS is a fixed, one-shot-per-tenant onboarding sequence —
 * always on (not gated by notification preferences) but still fully
 * env-gated on the email provider, exactly like the rest of the notification
 * stack: no SMTP configured (`isEmailConfigured()`, SMTP_HOST) means no send,
 * never a console-log fallback (email-notify.ts's rationale applies here too
 * — a one-off milestone email is not per-event hot-path noise, but the
 * console transport still shouldn't stand in for real delivery in tests of
 * this path).
 *
 * Idempotency reuses the activation funnel's proven first-wins recorder
 * (monitoring/activation-funnel.ts::recordActivation — unique {tenantId,
 * step} upsert). 'signup' is already one of the funnel's 5 display steps;
 * 'first_task'/'first_ship' are additional steps recorded solely to drive
 * this sequence (see the ActivationStep doc comment in shared/db.ts). Never
 * throws — a milestone email failure must never fail the operation that
 * reached the milestone (task creation, task completion, signup).
 */
import { createChildLogger } from '../shared/logger.js';
import { recordActivation } from '../monitoring/activation-funnel.js';
import { isEmailConfigured, resolveTenantEmails } from './email-notify.js';
import { sendMail } from '../shared/mailer.js';
import type { IActivationEvent } from '../shared/db.js';

const log = createChildLogger({ module: 'lifecycle-emails' });

export type LifecycleMilestone = 'signup' | 'first_task' | 'first_ship';

export interface LifecycleEmailContext {
  repo?: string;
  taskTitle?: string;
  tenantName?: string;
  /** Passed through to recordActivation's `source` — defaults to 'gateway'. */
  source?: IActivationEvent['source'];
}

export interface LifecycleEmailResult {
  sent: number;
  failed: number;
  skipped?: 'already-sent' | 'not-configured' | 'no-recipients';
}

function buildContent(milestone: LifecycleMilestone, ctx: LifecycleEmailContext): { subject: string; text: string } {
  const workspace = ctx.tenantName ? ` for ${ctx.tenantName}` : '';
  switch (milestone) {
    case 'signup':
      return {
        subject: '[myAI] Welcome — your workspace is live',
        text: [
          `Your myAI workspace${workspace} is ready.`,
          '',
          'Next step: dispatch your first task to see an agent ship real code.',
          '',
          'Open your dashboard: /work',
        ].join('\n'),
      };
    case 'first_task':
      return {
        subject: '[myAI] Your first task is queued',
        text: [
          `"${ctx.taskTitle ?? 'Your task'}"${ctx.repo ? ` (${ctx.repo})` : ''} is queued for an agent to pick up.`,
          '',
          "You'll get another email the moment it ships.",
          '',
          'Track it live: /work',
        ].join('\n'),
      };
    case 'first_ship':
      return {
        subject: '[myAI] Your first task shipped 🎉',
        text: [
          `"${ctx.taskTitle ?? 'Your task'}"${ctx.repo ? ` (${ctx.repo})` : ''} just shipped.`,
          '',
          'See what changed and queue the next one: /work',
        ].join('\n'),
      };
  }
}

/**
 * Fire the lifecycle email for a milestone, exactly once per tenant per
 * milestone. Returns why nothing was sent via `skipped` (already recorded,
 * no SMTP, or no notify-role recipients) — never throws.
 */
export async function notifyLifecycleMilestone(
  tenantId: string,
  milestone: LifecycleMilestone,
  ctx: LifecycleEmailContext = {},
): Promise<LifecycleEmailResult> {
  const isFirstTouch = await recordActivation(tenantId, milestone, { repo: ctx.repo, source: ctx.source ?? 'gateway' });
  if (!isFirstTouch) return { sent: 0, failed: 0, skipped: 'already-sent' };

  if (!isEmailConfigured()) return { sent: 0, failed: 0, skipped: 'not-configured' };

  const recipients = await resolveTenantEmails(tenantId);
  if (recipients.length === 0) return { sent: 0, failed: 0, skipped: 'no-recipients' };

  const { subject, text } = buildContent(milestone, ctx);
  const result: LifecycleEmailResult = { sent: 0, failed: 0 };
  for (const to of recipients) {
    try {
      await sendMail({ to, subject, text });
      result.sent++;
    } catch (err) {
      result.failed++;
      log.warn({ err, tenantId, to, milestone }, 'Lifecycle email send failed');
    }
  }
  if (result.sent) log.info({ tenantId, milestone, ...result }, 'Lifecycle email delivered');
  return result;
}
