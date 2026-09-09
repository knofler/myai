// EmptyState — the canonical "nothing here yet" surface (DASHBOARD_REDESIGN_
// 2026-09 primitive). Tokens-only, dependency-free. Replaces the terse
// EmptyState in card.tsx as pages migrate; that one stays for back-compat until
// B6 prunes it. Give it an optional glyph, a title, a one-line description and
// an optional action (a rendered <Link>/<button>, kept out of this primitive so
// it never needs the router).

import { cn } from '@/lib/utils';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className = '',
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-6 py-12 text-center',
        className,
      )}
    >
      {icon && (
        <div className="mb-1 text-2xl leading-none text-[rgb(var(--text-muted))]" aria-hidden="true">
          {icon}
        </div>
      )}
      <p className="text-sm font-semibold text-[rgb(var(--text-primary))]">{title}</p>
      {description && (
        <p className="max-w-sm text-xs text-[rgb(var(--text-muted))]">{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
