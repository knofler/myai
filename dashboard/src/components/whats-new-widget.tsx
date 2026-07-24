'use client';

// "What's new" widget — in-app changelog feed to drive re-engagement.
// Fetches recent CHANGELOG.md releases from /api/changelog and tracks which
// version the user has last seen in localStorage, badging unseen releases.
// Mirrors notification-bell.tsx's dropdown shell/interaction pattern.

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import type { ChangelogRelease } from '@/lib/changelog';

const LAST_SEEN_KEY = 'myai:whatsnew:lastSeenVersion';

function readLastSeen(): string | null {
  try {
    return localStorage.getItem(LAST_SEEN_KEY);
  } catch {
    return null; // localStorage unavailable (SSR, privacy mode) — degrade to "nothing seen"
  }
}

function writeLastSeen(version: string): void {
  try {
    localStorage.setItem(LAST_SEEN_KEY, version);
  } catch {
    // best-effort — a failed write just means the badge reappears next load
  }
}

/** Releases strictly newer than the last-seen version (list is newest-first). */
function unseenCount(releases: ChangelogRelease[], lastSeen: string | null): number {
  if (!lastSeen) return releases.length;
  const idx = releases.findIndex((r) => r.version === lastSeen);
  return idx === -1 ? releases.length : idx;
}

export function WhatsNewWidget() {
  const [releases, setReleases] = useState<ChangelogRelease[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/changelog?limit=8')
      .then((res) => (res.ok ? res.json() : { releases: [] }))
      .then((data: { releases?: ChangelogRelease[] }) => {
        if (cancelled) return;
        const list = data.releases ?? [];
        setReleases(list);
        setUnread(unseenCount(list, readLastSeen()));
      })
      .catch(() => {
        if (!cancelled) setReleases([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggle = () => {
    setOpen((o) => {
      const next = !o;
      if (next && releases[0]) {
        writeLastSeen(releases[0].version);
        setUnread(0);
      }
      return next;
    });
  };

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={`What's new${unread > 0 ? ` (${unread} new)` : ''}`}
        aria-expanded={open}
        onClick={toggle}
        className="relative flex items-center justify-center w-9 h-9 rounded-lg border border-zinc-800 text-zinc-300 hover:text-teal-300 hover:border-zinc-700 transition-colors active:scale-95"
      >
        <span className="text-base leading-none">🎁</span>
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[1.1rem] h-[1.1rem] px-1 flex items-center justify-center rounded-full bg-brand-orange text-[10px] font-bold text-zinc-950">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 max-w-[90vw] z-[60] rounded-xl border border-zinc-800 bg-zinc-900/98 backdrop-blur shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-800">
            <span className="text-sm font-semibold text-zinc-200">What&rsquo;s new</span>
          </div>

          <div className="max-h-96 overflow-y-auto divide-y divide-zinc-800/70">
            {releases.length === 0 ? (
              <div className="px-4 py-8 text-center text-xs text-zinc-500">
                No release notes yet.
              </div>
            ) : (
              releases.map((r) => (
                <div key={r.version} className="px-4 py-3 hover:bg-zinc-800/40 transition-colors">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-zinc-200">v{r.version}</span>
                    {r.date && <span className="text-[10px] text-zinc-500">{r.date}</span>}
                  </div>
                  <ul className="mt-1.5 space-y-1">
                    {r.sections.flatMap((s) => s.items).slice(0, 4).map((item, i) => (
                      <li key={i} className="text-[11px] text-zinc-400 leading-snug line-clamp-2">
                        {item}
                      </li>
                    ))}
                  </ul>
                </div>
              ))
            )}
          </div>

          <Link
            href="https://github.com/knofler/myai/blob/main/CHANGELOG.md"
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => setOpen(false)}
            className="block px-4 py-2.5 text-center text-[11px] text-zinc-400 hover:text-teal-300 border-t border-zinc-800 transition-colors"
          >
            Full changelog →
          </Link>
        </div>
      )}
    </div>
  );
}
