'use client';

// Notification context — one EventSource shared by the bell and the toast stack.
//
// Mounting <NotificationProvider> once (in AppShell) gives every consumer the
// same live feed, the same unread count, and the same read-state, instead of
// each component opening its own SSE connection. The feed is the gateway
// notifier history, streamed via /api/notifications/stream.
//
// Read-state model: the gateway's notifier history has no per-user `read` flag,
// so "read" is tracked client-side as a high-water timestamp in localStorage.
// Anything newer than `lastSeenAt` is unread. "Mark all read" advances it.
//
// REALTIME_NOTIFICATIONS plan, Phase 5.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { NotificationEntry } from '@/lib/notifications';

const LAST_SEEN_KEY = 'myai:notifications:lastSeenAt';
const MAX_KEPT = 100;

interface ToastItem extends NotificationEntry {
  toastKey: string;
}

interface NotificationCtx {
  notifications: NotificationEntry[];
  unreadCount: number;
  connected: boolean;
  toasts: ToastItem[];
  markAllRead: () => void;
  dismissToast: (toastKey: string) => void;
}

const Ctx = createContext<NotificationCtx | null>(null);

function readLastSeen(): number {
  if (typeof window === 'undefined') return 0;
  const raw = window.localStorage.getItem(LAST_SEEN_KEY);
  const ms = raw ? Number(raw) : 0;
  return Number.isFinite(ms) ? ms : 0;
}

export function NotificationProvider({ children }: { children: React.ReactNode }) {
  const [notifications, setNotifications] = useState<NotificationEntry[]>([]);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastSeenAt, setLastSeenAt] = useState<number>(0);
  // First SSE 'hello' is a backlog snapshot — never toast it.
  const primed = useRef(false);

  useEffect(() => {
    setLastSeenAt(readLastSeen());
  }, []);

  const pushToast = useCallback((entry: NotificationEntry) => {
    setToasts((prev) => {
      if (prev.some((t) => t.id === entry.id)) return prev;
      // Stack at most 3 visible; drop the oldest beyond that.
      const next = [...prev, { ...entry, toastKey: entry.id }];
      return next.slice(-3);
    });
  }, []);

  const dismissToast = useCallback((toastKey: string) => {
    setToasts((prev) => prev.filter((t) => t.toastKey !== toastKey));
  }, []);

  const mergeEntries = useCallback((incoming: NotificationEntry[]) => {
    setNotifications((prev) => {
      const byId = new Map(prev.map((n) => [n.id, n]));
      for (const e of incoming) byId.set(e.id, e);
      return [...byId.values()]
        .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime())
        .slice(0, MAX_KEPT);
    });
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let cancelled = false;

    // Fallback when EventSource is unavailable or errors repeatedly: poll JSON.
    const startPolling = () => {
      if (pollTimer) return;
      const tick = async () => {
        try {
          const res = await fetch('/api/notifications?limit=50', { cache: 'no-store' });
          const json = await res.json();
          if (!cancelled && Array.isArray(json.notifications)) mergeEntries(json.notifications);
        } catch {
          /* keep trying */
        }
      };
      void tick();
      pollTimer = setInterval(tick, 15_000);
    };

    try {
      es = new EventSource('/api/notifications/stream');
      es.onopen = () => !cancelled && setConnected(true);
      es.onmessage = (ev) => {
        if (cancelled) return;
        let msg: { type: string; entry?: NotificationEntry; entries?: NotificationEntry[] };
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (msg.type === 'hello' && msg.entries) {
          mergeEntries(msg.entries);
          primed.current = true;
        } else if (msg.type === 'notification' && msg.entry) {
          mergeEntries([msg.entry]);
          if (primed.current) pushToast(msg.entry);
        }
      };
      es.onerror = () => {
        setConnected(false);
        // EventSource auto-reconnects; if the env can't stream, fall back.
        if (es && es.readyState === EventSource.CLOSED) startPolling();
      };
    } catch {
      startPolling();
    }

    return () => {
      cancelled = true;
      if (es) es.close();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [mergeEntries, pushToast]);

  const markAllRead = useCallback(() => {
    const now = Date.now();
    setLastSeenAt(now);
    if (typeof window !== 'undefined') window.localStorage.setItem(LAST_SEEN_KEY, String(now));
  }, []);

  const unreadCount = notifications.filter((n) => new Date(n.sentAt).getTime() > lastSeenAt).length;

  return (
    <Ctx.Provider
      value={{ notifications, unreadCount, connected, toasts, markAllRead, dismissToast }}
    >
      {children}
    </Ctx.Provider>
  );
}

export function useNotifications(): NotificationCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Safe no-op default for any consumer rendered outside the provider.
    return {
      notifications: [],
      unreadCount: 0,
      connected: false,
      toasts: [],
      markAllRead: () => {},
      dismissToast: () => {},
    };
  }
  return ctx;
}
