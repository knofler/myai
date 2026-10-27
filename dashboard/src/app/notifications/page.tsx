'use client';

// /notifications — full notification history with filters, plus the
// notification settings panel (channels, quiet hours, per-event mutes, web
// push enrolment).
//
// Reads the shared notification context (the same live SSE feed that powers the
// bell + toasts), so new notifications appear here in real time too. Filters:
// All · Unread · by level (info / warning / error / critical).
//
// REALTIME_NOTIFICATIONS plan, Phases 5–7.

import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { Card, EmptyState } from '@/components/ui/card';
import { NotificationPreferences } from '@/components/notification-preferences';
import { PushOnboardCard } from '@/components/push-onboard-card';
import { useNotifications } from '@/lib/use-notifications';
import { LEVEL_STYLE, displayTitle, displayBody, type NotificationLevel } from '@/lib/notifications';
import { timeAgo, fmtSydney } from '@/lib/format';
import { plural, verb } from '@/lib/summary';

type Filter = 'all' | 'unread' | NotificationLevel;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'info', label: 'Info' },
  { key: 'warning', label: 'Warning' },
  { key: 'error', label: 'Error' },
  { key: 'critical', label: 'Critical' },
];

/** The one-line answer (DESIGN_LANGUAGE §5.1) — how much has come in and how
 *  much of it you have not looked at, from the live feed already in this page. */
function notificationsSummary(total: number, unread: number, connected: boolean): string {
  const link = connected ? '' : ' The live feed is reconnecting, so this may be behind.';
  if (total === 0) {
    return `Nothing has come in yet. Stage events, deploys and alerts land here the moment they happen.${link}`;
  }
  const head = `You have ${plural(total, 'recent notification')}.`;
  const tail =
    unread > 0
      ? ` ${unread} of them ${verb(unread, 'is', 'are')} still unread.`
      : ' You have read all of them.';
  return `${head}${tail}${link}`;
}

export default function NotificationsPage() {
  const { notifications, unreadCount, connected, markAllRead } = useNotifications();
  const [filter, setFilter] = useState<Filter>('all');
  // Snapshot of lastSeen at first render so the Unread filter doesn't empty out
  // the instant you open the page (markAllRead is an explicit action).
  const [seenBaseline] = useState(() => {
    if (typeof window === 'undefined') return 0;
    const raw = window.localStorage.getItem('myai:notifications:lastSeenAt');
    const ms = raw ? Number(raw) : 0;
    return Number.isFinite(ms) ? ms : 0;
  });

  const filtered = useMemo(() => {
    if (filter === 'all') return notifications;
    if (filter === 'unread') {
      return notifications.filter((n) => new Date(n.sentAt).getTime() > seenBaseline);
    }
    return notifications.filter((n) => n.level === filter);
  }, [notifications, filter, seenBaseline]);

  return (
    <div className="max-w-3xl">
      <PageHeader
        icon="notifications"
        title="Notifications"
        summary={notificationsSummary(notifications.length, unreadCount, connected)}
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span
              aria-hidden="true"
              className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-[rgb(var(--ok))]' : 'bg-[rgb(var(--border-strong))]'}`}
            />
            {connected ? 'Live' : 'Reconnecting'} · showing {filtered.length} of {notifications.length}
          </span>
        }
      >
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="px-3 py-1.5 rounded-lg border border-[rgb(var(--border-subtle))] text-xs text-teal-400 hover:text-teal-300 hover:border-[rgb(var(--border-strong))] transition-colors"
          >
            Mark all read
          </button>
        )}
      </PageHeader>

      <PushOnboardCard />

      <div className="flex flex-wrap gap-1.5 mb-5">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
              filter === key
                ? 'gel-brand text-teal-200 border-teal-500/40'
                : 'text-[rgb(var(--text-secondary))] border-[rgb(var(--border-subtle))] hover:text-[rgb(var(--text-primary))] hover:border-zinc-700'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <Card>
          <EmptyState>
            {filter === 'all'
              ? 'No notifications yet. Stage events, deploys, and alerts will appear here.'
              : `No ${filter} notifications.`}
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-2">
          {filtered.map((n) => {
            const style = LEVEL_STYLE[n.level] ?? LEVEL_STYLE.info;
            const body = displayBody(n);
            const unread = new Date(n.sentAt).getTime() > seenBaseline;
            return (
              <div
                key={n.id}
                className={`flex gap-3 rounded-xl border p-3.5 transition-colors ${
                  unread ? `${style.accent}` : 'border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/40'
                }`}
              >
                <span className="text-base leading-6 shrink-0" aria-hidden="true">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-[rgb(var(--text-primary))] leading-snug">{displayTitle(n)}</p>
                    {unread && <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${style.dot}`} aria-label="unread" />}
                  </div>
                  {body && <p className="text-xs text-[rgb(var(--text-secondary))] mt-1 leading-snug">{body}</p>}
                  <div className="flex flex-wrap items-center gap-2 mt-1.5 text-label text-[rgb(var(--text-muted))]">
                    <span title={fmtSydney(n.sentAt, 'full')}>{timeAgo(n.sentAt)}</span>
                    <span className="font-mono">· {n.channel}</span>
                    {n.source && <span className="font-mono truncate">· {n.source}</span>}
                    {!n.success && <span className="text-red-400/80">· delivery failed</span>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-6">
        <NotificationPreferences />
      </div>
    </div>
  );
}
