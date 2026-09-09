'use client';

// Toast — transient, self-dismissing message (DASHBOARD_REDESIGN_2026-09
// primitive). Dependency-free, tokens-only. Mount <ToastProvider> once inside
// the shell; anything under it calls `useToast().toast({...})` to enqueue one.
// Distinct from the notification feed (use-notifications.tsx / notification-
// toasts.tsx) — that streams gateway events; this is for local UI feedback
// ("Copied", "Saved", "Dispatch failed"). Uses the shared `toast-in` keyframe
// already defined in globals.css, suppressed under prefers-reduced-motion.

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';

type ToastVariant = 'default' | 'ok' | 'warn' | 'err' | 'info';

interface ToastInput {
  title: React.ReactNode;
  description?: React.ReactNode;
  variant?: ToastVariant;
  durationMs?: number;
}

interface ToastItem extends ToastInput {
  id: string;
}

interface ToastCtx {
  toast: (t: ToastInput) => void;
  dismiss: (id: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);

const VARIANT_ACCENT: Record<ToastVariant, string> = {
  default: 'border-l-[rgb(var(--border-strong))]',
  ok: 'border-l-[rgb(var(--ok))]',
  warn: 'border-l-[rgb(var(--warn))]',
  err: 'border-l-[rgb(var(--err))]',
  info: 'border-l-[rgb(var(--info))]',
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const toast = useCallback(
    (input: ToastInput) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((prev) => [...prev, { ...input, id }].slice(-4));
      const timer = setTimeout(() => dismiss(id), input.durationMs ?? 4000);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast, dismiss }), [toast, dismiss]);

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed bottom-4 right-4 z-[110] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role="status"
            style={{ animation: 'toast-in 0.18s ease-out' }}
            className={cn(
              'pointer-events-auto rounded-[var(--radius)] border border-l-4 border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))] p-3 shadow-lg',
              VARIANT_ACCENT[t.variant ?? 'default'],
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-[rgb(var(--text-primary))]">{t.title}</p>
                {t.description && (
                  <p className="mt-0.5 text-xs text-[rgb(var(--text-secondary))]">{t.description}</p>
                )}
              </div>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dismiss(t.id)}
                className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]"
              >
                ✕
              </button>
            </div>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    // Safe no-op outside a provider — a stray toast() call never throws.
    return { toast: () => {}, dismiss: () => {} };
  }
  return ctx;
}
