'use client';

// Global action sheet — the one place to do anything (mockup screen 10,
// plan/design/mockups/10-global-action.png). Opened by the centre [+] in the
// mobile bar and by any surface that dispatches GLOBAL_ACTION_EVENT. Six rows,
// each an existing route (lib/nav-v2.ts GLOBAL_ACTIONS); the sheet adds an
// entry point, never a capability.

import Link from 'next/link';
import { Sheet } from '@/components/ui/sheet';
import { GLOBAL_ACTIONS } from '@/lib/nav-v2';

export function GlobalActionSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Sheet id="global-action-sheet" open={open} onClose={onClose} side="bottom" title="What would you like to do?">
      <ul className="space-y-1 p-3">
        {GLOBAL_ACTIONS.map((a) => (
          <li key={a.label}>
            <Link
              href={a.href}
              onClick={onClose}
              className="flex min-h-tap items-center gap-3 rounded-xl px-2 py-2 transition-colors hover:bg-[rgb(var(--bg-hover))]"
            >
              <span
                aria-hidden="true"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[rgb(var(--bg-surface))] text-base text-[rgb(var(--text-primary))]"
              >
                {a.icon}
              </span>
              <span className="min-w-0">
                <span className="block text-body font-medium text-[rgb(var(--text-primary))]">{a.label}</span>
                <span className="block text-meta text-[rgb(var(--text-secondary))]">{a.hint}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
      <div className="p-3 pt-0">
        <button
          type="button"
          onClick={onClose}
          className="flex min-h-tap w-full items-center justify-center rounded-xl bg-[rgb(var(--bg-surface))] text-meta font-medium text-[rgb(var(--text-secondary))] transition-colors hover:text-[rgb(var(--text-primary))]"
        >
          Cancel
        </button>
      </div>
    </Sheet>
  );
}
