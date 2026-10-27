'use client';

// DemoGuide (GRAND_PRODUCT §7.4) — the floating guided-tour card shown only on
// the hosted read-only demo (NEXT_PUBLIC_DEMO_MODE=true), walking a prospect
// through the seeded idea→app→schedule→ops→support loop stop by stop.
//
// Stateless by design: the current stop is derived from the pathname, so the
// guide survives any navigation (sidebar clicks included) and needs no stored
// progress. The only persisted bit is the per-visit dismiss flag in
// sessionStorage — a fresh visit gets a fresh tour (reset-on-load). Stop
// navigation uses plain anchors like DemoBanner; a full page load per stop is
// fine for a demo and keeps this component dependency-free.

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';
import { DEMO_MODE, DEMO_INSTALL_URL } from '@/lib/demo';
import {
  DEMO_GUIDE_STOPS,
  DEMO_GUIDE_DISMISS_KEY,
  stopIndexForPath,
  isLastStop,
} from '@/lib/demo-guide';

export function DemoGuide() {
  const pathname = usePathname();
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(DEMO_GUIDE_DISMISS_KEY) === '1') setHidden(true);
    } catch {
      // sessionStorage unavailable (privacy mode) — keep the guide visible.
    }
  }, []);

  if (!DEMO_MODE || hidden) return null;

  const matched = stopIndexForPath(pathname ?? '');
  // Off the tour path (e.g. the landing page): invite the visitor to stop 1.
  const index = matched === -1 ? 0 : matched;
  const stop = DEMO_GUIDE_STOPS[index];
  const onStop = matched !== -1;
  const prev = index > 0 ? DEMO_GUIDE_STOPS[index - 1] : undefined;
  const next = !isLastStop(index) ? DEMO_GUIDE_STOPS[index + 1] : undefined;

  const dismiss = () => {
    setHidden(true);
    try {
      sessionStorage.setItem(DEMO_GUIDE_DISMISS_KEY, '1');
    } catch {
      // Best-effort — worst case the guide reappears on the next page.
    }
  };

  return (
    <aside
      aria-label="Guided demo tour"
      data-testid="demo-guide"
      className="fixed bottom-16 right-4 z-50 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-amber-500/30 bg-[rgb(var(--bg-surface))]/95 p-4 shadow-lg backdrop-blur"
    >
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
          {onStop
            ? `Guided tour · ${stop.eyebrow} · stop ${index + 1} of ${DEMO_GUIDE_STOPS.length}`
            : 'Guided tour'}
        </p>
        <button
          type="button"
          onClick={dismiss}
          data-testid="demo-guide-dismiss"
          className="rounded px-1 text-xs text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))]"
          aria-label="Hide the guided tour for this visit"
        >
          Hide
        </button>
      </div>

      {onStop ? (
        <>
          <h2 className="mt-2 text-sm font-semibold text-[rgb(var(--text-primary))]">{stop.title}</h2>
          <p className="mt-1 text-sm text-[rgb(var(--text-secondary))]">{stop.body}</p>
        </>
      ) : (
        <>
          <h2 className="mt-2 text-sm font-semibold text-[rgb(var(--text-primary))]">
            See the whole loop in five stops.
          </h2>
          <p className="mt-1 text-sm text-[rgb(var(--text-secondary))]">
            Idea → app → schedule → ops → support, on real seeded data. No sign-up, nothing you
            click changes anything.
          </p>
        </>
      )}

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="flex gap-1" aria-hidden>
          {DEMO_GUIDE_STOPS.map((s, i) => (
            <span
              key={s.id}
              className={`h-1.5 w-1.5 rounded-full ${
                onStop && i === index ? 'bg-amber-400' : 'bg-[rgb(var(--text-secondary))]/30'
              }`}
            />
          ))}
        </div>
        <div className="flex items-center gap-2">
          {onStop && prev && (
            <a
              href={prev.href}
              data-testid="demo-guide-back"
              className="rounded-md px-2 py-1 text-xs text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))]"
            >
              ← Back
            </a>
          )}
          {onStop && next && (
            <a
              href={next.href}
              data-testid="demo-guide-next"
              className="rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 transition-colors hover:bg-amber-400"
            >
              Next: {next.eyebrow} →
            </a>
          )}
          {onStop && !next && (
            <a
              href={DEMO_INSTALL_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="demo-guide-cta"
              className="rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 transition-colors hover:bg-amber-400"
            >
              Get myAI →
            </a>
          )}
          {!onStop && (
            <a
              href={DEMO_GUIDE_STOPS[0].href}
              data-testid="demo-guide-start"
              className="rounded-md bg-amber-500 px-3 py-1 text-xs font-medium text-zinc-950 transition-colors hover:bg-amber-400"
            >
              Start the tour →
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}
