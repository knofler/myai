// Skeleton — loading placeholder (DASHBOARD_REDESIGN_2026-09 primitive).
// Tokens-only, dependency-free. `animate-pulse` is a built-in Tailwind utility;
// it's suppressed automatically for users who ask the OS for reduced motion via
// the prefers-reduced-motion rule Tailwind ships with its animation utilities.

import { cn } from '@/lib/utils';

export function Skeleton({ className = '' }: { className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn('animate-pulse rounded-[var(--radius)] bg-[rgb(var(--border-subtle))]', className)}
    />
  );
}

/** A few stacked skeleton lines — the common "loading a text block" case. */
export function SkeletonText({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={cn('space-y-2', className)} aria-hidden="true">
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
}
