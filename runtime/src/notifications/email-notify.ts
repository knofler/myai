/**
 * Email notification delivery — sends background events to the tenant's members
 * over the shared mail transport (REALTIME_NOTIFICATIONS plan, Phase 7; the
 * third opt-in channel alongside in-app SSE and web push).
 *
 * Gated exactly like web push in the notification service: fires only when the
 * channel is enabled (opt-in, default off), the event family is un-muted, it's
 * outside quiet hours, and nobody has the dashboard open (an open tab already
 * showed the toast, so an email would be redundant chatter).
 *
 * Configuration: email delivery is a no-op unless SMTP is configured
 * (`SMTP_HOST`). Without it the mailer's console transport merely logs, which
 * would be noise on the per-event hot path — so we treat "no SMTP" as
 * "channel unavailable", matching how web push treats unset VAPID keys.
 *
 * Recipients are the tenant's owner/admin/member users (viewers are read-only
 * and excluded). Never throws — resolution and send failures are logged and
 * counted, never propagated to the emitter.
 */
import { createChildLogger } from '../shared/logger.js';
import { isConnected } from '../shared/db.js';
import { tenantScope } from '../shared/scoped-query.js';
import { sseManager } from './sse-manager.js';
import { sendMail } from '../shared/mailer.js';
import type { NotifyEvent } from './event-bus.js';

const log = createChildLogger({ module: 'email-notify' });

/** Roles that receive notification email; viewers are read-only and excluded. */
const NOTIFY_ROLES = ['owner', 'admin', 'member'] as const;
/** Hard cap on recipients per event so a large tenant can't fan out unbounded. */
const MAX_RECIPIENTS = 25;

export interface EmailSendResult {
  sent: number;
  failed: number;
  skipped?: 'not-configured' | 'active-sse' | 'no-recipients';
}

// ── Configuration ───────────────────────────────────────────

/**
 * Email is a real delivery channel only when SMTP is configured. The mailer's
 * console-transport fallback is fine for a one-off password reset, but per-event
 * notification email over it would just spam the gateway log — so treat unset
 * SMTP as "channel off", the same no-op contract web push uses for VAPID keys.
 */
export function isEmailConfigured(): boolean {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_HOST.trim());
}

// ── Recipient resolution ────────────────────────────────────

/** Distinct notify-role email addresses for a tenant (capped). Never throws. */
export async function resolveTenantEmails(tenantId: string): Promise<string[]> {
  if (!isConnected()) return [];
  try {
    const { UserModel } = await import('../shared/db.js');
    if (!UserModel) return [];
    const users = await UserModel.find({
      ...tenantScope(tenantId),
      role: { $in: NOTIFY_ROLES as unknown as string[] },
    })
      .select('email')
      .limit(MAX_RECIPIENTS)
      .lean<Array<{ email?: string }>>();
    const emails = new Set<string>();
    for (const u of users) {
      const e = u.email?.trim();
      if (e) emails.add(e);
    }
    return [...emails];
  } catch (err) {
    log.warn({ err, tenantId }, 'Failed to resolve tenant emails for notification');
    return [];
  }
}

// ── Delivery ────────────────────────────────────────────────

function buildSubject(event: NotifyEvent): string {
  return `[myAI] ${event.title}`;
}

function buildText(event: NotifyEvent): string {
  const lines = [event.title];
  if (event.message && event.message !== event.title) lines.push('', event.message);
  lines.push('', `Type: ${event.type}`, `Level: ${event.level}`);
  lines.push('', 'Open your dashboard: /notifications');
  lines.push('', 'You are receiving this because email notifications are enabled for your account.');
  return lines.join('\n');
}

/**
 * Email an event to every notify-role member of the tenant. Never throws; a
 * failed address is counted, not propagated.
 */
export async function sendEmailToTenant(tenantId: string, event: NotifyEvent): Promise<EmailSendResult> {
  if (!isEmailConfigured()) return { sent: 0, failed: 0, skipped: 'not-configured' };

  const recipients = await resolveTenantEmails(tenantId);
  if (recipients.length === 0) return { sent: 0, failed: 0, skipped: 'no-recipients' };

  const subject = buildSubject(event);
  const text = buildText(event);
  const result: EmailSendResult = { sent: 0, failed: 0 };
  for (const to of recipients) {
    try {
      await sendMail({ to, subject, text });
      result.sent++;
    } catch (err) {
      result.failed++;
      log.warn({ err, tenantId, to }, 'Notification email send failed');
    }
  }
  if (result.sent) log.debug({ tenantId, ...result, type: event.type }, 'Notification email delivered');
  return result;
}

/**
 * Email only when the tenant has no live in-app connection — an open dashboard
 * already surfaced the event, so an email would duplicate it.
 */
export async function sendEmailIfInactive(tenantId: string, event: NotifyEvent): Promise<EmailSendResult> {
  if (sseManager.hasClient(tenantId)) return { sent: 0, failed: 0, skipped: 'active-sse' };
  return sendEmailToTenant(tenantId, event);
}
