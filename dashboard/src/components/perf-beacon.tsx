'use client';

// Records how fast the dashboard feels in the operator's real browser (speed
// plan step 0): Web Vitals on hard loads, and NAV = click → new route painted
// for in-app (soft) navigations, which Web Vitals does not cover. Batched to
// /api/perf; flushed every 10 s and when the tab is hidden (sendBeacon).
// Mounted only on the operator chrome path (app-shell.tsx).
import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useReportWebVitals } from 'next/web-vitals';

type Pending = { route: string; metric: string; value: number; vw: number; nav: 'hard' | 'soft' };

const queue: Pending[] = [];

function flush() {
  if (!queue.length) return;
  const body = JSON.stringify(queue.splice(0, queue.length));
  try {
    if (!navigator.sendBeacon?.('/api/perf', body)) {
      void fetch('/api/perf', { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  } catch {
    /* telemetry must never break the page */
  }
}

function push(metric: string, value: number, nav: 'hard' | 'soft', route?: string) {
  queue.push({
    route: route ?? window.location.pathname + window.location.search,
    metric,
    value,
    vw: window.innerWidth,
    nav,
  });
  if (queue.length >= 20) flush();
}

export function PerfBeacon() {
  const pathname = usePathname();
  const search = useSearchParams();
  const pendingNav = useRef<{ t0: number; href: string } | null>(null);

  useReportWebVitals((m) => {
    if (['TTFB', 'FCP', 'LCP', 'INP', 'CLS'].includes(m.name)) push(m.name, m.value, 'hard');
  });

  // Start the clock on the click (capture phase, before Next's Link handler).
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!a || a.target === '_blank' || a.origin !== window.location.origin) return;
      const href = a.pathname + a.search;
      if (href === window.location.pathname + window.location.search) return;
      pendingNav.current = { t0: performance.now(), href };
    };
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('click', onClick, true);
    document.addEventListener('visibilitychange', onHide);
    const timer = window.setInterval(flush, 10_000);
    return () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('visibilitychange', onHide);
      window.clearInterval(timer);
      flush();
    };
  }, []);

  // Stop it once the new route has committed AND painted (two frames).
  useEffect(() => {
    const p = pendingNav.current;
    if (!p) return;
    pendingNav.current = null;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => push('NAV', performance.now() - p.t0, 'soft', p.href)),
    );
  }, [pathname, search]);

  return null;
}
