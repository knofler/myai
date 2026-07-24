'use client';

// Toast stack — slides in new notifications from the top-right (top on mobile),
// stacks up to 3, auto-dismisses by level (info 5s, warning 8s, error/critical
// persist until dismissed). Reads the shared notification context.
//
// REALTIME_NOTIFICATIONS plan, Phase 5.

import { useEffect } from 'react';
import { useNotifications } from '@/lib/use-notifications';
import { LEVEL_STYLE, TOAST_DURATION, displayTitle, displayBody } from '@/lib/notifications';

function Toast({
  toastKey,
  level,
  title,
  body,
  onDismiss,
}: {
  toastKey: string;
  level: keyof typeof LEVEL_STYLE;
  title: string;
  body?: string;
  onDismiss: () => void;
}) {
  const style = LEVEL_STYLE[level] ?? LEVEL_STYLE.info;
  const duration = TOAST_DURATION[level] ?? 5000;

  useEffect(() => {
    if (duration <= 0) return;
    const t = setTimeout(onDismiss, duration);
    return () => clearTimeout(t);
  }, [duration, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={`pointer-events-auto w-80 max-w-[90vw] rounded-xl border ${style.accent} bg-zinc-900/95 backdrop-blur shadow-2xl p-3.5 flex gap-2.5 animate-[toast-in_0.2s_ease-out]`}
    >
      <span className="text-base leading-5 shrink-0" aria-hidden="true">{style.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="text-xs font-semibold text-zinc-100 leading-snug">{title}</p>
        {body && (
          <p className="text-[11px] text-zinc-400 mt-0.5 leading-snug line-clamp-3">{body}</p>
        )}
      </div>
      <button
        type="button"
        aria-label="Dismiss notification"
        onClick={onDismiss}
        className="text-zinc-500 hover:text-zinc-300 text-sm leading-none shrink-0"
      >
        ✕
      </button>
    </div>
  );
}

export function NotificationToasts() {
  const { toasts, dismissToast } = useNotifications();

  if (toasts.length === 0) return null;

  return (
    <div className="fixed top-14 right-4 md:top-4 z-[70] flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <Toast
          key={t.toastKey}
          toastKey={t.toastKey}
          level={t.level}
          title={displayTitle(t)}
          body={displayBody(t)}
          onDismiss={() => dismissToast(t.toastKey)}
        />
      ))}
    </div>
  );
}
