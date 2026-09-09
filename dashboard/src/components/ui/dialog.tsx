'use client';

// Dialog — centred modal (DASHBOARD_REDESIGN_2026-09 primitive).
// Dependency-free, tokens-only. Matches the a11y contract the idle-timeout
// guard already ships: role="dialog" + aria-modal, labelled by its title, focus
// moved in on open and returned to the opener on close, Escape + backdrop close,
// and a Tab focus-trap so keyboard focus can't escape behind the backdrop.
// Renders nothing when closed (no portal — a high z-index fixed layer, the same
// approach used elsewhere in this app).

import { useCallback, useEffect, useId, useRef } from 'react';
import { cn } from '@/lib/utils';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className = '',
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  // Remember what had focus, move focus into the panel, restore on close.
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

  if (!open) return null;

  return (
    <div
      className="backdrop-enter fixed inset-0 z-[100] flex items-center justify-center bg-black/70 px-4"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        className={cn(
          'w-full max-w-md rounded-[var(--radius)] border border-[rgb(var(--border-strong))] bg-[rgb(var(--bg-raised))] p-5 shadow-xl outline-none',
          className,
        )}
      >
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-sm font-semibold text-[rgb(var(--text-primary))]">
            {title}
          </h2>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            className="-mr-1 -mt-1 flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--text-muted))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]"
          >
            ✕
          </button>
        </div>
        {description && (
          <p id={descId} className="mt-2 text-sm text-[rgb(var(--text-secondary))]">
            {description}
          </p>
        )}
        {children && <div className="mt-4 text-sm text-[rgb(var(--text-secondary))]">{children}</div>}
        {footer && <div className="mt-5 flex items-center justify-end gap-2">{footer}</div>}
      </div>
    </div>
  );
}
