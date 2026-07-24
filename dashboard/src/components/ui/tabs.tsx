// URL-driven tab bar (server component) — the active tab lives in ?tab=,
// so tabs are deep-linkable, persisted, and redirect targets.

import Link from 'next/link';

export interface TabDef {
  id: string;
  label: string;
  count?: number;
}

// `prefetch` fully prefetches every sibling tab's RSC payload into the router
// cache, making tab taps a pure client-side swap (zero server round-trip).
// Only enable it on pages whose tab data is server-cached and near-static
// (e.g. /registry): live pages run their Atlas queries per prefetch, and their
// 15s AutoRefresh clears the router cache — full prefetch there re-fires every
// tab's queries every refresh cycle per open client.
export function TabBar({ base, tabs, active, prefetch, params }: { base: string; tabs: TabDef[]; active: string; prefetch?: boolean; params?: Record<string, string | undefined> }) {
  // Preserve cross-tab query state (e.g. /work's ?repo= filter) on every tab link.
  const extra = Object.entries(params ?? {}).filter(([, v]) => v != null && v !== '') as [string, string][];
  const hrefFor = (id: string) => {
    const qs = new URLSearchParams();
    if (id !== tabs[0].id) qs.set('tab', id);
    for (const [k, v] of extra) qs.set(k, v);
    const s = qs.toString();
    return s ? `${base}?${s}` : base;
  };
  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-zinc-800 -mb-px">
      {tabs.map((t) => {
        const isActive = t.id === active;
        return (
          <Link
            key={t.id}
            href={hrefFor(t.id)}
            prefetch={prefetch}
            className={`px-4 py-2.5 text-sm border-b-2 transition-[color,border-color,transform] duration-150 active:scale-[0.96] ${
              isActive
                ? 'border-teal-400 text-zinc-100 font-medium'
                : 'border-transparent text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t.label}
            {t.count !== undefined && (
              <span className={`ml-2 text-xs px-1.5 py-0.5 rounded-full ${isActive ? 'gel-badge bg-teal-500/15 text-teal-300' : 'bg-zinc-800 text-zinc-500'}`}>
                {t.count}
              </span>
            )}
          </Link>
        );
      })}
    </div>
  );
}

/** Resolve the active tab id from searchParams, falling back to the first tab. */
export function resolveTab(tabs: TabDef[], requested?: string): string {
  return tabs.some((t) => t.id === requested) ? (requested as string) : tabs[0].id;
}
