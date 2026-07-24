// DemoBanner (GO_LIVE_PLAN P2 item 14) — shown only on the hosted read-only
// demo deployment (NEXT_PUBLIC_DEMO_MODE=true). Fixed to the bottom edge so
// it never disturbs the sidebar/main flex row, always visible while a launch
// visitor clicks around, with the install CTA one tap away. Server component
// — the flag is inlined at build time, no client JS needed.

import { DEMO_MODE, DEMO_INSTALL_URL } from '@/lib/demo';

export function DemoBanner() {
  if (!DEMO_MODE) return null;

  return (
    <div className="fixed bottom-0 inset-x-0 z-50 border-t border-amber-500/30 bg-zinc-900/95 backdrop-blur px-4 py-2.5 pb-[max(0.625rem,env(safe-area-inset-bottom))]">
      <div className="mx-auto flex max-w-4xl items-center justify-center gap-3 text-sm">
        <span className="hidden sm:inline text-amber-400" aria-hidden>
          ●
        </span>
        <p className="text-zinc-300">
          <span className="font-semibold text-amber-400">Read-only demo</span>
          <span className="hidden sm:inline">
            {' '}
            — you&apos;re browsing a seeded myAI workspace. Writes are disabled.
          </span>
        </p>
        <a
          href={DEMO_INSTALL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 rounded-md bg-amber-500 px-3 py-1 font-medium text-zinc-950 transition-colors hover:bg-amber-400"
        >
          Install myAI →
        </a>
      </div>
    </div>
  );
}
