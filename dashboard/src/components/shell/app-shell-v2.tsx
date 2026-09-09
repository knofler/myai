'use client';

// AppShellV2 — the "Mission Control" shell (DASHBOARD_REDESIGN_2026-09 §Shell).
// Shipped behind NEXT_PUBLIC_UI_V2 in B1; the flag was removed in B6 (see
// app-shell.tsx) and this is now the operator chrome for every route that
// isn't full-bleed public/marketing/legal. Grouped left rail
// (collapsible 240→56px, keyboard-navigable), a top bar (breadcrumb, tenant
// switcher, ⌘K, theme toggle, brain badge), and a mobile bottom tab bar
// (Operate / Brain / Money / More → Sheet). No fixed mobile top bar and no
// --safe-top reserve — the two mobile-scroll hazards the brief calls out.
// Tokens-only; reuses the existing TenantSwitcher / ThemeToggle / CommandPalette
// / notification feed so behaviour is unchanged, only the chrome is new.

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { TenantSwitcher } from '@/components/tenant-switcher';
import { ThemeToggle } from '@/components/theme-toggle';
import { NotificationBell } from '@/components/notification-bell';
import { CommandPalette } from '@/components/command-palette';
import { NotificationProvider } from '@/lib/use-notifications';
import { NotificationToasts } from '@/components/notification-toasts';
import { ToastProvider } from '@/components/ui/toast';
import { Sheet } from '@/components/ui/sheet';
import { Tooltip } from '@/components/ui/tooltip';
import { BrainBadge } from '@/components/shell/brain-badge';
import { TOUR_START_EVENT } from '@/components/product-tour';
import {
  NAV_V2_GROUPS,
  isActive,
  groupIdForPathname,
  primaryMobileTabs,
  moreMobileGroups,
} from '@/lib/nav-v2';
import { cn } from '@/lib/utils';

const COLLAPSE_KEY = 'myai.shell.v2.collapsed';

function breadcrumb(pathname: string): string {
  if (pathname === '/') return 'Mission Control';
  const seg = pathname.split('/').filter(Boolean)[0] ?? '';
  const group = NAV_V2_GROUPS.find((g) => g.links.some((l) => isActive(pathname, l.href)));
  const link = group?.links.find((l) => isActive(pathname, l.href));
  return link?.label ?? seg.charAt(0).toUpperCase() + seg.slice(1);
}

function openCommandPalette() {
  // The palette listens for ⌘/Ctrl-K on window; synthesize it so the top-bar
  // button opens the same one instead of duplicating its logic.
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
}

export function AppShellV2({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? '/';
  const [collapsed, setCollapsed] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const activeGroup = groupIdForPathname(pathname);

  // Restore the rail collapse preference after mount (server render is always
  // expanded, so no hydration mismatch).
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* private mode — in-memory default is fine */
    }
  }, []);

  // Close the "More" sheet on navigation.
  useEffect(() => {
    setMoreOpen(false);
  }, [pathname]);

  function toggleCollapsed() {
    setCollapsed((c) => {
      const next = !c;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  const primaryTabs = primaryMobileTabs();
  const moreGroups = moreMobileGroups();
  const moreActive = moreGroups.some((g) => g.id === activeGroup);

  return (
    <NotificationProvider>
      <ToastProvider>
        {/* ── Desktop left rail (md+) ─────────────────────────────── */}
        <aside
          aria-label="Primary"
          className={cn(
            'hidden md:flex fixed inset-y-0 left-0 z-40 flex-col border-r border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-canvas))] transition-[width] duration-200 ease-out',
            collapsed ? 'w-14' : 'w-60',
          )}
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[rgb(var(--border-subtle))] px-3">
            <span className="text-lg font-bold tracking-tight text-brand-orange">
              {collapsed ? 'm' : 'myAI'}
            </span>
            <button
              type="button"
              aria-label={collapsed ? 'Expand navigation' : 'Collapse navigation'}
              aria-pressed={collapsed}
              onClick={toggleCollapsed}
              className="ml-auto flex h-8 w-8 items-center justify-center rounded-md text-[rgb(var(--text-muted))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]"
            >
              <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
            </button>
          </div>

          <nav className="nav-scroll flex-1 space-y-3 overflow-x-hidden overflow-y-auto overscroll-contain p-2">
            {NAV_V2_GROUPS.map((group) => (
              <div key={group.id} className="space-y-0.5">
                {!collapsed && (
                  <p className="px-2 pt-1 text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--text-muted))]">
                    {group.label}
                  </p>
                )}
                {group.links.map((link) => {
                  const active = isActive(pathname, link.href);
                  const item = (
                    <Link
                      key={link.href}
                      href={link.href}
                      aria-current={active ? 'page' : undefined}
                      className={cn(
                        'flex items-center gap-3 rounded-[var(--radius)] px-2.5 py-2 text-sm transition-colors',
                        collapsed && 'justify-center px-0',
                        active
                          ? 'bg-[rgb(var(--accent))]/15 font-medium text-[rgb(var(--text-primary))]'
                          : 'text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]',
                      )}
                    >
                      <span
                        className={cn(
                          'w-5 shrink-0 text-center font-mono text-base leading-none',
                          active && 'text-[rgb(var(--accent))]',
                        )}
                        aria-hidden="true"
                      >
                        {link.icon}
                      </span>
                      {!collapsed && <span className="min-w-0 truncate">{link.label}</span>}
                    </Link>
                  );
                  return collapsed ? (
                    <Tooltip key={link.href} content={link.label} side="right">
                      {item}
                    </Tooltip>
                  ) : (
                    item
                  );
                })}
              </div>
            ))}
          </nav>
        </aside>

        {/* ── Content column ──────────────────────────────────────── */}
        <div className={cn('flex min-w-0 flex-1 flex-col', collapsed ? 'md:ml-14' : 'md:ml-60')}>
          {/* Top bar — sticky, no mobile fixed bar / no --safe-top reserve. */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-canvas))]/95 px-4 backdrop-blur">
            <span className="md:hidden text-base font-bold tracking-tight text-brand-orange">myAI</span>
            <nav aria-label="Breadcrumb" className="hidden min-w-0 md:block">
              <span className="truncate text-sm font-semibold text-[rgb(var(--text-primary))]">
                {breadcrumb(pathname)}
              </span>
            </nav>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={openCommandPalette}
                aria-label="Open command palette"
                className="hidden items-center gap-2 rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))] px-2.5 py-1.5 text-xs text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] sm:flex"
              >
                <span>Search</span>
                <kbd className="rounded border border-[rgb(var(--border-strong))] px-1 font-mono">⌘K</kbd>
              </button>
              <div className="hidden sm:block">
                <BrainBadge />
              </div>
              {/* Replay the first-run tour. Lived in the legacy nav.tsx until
                  B6 deleted it; the tour listens for TOUR_START_EVENT on
                  window, so the affordance only has to dispatch. */}
              <button
                type="button"
                data-testid="tour-replay"
                onClick={() => window.dispatchEvent(new Event(TOUR_START_EVENT))}
                aria-label="Replay product tour"
                title="Replay product tour"
                className="hidden rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))] px-2 py-1.5 text-xs text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] sm:block"
              >
                Tour
              </button>
              <NotificationBell />
              <TenantSwitcher />
              <ThemeToggle />
            </div>
          </header>

          <main className="min-w-0 flex-1 overflow-x-hidden p-4 pb-24 md:p-8 md:pb-8">
            {children}
          </main>
        </div>

        {/* ── Mobile bottom tab bar (below md) ────────────────────── */}
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-canvas))]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          {primaryTabs.map((tab) => {
            const active = tab.id === activeGroup;
            return (
              <Link
                key={tab.id}
                href={tab.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
                  active ? 'text-[rgb(var(--accent))]' : 'text-[rgb(var(--text-muted))]',
                )}
              >
                <span aria-hidden="true" className="text-base leading-none">
                  {tab.icon}
                </span>
                <span className="leading-none">{tab.label}</span>
              </Link>
            );
          })}
          <button
            type="button"
            aria-expanded={moreOpen}
            aria-controls="mobile-more-sheet"
            onClick={() => setMoreOpen(true)}
            className={cn(
              'flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 py-2 text-[11px] font-medium transition-colors',
              moreOpen || moreActive ? 'text-[rgb(var(--accent))]' : 'text-[rgb(var(--text-muted))]',
            )}
          >
            <span aria-hidden="true" className="text-base leading-none">
              ⋯
            </span>
            <span className="leading-none">More</span>
          </button>
        </nav>

        {/* "More" sheet — Build + Account groups. */}
        <Sheet id="mobile-more-sheet" open={moreOpen} onClose={() => setMoreOpen(false)} side="bottom" title="More">
          <div className="space-y-4 p-3">
            {moreGroups.map((group) => (
              <div key={group.id} className="space-y-1">
                <p className="px-1 text-[11px] font-semibold uppercase tracking-wider text-[rgb(var(--text-muted))]">
                  {group.label}
                </p>
                <div className="grid grid-cols-3 gap-1">
                  {group.links.map((link) => {
                    const active = isActive(pathname, link.href);
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        aria-current={active ? 'page' : undefined}
                        className={cn(
                          'flex min-h-tap flex-col items-center justify-center gap-1 rounded-[var(--radius)] py-3 text-[11px] font-medium transition-colors',
                          active
                            ? 'bg-[rgb(var(--accent))]/15 text-[rgb(var(--accent))]'
                            : 'text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))]',
                        )}
                      >
                        <span aria-hidden="true" className="text-lg leading-none">
                          {link.icon}
                        </span>
                        <span className="text-center leading-none">{link.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </Sheet>

        <CommandPalette />
        <NotificationToasts />
      </ToastProvider>
    </NotificationProvider>
  );
}
