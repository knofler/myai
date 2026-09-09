'use client';

// Tooltip — hover/focus label (DASHBOARD_REDESIGN_2026-09 primitive).
// Dependency-free (no Radix/Floating-UI): a positioned <span role="tooltip">
// wired to the trigger via aria-describedby so screen readers announce it, and
// shown on both pointer hover AND keyboard focus so it's reachable without a
// mouse. `content` empty → renders the child unchanged (no wrapper), so it's
// safe to spread over conditionally-labelled elements.

import { useId, useState } from 'react';
import { cn } from '@/lib/utils';

type Side = 'top' | 'bottom' | 'left' | 'right';

const SIDE_POS: Record<Side, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-1.5',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-1.5',
  left: 'right-full top-1/2 -translate-y-1/2 mr-1.5',
  right: 'left-full top-1/2 -translate-y-1/2 ml-1.5',
};

export function Tooltip({
  content,
  side = 'top',
  children,
  className = '',
}: {
  content: React.ReactNode;
  side?: Side;
  children: React.ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  if (!content) return <>{children}</>;

  return (
    <span
      className="relative inline-flex"
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
      onFocusCapture={() => setOpen(true)}
      onBlurCapture={() => setOpen(false)}
    >
      <span aria-describedby={open ? id : undefined} className="inline-flex">
        {children}
      </span>
      <span
        role="tooltip"
        id={id}
        className={cn(
          'pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-[rgb(var(--border-strong))] bg-[rgb(var(--bg-raised))] px-2 py-1 text-xs text-[rgb(var(--text-primary))] shadow-lg transition-opacity duration-100',
          SIDE_POS[side],
          open ? 'opacity-100' : 'opacity-0',
          className,
        )}
      >
        {content}
      </span>
    </span>
  );
}
