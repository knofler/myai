'use client';

// Notification bell — unread badge + dropdown panel of recent notifications.
// Reads the shared notification context (one SSE feed for the whole app).
//
// REALTIME_NOTIFICATIONS plan, Phase 5.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useNotifications } from '@/lib/use-notifications';
import { LEVEL_STYLE, displayTitle } from '@/lib/notifications';
import { timeAgo } from '@/lib/format';

export function NotificationBell() {
  const { notifications, unreadCount, connected, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const recent = notifications.slice(0, 8);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative flex items-center justify-center w-9 h-9 rounded-lg border border-[rgb(var(--border-subtle))] text-[rgb(var(--text-primary))] hover:text-teal-300 hover:border-zinc-700 transition-colors active:scale-95"
      >
        <span className="text-base leading-none">🔔</span>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center rounded-full bg-brand-orange text-[10px] font-bold text-zinc-950">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
        {/* Live-feed dot — faint green when the SSE stream is connected. */}
        <span
          className={`absolute bottom-0.5 right-0.5 w-1.5 h-1.5 rounded-full ${connected ? 'bg-emerald-400' : 'bg-zinc-600'}`}
          aria-hidden="true"
        />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[90vw] z-[60] rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/98 backdrop-blur shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[rgb(var(--border-subtle))]">
            <span className="text-sm font-semibold text-[rgb(var(--text-primary))]">Notifications</span>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={markAllRead}
                className="text-[11px] text-teal-400 hover:text-teal-300"
              >
                Mark all read
              </button>
            )}
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-[rgb(var(--border-subtle))]/70">
            {recent.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-[rgb(var(--text-muted))]">
                No notifications yet.
              </div>
            ) : (
              recent.map((n) => {
                const style = LEVEL_STYLE[n.level] ?? LEVEL_STYLE.info;
                return (
                  <div key={n.id} className="flex gap-2.5 px-4 py-3 hover:bg-[rgb(var(--bg-hover))]/40 transition-colors">
                    <span className="text-sm leading-5 shrink-0" aria-hidden="true">{style.icon}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs text-[rgb(var(--text-primary))] leading-snug">{displayTitle(n)}</p>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-[10px] text-[rgb(var(--text-muted))]">{timeAgo(n.sentAt)}</span>
                        {n.source && (
                          <span className="text-[10px] text-zinc-600 font-mono truncate">· {n.source}</span>
                        )}
                        {!n.success && (
                          <span className="text-[10px] text-red-400/80">· failed</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <Link
            href="/notifications"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-center text-[11px] text-[rgb(var(--text-secondary))] hover:text-teal-300 border-t border-[rgb(var(--border-subtle))] transition-colors"
          >
            View all notifications →
          </Link>
        </div>
      )}
    </div>
  );
}
