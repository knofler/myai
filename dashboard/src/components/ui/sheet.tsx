'use client';

// Sheet — edge-anchored slide-in drawer (DASHBOARD_REDESIGN_2026-09 primitive).
// The design's drawers (mobile "More", detail panels) are Sheets. Dependency-
// free, tokens-only; same a11y contract as Dialog (role="dialog" + aria-modal,
// focus moved in / restored, Escape + backdrop close, Tab trap). Keeps mounting
// while closed so its slide-out transition can play, then parks off-screen and
// inert (pointer-events-none + not in the tab order).

import { useCallback, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/utils';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

type Side = 'left' | 'right' | 'bottom';

const PANEL_POS: Record<Side, string> = {
  left: 'top-0 bottom-0 left-0 h-full w-80 max-w-[85vw] border-r',
  right: 'top-0 bottom-0 right-0 h-full w-80 max-w-[85vw] border-l',
  bottom: 'left-0 right-0 bottom-0 max-h-[80vh] rounded-t-2xl border-t pb-[env(safe-area-inset-bottom)]',
};

const PANEL_HIDDEN: Record<Side, string> = {
  left: '-translate-x-full',
  right: 'translate-x-full',
  bottom: 'translate-y-full',
};

export function Sheet({
  open,
  onClose,
  side = 'right',
  title,
  children,
  className = '',
  id,
}: {
  open: boolean;
  onClose: () => void;
  side?: Side;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  /** Optional id on the panel — lets a trigger reference it via aria-controls. */
  id?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    openerRef.current = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    const first = panel?.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? panel)?.focus();
    return () => openerRef.current?.focus?.();
  }, [open]);

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;
      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null,
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    },
    [onClose],
  );

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className={cn(
          'fixed inset-0 z-[90] bg-black/60 transition-opacity duration-200',
          open ? 'opacity-100' : 'pointer-events-none opacity-0',
        )}
      />
      <div
        ref={panelRef}
        id={id}
        role="dialog"
        aria-modal={open ? true : undefined}
        aria-hidden={!open}
        aria-label={typeof title === 'string' ? title : undefined}
        aria-labelledby={title && typeof title !== 'string' ? titleId : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          'fixed z-[91] flex flex-col overflow-y-auto overscroll-contain border-[rgb(var(--border-strong))] bg-[rgb(var(--bg-raised))] shadow-xl outline-none transition-transform duration-200 ease-out',
          PANEL_POS[side],
          open ? 'translate-x-0 translate-y-0' : cn(PANEL_HIDDEN[side], 'pointer-events-none'),
          className,
        )}
      >
        {title && (
          <div className="flex items-center justify-between gap-3 border-b border-[rgb(var(--border-subtle))] px-4 py-3">
            <span id={titleId} className="text-sm font-semibold text-[rgb(var(--text-primary))]">
              {title}
            </span>
            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="-mr-1 flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--text-muted))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]"
            >
              ✕
            </button>
          </div>
        )}
        {children}
      </div>
    </>
  );
}
