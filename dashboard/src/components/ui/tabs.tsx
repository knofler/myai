// URL-driven tab bar (server component) — the active tab lives in ?tab=,
// so tabs are deep-linkable, persisted, and redirect targets.
//
// Mobile (operator, 2026-09-18: "work is too tiny for the mobile, need less
// info, more easily readable"): nine tabs wrapped into five rows and ate half
// the phone screen. With `primary={n}` the first n tabs stay visible on a phone
// and the rest fold into a "More" menu (the Operate mockup shows exactly three:
// Up Next / Running / Needs You). If the ACTIVE tab is one of the folded ones
// it is promoted to the FRONT of the row so the user always sees where they
// are — as a trailing fourth tab it scrolled past the right edge at 375px and
// showed only its first letter (G8, 2026-10-22).
// Desktop is unchanged — every tab in one row.

import Link from 'next/link';

export interface TabDef {
  id: string;
  label: string;
  count?: number;
}

function buildHref(base: string, tabs: TabDef[], extra: [string, string][], id: string): string {
  const qs = new URLSearchParams();
  if (id !== tabs[0].id) qs.set('tab', id);
  for (const [k, v] of extra) qs.set(k, v);
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

function TabLink({ t, href, isActive, prefetch }: { t: TabDef; href: string; isActive: boolean; prefetch?: boolean }) {
  return (
    <Link
      href={href}
      prefetch={prefetch}
      aria-current={isActive ? 'page' : undefined}
      className={`shrink-0 whitespace-nowrap px-2 md:px-4 py-2.5 text-sm border-b-2 transition-[color,border-color,transform] duration-150 active:scale-[0.96] ${
        isActive
          ? 'border-teal-400 text-[rgb(var(--text-primary))] font-medium'
          : 'border-transparent text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]'
      }`}
    >
      {t.label}
      {t.count !== undefined && (
        <span className={`ml-1.5 md:ml-2 text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'gel-badge bg-teal-500/15 text-teal-300' : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]'}`}>
          {t.count}
        </span>
      )}
    </Link>
  );
}

// `prefetch` fully prefetches every sibling tab's RSC payload into the router
// cache, making tab taps a pure client-side swap (zero server round-trip).
// Only enable it on pages whose tab data is server-cached and near-static
// (e.g. /registry): live pages run their Atlas queries per prefetch, and their
// 15s AutoRefresh clears the router cache — full prefetch there re-fires every
// tab's queries every refresh cycle per open client.
export function TabBar({
  base,
  tabs,
  active,
  prefetch,
  params,
  primary,
}: {
  base: string;
  tabs: TabDef[];
  active: string;
  prefetch?: boolean;
  params?: Record<string, string | undefined>;
  /** Number of tabs kept visible on a phone; the rest fold into "More". Omit to show all. */
  primary?: number;
}) {
  // Preserve cross-tab query state (e.g. /work's ?repo= filter) on every tab link.
  const extra = Object.entries(params ?? {}).filter(([, v]) => v != null && v !== '') as [string, string][];
  const hrefFor = (id: string) => buildHref(base, tabs, extra, id);

  const fold = primary != null && primary > 0 && primary < tabs.length;
  const visible = fold ? tabs.slice(0, primary) : tabs;
  const folded = fold ? tabs.slice(primary) : [];
  const activeFolded = folded.find((t) => t.id === active);
  const foldedCount = folded.reduce((sum, t) => sum + (t.count ?? 0), 0);

  return (
    <>
      {/* Phone: primary tabs + "More" menu. Rendered ONLY when folding is on —
          otherwise this tree would emit every tab link a second time (hidden)
          and every bar in the app would ship its tabs twice. */}
      {fold && (
      <div className="flex md:hidden items-center gap-0 overflow-x-auto border-b border-[rgb(var(--border-subtle))] -mb-px">
        {activeFolded && (
          <TabLink t={activeFolded} href={hrefFor(activeFolded.id)} isActive prefetch={prefetch} />
        )}
        {visible.map((t) => (
          <TabLink key={t.id} t={t} href={hrefFor(t.id)} isActive={t.id === active} prefetch={prefetch} />
        ))}
        {folded.length > 0 && (
          // Pinned to the right edge so it stays reachable while the tab row scrolls.
          <details className="sticky right-0 ml-auto shrink-0 bg-[rgb(var(--bg-canvas))]">
            <summary
              aria-label={`More tabs${foldedCount > 0 ? ` (${foldedCount})` : ''}`}
              title="More tabs"
              className="relative flex min-h-tap cursor-pointer select-none items-center whitespace-nowrap px-3 text-sm text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] list-none [&::-webkit-details-marker]:hidden"
            >
              <span aria-hidden="true" className="text-lg leading-none">⋯</span>
            </summary>
            <div className="absolute right-0 z-20 mt-1 min-w-[13rem] rounded-xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))] p-1 shadow-lg">
              {folded.map((t) => {
                const isActive = t.id === active;
                return (
                  <Link
                    key={t.id}
                    href={hrefFor(t.id)}
                    prefetch={prefetch}
                    aria-current={isActive ? 'page' : undefined}
                    className={`flex min-h-tap items-center justify-between gap-3 rounded-lg px-3 text-sm ${
                      isActive ? 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-primary))] font-medium' : 'text-[rgb(var(--text-secondary))] hover:bg-[rgb(var(--bg-hover))] hover:text-[rgb(var(--text-primary))]'
                    }`}
                  >
                    {t.label}
                    {t.count !== undefined && (
                      <span className="text-xs px-1.5 py-0.5 rounded-full bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]">{t.count}</span>
                    )}
                  </Link>
                );
              })}
            </div>
          </details>
        )}
      </div>
      )}

      {/* Desktop (or any bar without `primary`): every tab, one row. */}
      <div className={`${fold ? 'hidden md:flex' : 'flex'} flex-wrap items-center gap-1 border-b border-[rgb(var(--border-subtle))] -mb-px`}>
        {tabs.map((t) => (
          <TabLink key={t.id} t={t} href={hrefFor(t.id)} isActive={t.id === active} prefetch={prefetch} />
        ))}
      </div>
    </>
  );
}

/** Resolve the active tab id from searchParams, falling back to the first tab. */
export function resolveTab(tabs: TabDef[], requested?: string): string {
  return tabs.some((t) => t.id === requested) ? (requested as string) : tabs[0].id;
}
