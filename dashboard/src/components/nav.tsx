'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { TenantSwitcher } from '@/components/tenant-switcher';
import { NotificationBell } from '@/components/notification-bell';
import { WhatsNewWidget } from '@/components/whats-new-widget';
import { ThemeToggle } from '@/components/theme-toggle';
import { LocaleSwitcher } from '@/components/locale-switcher';
import {
  NAV_GROUPS,
  MOBILE_LINKS,
  isActive,
  readStoredOpenGroups,
  writeStoredOpenGroups,
  resolveOpenGroups,
  withActiveGroupOpen,
  toggleGroup,
  defaultOpenGroups,
  type OpenGroupState,
} from '@/lib/nav-groups';

export function Nav() {
  const pathname = usePathname();
  const t = useTranslations('nav');
  const [open, setOpen] = useState(false);
  // Same-pathname default on server + first client render (no localStorage
  // access yet) avoids a hydration mismatch; the stored preference is layered
  // on right after mount in the effect below.
  const [openGroups, setOpenGroups] = useState<OpenGroupState>(() => defaultOpenGroups(pathname));
  const [hydrated, setHydrated] = useState(false);

  // Close the drawer whenever the route changes (mobile tap-through).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Layer the persisted per-group open/closed preference over the
  // current-route default once the browser is available.
  useEffect(() => {
    setOpenGroups(resolveOpenGroups(readStoredOpenGroups(window.localStorage), pathname));
    setHydrated(true);
    // Only ever needs the localStorage snapshot from first mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // On every subsequent navigation, make sure the section holding the new
  // active route is expanded — a collapsed section must never hide the page
  // you're currently on.
  useEffect(() => {
    if (!hydrated) return;
    setOpenGroups((prev) => withActiveGroupOpen(prev, pathname));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname, hydrated]);

  function handleToggleGroup(groupId: string) {
    setOpenGroups((prev) => {
      const next = toggleGroup(prev, groupId);
      writeStoredOpenGroups(window.localStorage, next);
      return next;
    });
  }

  return (
    <>
      {/* Mobile top bar with hamburger — only visible below md. In standalone
          (home-screen) mode the app draws under the iOS status bar
          (black-translucent + viewport-fit=cover), so the bar carries the
          safe-area inset as extra top padding and grows by the same amount. */}
      <div className="md:hidden fixed top-0 left-0 right-0 h-[calc(3rem+env(safe-area-inset-top))] pt-[env(safe-area-inset-top)] z-50 flex items-center gap-3 px-3 bg-[rgb(var(--bg-surface))]/95 backdrop-blur border-b border-[rgb(var(--border-subtle))]">
        <button
          aria-label={t('openNav')}
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className="gel-surface flex items-center justify-center w-9 h-9 rounded-lg border border-[rgb(var(--border-subtle))] text-[rgb(var(--accent-text))] active:scale-95 transition-transform"
        >
          <span className="text-base leading-none">☰</span>
        </button>
        <span className="text-sm font-bold tracking-tight text-brand-orange">
          myAI
        </span>
        <div className="ml-auto flex items-center gap-2">
          <WhatsNewWidget />
          <NotificationBell />
        </div>
      </div>

      {/* Backdrop — only on mobile when open */}
      {open && (
        <div
          className="md:hidden fixed inset-0 bg-black/60 z-50"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar / slide-in drawer */}
      <aside
        className={`fixed top-0 left-0 w-56 h-screen pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] bg-[rgb(var(--bg-surface))]/95 backdrop-blur border-r border-[rgb(var(--border-subtle))] flex flex-col z-50 transition-transform duration-200 ease-out md:translate-x-0 ${
          open ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="p-5 border-b border-[rgb(var(--border-subtle))] flex items-center justify-between gap-2">
          <div>
            <h1 className="text-lg font-bold tracking-tight text-brand-orange">myAI</h1>
            <p className="text-xs text-[rgb(var(--text-muted))] mt-0.5">{t('tagline')}</p>
          </div>
          <div className="flex items-center gap-2">
            {/* What's new + notification bell — desktop sidebar (mobile lives in the top bar) */}
            <span className="hidden md:flex items-center gap-2">
              <WhatsNewWidget />
              <NotificationBell />
            </span>
            {/* Close button — mobile only */}
            <button
              aria-label={t('closeNav')}
              onClick={() => setOpen(false)}
              className="md:hidden text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] text-lg leading-none"
            >
              ✕
            </button>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {NAV_GROUPS.map((group) => {
            const groupOpen = openGroups[group.id] ?? false;
            const groupActive = group.links.some((l) => isActive(pathname, l.href));
            const panelId = `nav-group-panel-${group.id}`;
            return (
              <div key={group.id}>
                <button
                  type="button"
                  aria-expanded={groupOpen}
                  aria-controls={panelId}
                  onClick={() => handleToggleGroup(group.id)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-[11px] font-semibold uppercase tracking-wider transition-colors duration-150 ${
                    groupActive ? 'text-[rgb(var(--accent-text))]' : 'text-[rgb(var(--text-muted))]'
                  } hover:text-[rgb(var(--text-primary))] hover:bg-[rgb(var(--bg-hover))]`}
                >
                  <span>{group.label}</span>
                  <span
                    aria-hidden="true"
                    className={`text-xs transition-transform duration-150 ${groupOpen ? 'rotate-90' : ''}`}
                  >
                    ›
                  </span>
                </button>
                {groupOpen && (
                  <div id={panelId} className="space-y-1 mt-0.5 mb-2">
                    {group.links.map(({ href, label, icon, hint }) => {
                      const active = isActive(pathname, href);
                      return (
                        <Link
                          key={href}
                          href={href}
                          aria-current={active ? 'page' : undefined}
                          className={`flex items-start gap-3 px-3 py-2.5 rounded-lg text-sm transition-[color,background-color,transform] duration-150 ease-out active:scale-[0.97] group ${
                            active
                              ? `gel-brand text-[rgb(var(--accent-text))]`
                              : 'text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))] hover:bg-[rgb(var(--bg-hover))] hover:translate-x-0.5'
                          }`}
                        >
                          <span className="w-4 text-center font-mono text-xs opacity-60 mt-0.5">{icon}</span>
                          <span className="min-w-0">
                            <span className="block">{label}</span>
                            <span className={`block text-[10px] mt-0.5 truncate ${active ? 'text-[rgb(var(--accent-text))]/70' : 'text-[rgb(var(--text-muted))]'}`}>{hint}</span>
                          </span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>
        <div className="p-4 border-t border-[rgb(var(--border-subtle))] space-y-2">
          <TenantSwitcher />
          <ThemeToggle />
          <LocaleSwitcher />
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('myai:tour:start'))}
            className="block w-full text-left text-[10px] text-[rgb(var(--text-muted))] hover:text-[rgb(var(--accent-text))] transition font-mono"
            data-testid="tour-replay"
          >
            {t('tourReplay')}
          </button>
          <p className="text-[10px] text-[rgb(var(--text-muted))] font-mono">{t('commandHint')}</p>
          <p className="text-[10px] text-[rgb(var(--text-muted))] font-mono">v0.2.0 / gateway :3200</p>
        </div>
      </aside>

      {/* Bottom tab bar — mobile only, the 6 destinations, thumb-reachable */}
      <nav
        aria-label={t('primary')}
        className="md:hidden fixed bottom-0 left-0 right-0 z-50 grid grid-cols-6 bg-[rgb(var(--bg-surface))]/95 backdrop-blur border-t border-[rgb(var(--border-subtle))] pb-[env(safe-area-inset-bottom)]"
      >
        {MOBILE_LINKS.map(({ href, short, icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`flex flex-col items-center justify-center gap-0.5 py-2 min-h-[3.25rem] text-[10px] font-medium transition-[color,transform] duration-100 ease-out active:scale-90 ${
                active ? 'text-[rgb(var(--accent-text))]' : 'text-[rgb(var(--text-muted))]'
              }`}
            >
              <span className={`text-base leading-none ${active ? 'drop-shadow-[0_0_6px_rgba(45,212,191,0.5)]' : ''}`}>{icon}</span>
              <span className="leading-none">{short}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}
