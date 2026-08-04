import { createChildLogger } from '../shared/logger.js';
import { getAdapter, listAdapters } from '../channels/registry.js';
import { isConnected } from '../shared/db.js';
import { scopedFind, tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'notifier' });

// ── Types ────────────────────────────────────────────────

export type NotificationLevel = 'info' | 'warning' | 'error' | 'critical';

export interface NotificationOpts {
  channels?: string[];
  chatId?: string;
  message: string;
  level?: NotificationLevel;
  title?: string;
  source?: string;
}

export interface NotificationSendResult {
  channel: string;
  chatId: string;
  success: boolean;
  error?: string;
}

export interface NotificationResult {
  sent: NotificationSendResult[];
  totalSent: number;
  totalFailed: number;
}

export interface NotificationHistoryEntry {
  channel: string;
  chatId: string;
  message: string;
  level: NotificationLevel;
  title?: string;
  source?: string;
  sentAt: Date;
  success: boolean;
  error?: string;
  /** Delivery-path storm-collapse burst id (see notifications/dedup.ts). When set,
   *  this write upserts onto the existing row for the same (tenantId, dedupKey)
   *  instead of creating a new document — repeats collapse into one entry. */
  dedupKey?: string;
  count?: number;
}

// ── Level prefix mapping ─────────────────────────────────

const LEVEL_ICONS: Record<NotificationLevel, string> = {
  info: 'ℹ️',       // information source emoji
  warning: '⚠️',    // warning sign emoji
  error: '❌',             // cross mark emoji
  critical: '🚨',   // rotating light emoji
};

// ── Default chat IDs from env ────────────────────────────

function getDefaultChatId(channel: string): string | undefined {
  if (channel === 'telegram') return process.env.TELEGRAM_DEFAULT_CHAT;
  if (channel === 'discord') return process.env.DISCORD_DEFAULT_CHANNEL;
  return undefined;
}

// ── Message formatting ───────────────────────────────────

export function formatNotification(opts: NotificationOpts): string {
  const level = opts.level ?? 'info';
  const icon = LEVEL_ICONS[level];

  const parts: string[] = [];

  if (opts.title) {
    parts.push(`*${opts.title}*`);
  }

  parts.push(`${icon} [${level.toUpperCase()}]`);

  if (opts.source) {
    parts.push(`Source: ${opts.source}`);
  }

  parts.push('');
  parts.push(opts.message);

  return parts.join('\n');
}

// ── Notification history (DB-backed) ─────────────────────

async function storeNotification(tenantId: string, entry: NotificationHistoryEntry): Promise<void> {
  if (!isConnected()) return;
  try {
    const { NotificationModel } = await import('../shared/db.js');
    if (!NotificationModel) return;
    if (entry.dedupKey) {
      // Storm collapse: repeats with the same burst id update the one row
      // (bumping `count`/message in place) instead of inserting a new document.
      await NotificationModel.findOneAndUpdate(
        { ...tenantScope(tenantId), dedupKey: entry.dedupKey },
        { $set: { ...tenantScope(tenantId), ...entry } },
        { upsert: true },
      );
      return;
    }
    await NotificationModel.create({ ...tenantScope(tenantId), ...entry });
  } catch (err) {
    log.warn({ err }, 'Failed to store notification in DB');
  }
}

/**
 * Persist a notification history entry WITHOUT dispatching to any channel.
 *
 * The real-time event path (event bus → SSE) delivers in-app instantly and only
 * needs the durable DB record for the history view — it must not spam Telegram/
 * Discord on every task update. This reuses the notifier's existing DB-write
 * path (`storeNotification`) so persistence stays in one place. No-op (and never
 * throws) when the DB is unavailable.
 */
export async function recordNotification(tenantId: string, entry: NotificationHistoryEntry): Promise<void> {
  await storeNotification(tenantId, entry);
}

export async function getNotificationHistory(tenantId: string, limit: number = 20): Promise<NotificationHistoryEntry[]> {
  if (!isConnected()) return [];
  try {
    const { NotificationModel } = await import('../shared/db.js');
    if (!NotificationModel) return [];
    const docs = await scopedFind(NotificationModel, tenantId, {})
      .sort({ sentAt: -1 })
      .limit(limit)
      .lean<NotificationHistoryEntry[]>();
    return docs;
  } catch (err) {
    log.warn({ err }, 'Failed to retrieve notification history');
    return [];
  }
}

// ── Core send function ───────────────────────────────────

export async function sendNotification(tenantId: string, opts: NotificationOpts): Promise<NotificationResult> {
  const level = opts.level ?? 'info';
  const formattedMessage = formatNotification(opts);

  // Determine which channels to send to
  let targetChannels: string[];
  if (opts.channels && opts.channels.length > 0) {
    targetChannels = opts.channels;
  } else {
    // Default: all enabled adapters
    targetChannels = listAdapters()
      .filter(a => a.enabled)
      .map(a => a.type);
  }

  if (targetChannels.length === 0) {
    log.warn('No channels available for notification');
    return { sent: [], totalSent: 0, totalFailed: 0 };
  }

  const results: NotificationSendResult[] = [];

  for (const channel of targetChannels) {
    const chatId = opts.chatId ?? getDefaultChatId(channel);
    if (!chatId) {
      const result: NotificationSendResult = {
        channel,
        chatId: '',
        success: false,
        error: `No chatId provided and no default configured for ${channel}`,
      };
      results.push(result);
      log.warn({ channel }, 'Skipping channel — no chatId available');

      await storeNotification(tenantId, {
        channel,
        chatId: '',
        message: formattedMessage,
        level,
        title: opts.title,
        source: opts.source,
        sentAt: new Date(),
        success: false,
        error: result.error,
      });

      continue;
    }

    const adapter = getAdapter(channel);
    if (!adapter) {
      const result: NotificationSendResult = {
        channel,
        chatId,
        success: false,
        error: `Adapter not found for channel: ${channel}`,
      };
      results.push(result);
      log.warn({ channel }, 'Channel adapter not registered');

      await storeNotification(tenantId, {
        channel,
        chatId,
        message: formattedMessage,
        level,
        title: opts.title,
        source: opts.source,
        sentAt: new Date(),
        success: false,
        error: result.error,
      });

      continue;
    }

    try {
      await adapter.send(chatId, formattedMessage);
      const result: NotificationSendResult = { channel, chatId, success: true };
      results.push(result);
      log.info({ channel, chatId, level }, 'Notification sent');

      await storeNotification(tenantId, {
        channel,
        chatId,
        message: formattedMessage,
        level,
        title: opts.title,
        source: opts.source,
        sentAt: new Date(),
        success: true,
      });
    } catch (err) {
      const errorMsg = (err as Error).message;
      const result: NotificationSendResult = {
        channel,
        chatId,
        success: false,
        error: errorMsg,
      };
      results.push(result);
      log.error({ channel, chatId, err }, 'Failed to send notification');

      await storeNotification(tenantId, {
        channel,
        chatId,
        message: formattedMessage,
        level,
        title: opts.title,
        source: opts.source,
        sentAt: new Date(),
        success: false,
        error: errorMsg,
      });
    }
  }

  const totalSent = results.filter(r => r.success).length;
  const totalFailed = results.filter(r => !r.success).length;

  return { sent: results, totalSent, totalFailed };
}
