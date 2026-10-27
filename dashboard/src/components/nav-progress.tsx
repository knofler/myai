'use client';

// Thin top progress bar for in-app navigation. The per-route loading.tsx
// skeletons were removed (speed plan step 1, 2026-10-04): with a fallback on
// screen React 19 holds the real content back to batch reveals, so EVERY click
// cost a flat ~300 ms even when the data arrived in ~50 ms. Without them the
// old page stays up until the new one is ready — this bar is the feedback for
// the rare slow route. It appears only if a navigation is still pending after
// 150 ms, so fast clicks never flash it.
import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

const SHOW_AFTER_MS = 150;
const GIVE_UP_MS = 15_000;

export function NavProgress() {
  const pathname = usePathname();
  const search = useSearchParams();
  const [visible, setVisible] = useState(false);
  const timers = useRef<number[]>([]);

  const clear = () => {
    timers.current.forEach((t) => window.clearTimeout(t));
    timers.current = [];
  };

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.origin !== window.location.origin) return;
      if (a.pathname + a.search === window.location.pathname + window.location.search) return;
      clear();
      timers.current.push(
        window.setTimeout(() => setVisible(true), SHOW_AFTER_MS),
        window.setTimeout(() => setVisible(false), GIVE_UP_MS),
      );
    };
    document.addEventListener('click', onClick, true);
    return () => {
      document.removeEventListener('click', onClick, true);
      clear();
    };
  }, []);

  // The new route committed — done.
  useEffect(() => {
    clear();
    setVisible(false);
  }, [pathname, search]);

  if (!visible) return null;
  return (
    <div
      role="progressbar"
      aria-label="Loading page"
      data-testid="nav-progress"
      className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5 overflow-hidden bg-teal-500/20"
    >
      <div className="h-full w-1/3 animate-[nav-progress_1s_ease-in-out_infinite] bg-teal-500" />
    </div>
  );
}
