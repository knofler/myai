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

type Filter = 'all' | 'unread' | NotificationLevel;

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'info', label: 'Info' },
  { key: 'warning', label: 'Warning' },
  { key: 'error', label: 'Error' },
  { key: 'critical', label: 'Critical' },
];

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
        title="Notifications"
        subtitle={
          <span className="inline-flex items-center gap-2">
            <span className={`w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
            {connected ? 'Live' : 'Reconnecting'} · {notifications.length} recent
            {unreadCount > 0 && <span className="text-brand-orange">· {unreadCount} unread</span>}
          </span>
        }
      >
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={markAllRead}
            className="px-3 py-1.5 rounded-lg border border-zinc-800 text-xs text-teal-400 hover:text-teal-300 hover:border-zinc-700 transition-colors"
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
                : 'text-zinc-400 border-zinc-800 hover:text-zinc-200 hover:border-zinc-700'
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
                  unread ? `${style.accent}` : 'border-zinc-800 bg-zinc-900/40'
                }`}
              >
                <span className="text-base leading-6 shrink-0" aria-hidden="true">{style.icon}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm text-zinc-100 leading-snug">{displayTitle(n)}</p>
                    {unread && <span className={`mt-1 w-2 h-2 rounded-full shrink-0 ${style.dot}`} aria-label="unread" />}
                  </div>
                  {body && <p className="text-xs text-zinc-400 mt-1 leading-snug">{body}</p>}
                  <div className="flex flex-wrap items-center gap-2 mt-1.5 text-[10px] text-zinc-500">
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
