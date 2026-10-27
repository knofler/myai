'use client';

// AppShellV2 — the operator shell. Shipped behind NEXT_PUBLIC_UI_V2 in B1; the
// flag was removed in B6 (see app-shell.tsx) and this is now the operator
// chrome for every route that isn't full-bleed public/marketing/legal.
// Left rail of five operator jobs — Today · Swarm · Work · Brain · Settings —
// with the active section's pages expanded under it (collapsible 240→56px,
// keyboard-navigable); a top bar (breadcrumb, tenant switcher, ⌘K, theme
// toggle, brain badge); and a five-slot mobile bottom bar (Today / Swarm / [+] /
// Work / More — [+] opens the global action sheet, More holds Brain and
// Settings). No fixed mobile top bar and no --safe-top reserve — the two
// mobile-scroll hazards the brief calls out.
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
import { GlobalActionSheet } from '@/components/shell/global-action-sheet';
import {
  NAV_V2_GROUPS,
  HOME_LINK,
  MOBILE_BAR,
  GLOBAL_ACTION_EVENT,
  activeBarSlot,
  groupIdForPathname,
  isActive,
  moreMobileGroups,
  sectionHref,
  sectionLinksForPathname,
  type NavV2Group,
  type NavV2Link,
} from '@/lib/nav-v2';
import { cn } from '@/lib/utils';
import { BrandMark } from '@/components/brand-mark';

const COLLAPSE_KEY = 'myai.shell.v2.collapsed';

function breadcrumb(pathname: string): string {
  if (pathname === '/') return HOME_LINK.label;
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
  const [actionOpen, setActionOpen] = useState(false);
  const barSlot = activeBarSlot(pathname);

  // Restore the rail collapse preference after mount (server render is always
  // expanded, so no hydration mismatch).
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* private mode — in-memory default is fine */
    }
  }, []);

  // Close both sheets on navigation.
  useEffect(() => {
    setMoreOpen(false);
    setActionOpen(false);
  }, [pathname]);

  // Any surface (the Home ask bar's "More" chip, ⌘K, a coach mark) can open the
  // global action sheet without reaching into the shell.
  useEffect(() => {
    const open = () => setActionOpen(true);
    window.addEventListener(GLOBAL_ACTION_EVENT, open);
    return () => window.removeEventListener(GLOBAL_ACTION_EVENT, open);
  }, []);

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

  const moreGroups = moreMobileGroups();
  const sectionLinks = sectionLinksForPathname(pathname);
  const activeSection = groupIdForPathname(pathname);

  // One rail row, so section rows and their pages render (and collapse into a
  // tooltip) identically. A section row is current when any of its pages is.
  function railLink(link: NavV2Link, opts: { section?: NavV2Group; nested?: boolean } = {}) {
    const active = opts.section ? activeSection === opts.section.id : isActive(pathname, link.href);
    // An expanded section row is bold, not filled: its current page carries the
    // highlight, so the rail never shows two selected rows. Collapsed (or a
    // one-page section) the section row is the only marker, so it keeps it.
    const expanded = !!opts.section && active && !collapsed && opts.section.links.length > 1;
    const item = (
      <Link
        key={link.href}
        href={link.href}
        aria-current={active && !opts.section ? 'page' : undefined}
        className={cn(
          'flex items-center gap-3 rounded-[var(--radius)] px-2.5 py-2 text-sm transition-colors',
          opts.section && 'font-medium',
          opts.nested && 'py-1.5 pl-9 text-meta',
          collapsed && 'justify-center px-0',
          expanded
            ? 'font-semibold text-[rgb(var(--text-primary))] hover:bg-[rgb(var(--bg-hover))]'
            : active
            ? 'bg-[rgb(var(--accent))]/15 font-medium text-[rgb(var(--text-primary))]'
            : 'text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]',
        )}
      >
        {!opts.nested && (
          <span
            className={cn(
              'w-5 shrink-0 text-center font-mono text-base leading-none',
              active && 'text-[rgb(var(--accent))]',
            )}
            aria-hidden="true"
          >
            {link.icon}
          </span>
        )}
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
  }

  return (
    <NotificationProvider>
      <ToastProvider>
        {/* Keyboard/screen-reader users otherwise have to tab through the
            whole rail + top bar on every page — WCAG 2.4.1 Bypass Blocks. */}
        <a
          href="#main-content"
          className="fixed left-2 top-2 z-[100] -translate-y-16 rounded-md bg-[rgb(var(--accent))] px-4 py-2 text-sm font-medium text-[rgb(var(--accent-fg))] transition-transform focus:translate-y-0"
        >
          Skip to main content
        </a>
        {/* ── Desktop left rail (md+) ─────────────────────────────── */}
        <aside
          aria-label="Primary"
          className={cn(
            'hidden md:flex fixed inset-y-0 left-0 z-40 flex-col border-r border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-canvas))] transition-[width] duration-200 ease-out',
            collapsed ? 'w-14' : 'w-60',
          )}
        >
          <div className="flex h-14 shrink-0 items-center gap-2 border-b border-[rgb(var(--border-subtle))] px-3">
            <Link
              href="/"
              aria-label={HOME_LINK.label}
              className="rounded transition-opacity hover:opacity-80"
            >
              {/* Collapsed rail shows the badge alone — it stays recognisable
                  at 28px, which a lone letter never was. */}
              <BrandMark size={collapsed ? 30 : 28} withWordmark={!collapsed} />
            </Link>
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
            {/* Five section rows; the active one expands its pages beneath it
                (a section with a single page has nothing to expand). Collapsed,
                the rail is the five glyphs with tooltips. */}
            <ul className="space-y-0.5">
              {NAV_V2_GROUPS.map((group) => (
                <li key={group.id} className="space-y-0.5">
                  {railLink(
                    { href: sectionHref(group), label: group.label, icon: group.icon },
                    { section: group },
                  )}
                  {!collapsed && activeSection === group.id && group.links.length > 1 && (
                    <ul aria-label={`${group.label} pages`} className="space-y-0.5 pb-1">
                      {group.links.map((link) => (
                        <li key={link.href}>{railLink(link, { nested: true })}</li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </aside>

        {/* ── Content column ──────────────────────────────────────── */}
        <div className={cn('flex min-w-0 flex-1 flex-col', collapsed ? 'md:ml-14' : 'md:ml-60')}>
          {/* Top bar — sticky, no mobile fixed bar / no --safe-top reserve. */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-canvas))]/95 px-4 backdrop-blur">
            {/* The wordmark is the home affordance on mobile, where there is no
                rail and no hardware ⌘K. */}
            <Link
              href="/"
              aria-label={HOME_LINK.label}
              className="shrink-0 rounded transition-opacity hover:opacity-80 md:hidden"
            >
              <BrandMark size={26} withWordmark />
            </Link>
            {/* Shown on mobile too — a phone with no rail and no breadcrumb gave
                no indication of where you were. */}
            <nav aria-label="Breadcrumb" className="min-w-0">
              <span className="block truncate text-sm font-semibold text-[rgb(var(--text-primary))]">
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
              {/* The brain tour (/tour) — the operator's "most important part
                  of the app", so it is one tap away at every width. Replaying
                  the first-run overlay lives on /tour (ReplayAppTourButton). */}
              <Link
                href="/tour"
                data-testid="tour-link"
                aria-label="Brain tour"
                title="Brain tour"
                className="rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))] px-2 py-1.5 text-xs text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]"
              >
                Tour
              </Link>
              <NotificationBell />
              <TenantSwitcher />
              <ThemeToggle />
            </div>
          </header>

          {/* ── Mobile section strip (below md) ──────────────────────────
              A bar slot lands on its section's first page only, so the strip
              lists the active section's pages (Today: Status, Notifications;
              Swarm: Fleet, Runs, Logs; Work: Projects, Apps; Brain and
              Settings: every page) — without it those routes have no phone
              affordance. aria-label is "Section", not "Primary": the bottom
              bar owns the Primary landmark. */}
          {sectionLinks.length > 0 && (
            <nav
              aria-label="Section"
              className="nav-scroll sticky top-14 z-20 flex gap-1 overflow-x-auto overscroll-x-contain border-b border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-canvas))]/95 px-4 py-1.5 backdrop-blur md:hidden"
            >
              {sectionLinks.map((link) => {
                const active = isActive(pathname, link.href);
                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'flex min-h-tap shrink-0 items-center whitespace-nowrap rounded-full px-3 text-nav-label font-medium transition-colors',
                      active
                        ? 'bg-[rgb(var(--accent))]/15 text-[rgb(var(--accent))]'
                        : 'text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))]',
                    )}
                  >
                    {link.label}
                  </Link>
                );
              })}
            </nav>
          )}

          <main id="main-content" tabIndex={-1} className="min-w-0 flex-1 overflow-x-hidden p-4 pb-24 md:p-8 md:pb-8">
            {children}
          </main>
        </div>

        {/* ── Mobile bottom bar (below md) — Today / Swarm / [+] / Work / More.
            Five equal columns (375/5 = 75px ≥ the 64px floor). The centre [+] is
            a raised accent disc: it is the one action on the screen that is
            always available, so it is the one element allowed to sit above the
            bar. Teal on a slot = "you are here" (state), never "tap me". */}
        <nav
          aria-label="Primary"
          className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-canvas))]/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
        >
          {MOBILE_BAR.map((slot) => {
            if (slot.id === 'action') {
              return (
                <button
                  key={slot.id}
                  type="button"
                  aria-label={slot.label}
                  aria-expanded={actionOpen}
                  aria-controls="global-action-sheet"
                  onClick={() => setActionOpen(true)}
                  className="flex min-h-[3.25rem] items-center justify-center"
                >
                  <span
                    aria-hidden="true"
                    className="flex h-12 w-12 -translate-y-3 items-center justify-center rounded-full bg-[rgb(var(--accent))] text-2xl font-medium leading-none text-[rgb(var(--accent-fg))] shadow-[0_10px_28px_-8px_rgb(var(--accent)/0.7)] transition-transform active:scale-95"
                  >
                    {slot.icon}
                  </span>
                </button>
              );
            }
            if (slot.id === 'more') {
              return (
                <button
                  key={slot.id}
                  type="button"
                  aria-expanded={moreOpen}
                  aria-controls="mobile-more-sheet"
                  onClick={() => setMoreOpen(true)}
                  className={cn(
                    'flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 py-2 text-label font-medium transition-colors',
                    // Weight as well as colour marks the active slot (WCAG 1.4.1).
                    moreOpen || barSlot === 'more' ? 'font-semibold text-[rgb(var(--accent))]' : 'text-[rgb(var(--text-muted))]',
                  )}
                >
                  <span aria-hidden="true" className="text-base leading-none">
                    {slot.icon}
                  </span>
                  <span className="leading-none">{slot.label}</span>
                </button>
              );
            }
            const active = barSlot === slot.id;
            return (
              <Link
                key={slot.id}
                href={slot.href!}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'flex min-h-[3.25rem] flex-col items-center justify-center gap-0.5 py-2 text-label font-medium transition-colors',
                  active ? 'font-semibold text-[rgb(var(--accent))]' : 'text-[rgb(var(--text-muted))]',
                )}
              >
                <span aria-hidden="true" className="text-base leading-none">
                  {slot.icon}
                </span>
                <span className="leading-none">{slot.label}</span>
              </Link>
            );
          })}
        </nav>

        <GlobalActionSheet open={actionOpen} onClose={() => setActionOpen(false)} />

        {/* "More" sheet — every section without a primary slot (Brain, Settings). */}
        <Sheet id="mobile-more-sheet" open={moreOpen} onClose={() => setMoreOpen(false)} side="bottom" title="More">
          <div className="space-y-4 p-3">
            {moreGroups.map((group) => (
              <div key={group.id} className="space-y-1">
                <p className="px-1 text-label font-semibold uppercase tracking-wider text-[rgb(var(--text-muted))]">
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
                          'flex min-h-tap flex-col items-center justify-center gap-1 rounded-[var(--radius)] py-3 text-label font-medium transition-colors',
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
