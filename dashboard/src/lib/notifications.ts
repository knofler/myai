// Shared notification types + gateway helper.
//
// The gateway's notifier (runtime/src/notifications/notifier.ts) persists every
// notification it sends (Telegram / Discord / …) and exposes the recent history
// through the `notifications_history` MCP tool. The dashboard consumes THAT as
// its notification feed — the bell, the toast stack, and the /notifications
// history page all read from here.
//
// REALTIME_NOTIFICATIONS plan, Phase 5 (Notification UI).

import { callGateway } from '@/lib/gateway';

export type NotificationLevel = 'info' | 'warning' | 'error' | 'critical';

/** One persisted notifier entry, as returned by `notifications_history`. */
export interface NotificationEntry {
  channel: string;
  chatId: string;
  message: string;
  level: NotificationLevel;
  title?: string;
  source?: string;
  sentAt: string; // ISO — serialized over JSON
  success: boolean;
  error?: string;
  /** Synthetic, stable client-side id (gateway entries have no _id). */
  id: string;
}

interface HistoryResponse {
  count: number;
  notifications: Array<Omit<NotificationEntry, 'id'>>;
}

/**
 * A stable id for an entry the gateway returns without one. Combining the
 * timestamp with the channel + a short message fingerprint is enough to dedupe
 * the same notification across successive polls and to key React lists.
 */
export function entryId(e: { sentAt: string; channel: string; message: string }): string {
  const ms = new Date(e.sentAt).getTime();
  let hash = 0;
  for (let i = 0; i < e.message.length; i++) {
    hash = (hash * 31 + e.message.charCodeAt(i)) | 0;
  }
  return `${ms}-${e.channel}-${(hash >>> 0).toString(36)}`;
}

/** Fetch recent notification history from the gateway, newest first. */
export async function fetchNotificationHistory(limit = 50): Promise<NotificationEntry[]> {
  const res = await callGateway<HistoryResponse>('notifications_history', { limit });
  if (!res || !Array.isArray(res.notifications)) return [];
  return res.notifications.map((n) => ({ ...n, id: entryId(n) }));
}

/** Toast auto-dismiss duration per level (ms). 0 = persist until dismissed. */
export const TOAST_DURATION: Record<NotificationLevel, number> = {
  info: 5000,
  warning: 8000,
  error: 0,
  critical: 0,
};

/** Tailwind accent classes per level — single source of truth for the UI. */
export const LEVEL_STYLE: Record<NotificationLevel, { icon: string; accent: string; dot: string }> = {
  info: { icon: 'ℹ️', accent: 'border-blue-500/40 bg-blue-500/10', dot: 'bg-blue-400' },
  warning: { icon: '⚠️', accent: 'border-yellow-500/40 bg-yellow-500/10', dot: 'bg-yellow-400' },
  error: { icon: '❌', accent: 'border-red-500/40 bg-red-500/10', dot: 'bg-red-400' },
  critical: { icon: '🚨', accent: 'border-red-500/50 bg-red-500/15', dot: 'bg-red-500' },
};

/**
 * The notifier formats the stored `message` with the level icon, an optional
 * bold title, a source tag, and the body. For the UI we strip that wrapper back
 * down to a clean title + body so the cards aren't doubly-decorated.
 */
export function displayTitle(e: NotificationEntry): string {
  if (e.title) return e.title;
  // Fall back to the first non-empty, non-meta line of the formatted message.
  const lines = e.message.split('\n').map((l) => l.trim());
  const body = lines.find(
    (l) => l && !l.startsWith('*') && !/^[ℹ️⚠️❌🚨]/.test(l) && !l.startsWith('Source:') && !/^\[/.test(l),
  );
  return body ?? e.message.slice(0, 80);
}

/**
 * The clean body line for a notification — the message content with the
 * notifier's title/icon/source wrapper stripped. Returns undefined when the
 * body is the same as the title (nothing extra to show).
 */
export function displayBody(e: NotificationEntry): string | undefined {
  const lines = e.message
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('*') && !/^[ℹ️⚠️❌🚨]/.test(l) && !l.startsWith('Source:') && !/^\[/.test(l));
  const body = lines.join(' ').trim();
  if (!body || body === displayTitle(e)) return undefined;
  return body;
}
