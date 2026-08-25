/**
 * Slack notification delivery — sends background events (task/plan/runner
 * activity) to a tenant's own Incoming Webhook, alongside email (email-notify.ts)
 * and web push (web-push.ts).
 *
 * Unlike Telegram/Discord — a single fleet-wide bot the whole gateway shares —
 * Slack here is per-tenant: each tenant registers their own Incoming Webhook
 * URL (`NotificationPrefs.slackWebhookUrl`) via the preferences API, and
 * delivery is opt-in (`NotificationPrefs.slack`, default off), exactly like
 * email. The actual HTTP POST is delegated to the registered `SlackAdapter`
 * (channels/slack.ts) so there is one implementation of "POST to a Slack
 * webhook" shared with the fleet-wide `notifications_send` / SLO-alert path.
 *
 * Never throws — resolution and send failures are logged and counted, never
 * propagated to the emitter (same contract as email-notify.ts / web-push.ts).
 */
import { createChildLogger } from '../shared/logger.js';
import { isConnected } from '../shared/db.js';
import { tenantScope } from '../shared/scoped-query.js';
import { getAdapter } from '../channels/registry.js';
import { sseManager } from './sse-manager.js';
import type { NotifyEvent } from './event-bus.js';

const log = createChildLogger({ module: 'slack-notify' });

export interface SlackSendResult {
  sent: number;
  failed: number;
  skipped?: 'not-configured' | 'active-sse' | 'no-webhook';
}

const LEVEL_ICONS: Record<NotifyEvent['level'], string> = {
  info: 'ℹ️',
  warning: '⚠️',
  error: '❌',
  critical: '🚨',
};

// ── Configuration ───────────────────────────────────────────

/** The tenant's Slack webhook URL, or undefined if none is configured. */
export async function getTenantSlackWebhook(tenantId: string): Promise<string | undefined> {
  if (!isConnected()) return undefined;
  try {
    const { NotificationPrefsModel } = await import('../shared/db.js');
    if (!NotificationPrefsModel) return undefined;
    const doc = await NotificationPrefsModel.findOne(tenantScope(tenantId))
      .lean<{ slackWebhookUrl?: string }>();
    return doc?.slackWebhookUrl || undefined;
  } catch (err) {
    log.warn({ err, tenantId }, 'Failed to resolve tenant Slack webhook');
    return undefined;
  }
}

/** Whether the tenant has a Slack webhook configured (delivery still gated by prefs.slack). */
export async function isSlackConfiguredForTenant(tenantId: string): Promise<boolean> {
  return Boolean(await getTenantSlackWebhook(tenantId));
}

// ── Message formatting ───────────────────────────────────────

/**
 * Format a notify-bus event for Slack. Uses `mrkdwn` (Slack's markdown dialect
 * — `*bold*`, same syntax the Telegram formatter in notifier.ts already uses)
 * so both channels share the same visual convention for task/plan/runner and
 * dispatch activity.
 */
export function formatSlackMessage(event: NotifyEvent): string {
  const icon = LEVEL_ICONS[event.level] ?? LEVEL_ICONS.info;
  const parts: string[] = [`*${event.title}*`, `${icon} [${event.level.toUpperCase()}] · ${event.type}`];
  if (event.message && event.message !== event.title) {
    parts.push('', event.message);
  }
  if (event.source) parts.push(`_Source: ${event.source}_`);
  return parts.join('\n');
}

// ── Delivery ────────────────────────────────────────────────

/**
 * Post an event to the tenant's Slack webhook. Never throws; a missing
 * webhook or a failed POST is reported via `skipped`/`failed`, not thrown.
 *
 * `webhookUrl` is optional — pass it when the caller already has the tenant's
 * preferences loaded (service.ts's hot path does) to avoid a second DB round
 * trip; omitted, it's resolved fresh via {@link getTenantSlackWebhook}.
 */
export async function sendSlackToTenant(tenantId: string, event: NotifyEvent, webhookUrl?: string): Promise<SlackSendResult> {
  const url = webhookUrl ?? await getTenantSlackWebhook(tenantId);
  if (!url) return { sent: 0, failed: 0, skipped: 'no-webhook' };

  const adapter = getAdapter('slack');
  if (!adapter) return { sent: 0, failed: 0, skipped: 'not-configured' };

  try {
    await adapter.send(url, formatSlackMessage(event));
    log.debug({ tenantId, type: event.type }, 'Notification Slack message delivered');
    return { sent: 1, failed: 0 };
  } catch (err) {
    log.warn({ err, tenantId, type: event.type }, 'Notification Slack send failed');
    return { sent: 0, failed: 1 };
  }
}

/**
 * Slack only when the tenant has no live in-app connection — an open dashboard
 * already surfaced the event (same "don't duplicate an open tab" contract as
 * email/push).
 */
export async function sendSlackIfInactive(tenantId: string, event: NotifyEvent, webhookUrl?: string): Promise<SlackSendResult> {
  if (sseManager.hasClient(tenantId)) return { sent: 0, failed: 0, skipped: 'active-sse' };
  return sendSlackToTenant(tenantId, event, webhookUrl);
}
