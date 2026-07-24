'use client';

// Mission Control's dismissible first-run activation checklist — the
// in-dashboard counterpart to the CLI quickstart panel. Walks a brand-new
// tenant through connect-a-repo → describe-an-app/queue-a-task → watch the
// off-hours runner → review & approve, with each step's done-state driven by
// live counts (see lib/onboarding-checklist.ts). Retires itself once the loop
// completes once, and can be dismissed early — same localStorage pattern as
// <PushOnboardCard> so it never nags a returning operator.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Card } from '@/components/ui/card';
import { isOnboardingComplete, nextOnboardingStep, type OnboardingStep } from '@/lib/onboarding-checklist';

const DISMISS_KEY = 'myai:onboarding:checklist:v1:dismissed';

export function OnboardingChecklist({ steps }: { steps: OnboardingStep[] }) {
  // Start hidden so SSR/hydration never flashes the card before we know the
  // dismissal state; a mount effect reveals it when appropriate.
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    try {
      setDismissed(window.localStorage.getItem(DISMISS_KEY) === '1');
    } catch {
      setDismissed(false);
    }
    setMounted(true);
  }, []);

  const dismiss = useCallback(() => {
    try {
      window.localStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private-mode / storage-disabled — dismissal just doesn't persist */
    }
    setDismissed(true);
  }, []);

  if (!mounted || dismissed || isOnboardingComplete(steps)) return null;

  const doneCount = steps.filter((s) => s.done).length;
  const next = nextOnboardingStep(steps);

  return (
    <div data-testid="onboarding-checklist">
      <Card accent="emerald" title="Get started" meta={`${doneCount}/${steps.length} done`}>
        <div className="p-4 space-y-3">
          <ol className="space-y-2.5">
            {steps.map((s, i) => (
              <li key={s.id} className="flex items-start gap-3">
                <span
                  aria-hidden
                  className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold ${
                    s.done
                      ? 'bg-emerald-500/20 border-emerald-500/50 text-emerald-400'
                      : s.id === next?.id
                        ? 'border-teal-500/60 text-teal-300'
                        : 'border-zinc-700 text-zinc-600'
                  }`}
                >
                  {s.done ? '✓' : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <p className={`text-sm ${s.done ? 'text-zinc-500 line-through decoration-zinc-700' : 'text-zinc-200'}`}>
                    {s.label}
                  </p>
                  <p className="text-xs text-zinc-500 mt-0.5">{s.desc}</p>
                </div>
                {s.id === next?.id && (
                  <Link
                    href={s.href}
                    className="shrink-0 gel-brand px-2.5 py-1 rounded-md text-xs font-medium text-teal-100 hover:brightness-110 transition whitespace-nowrap"
                    data-testid={`onboarding-cta-${s.id}`}
                  >
                    {s.cta} →
                  </Link>
                )}
              </li>
            ))}
          </ol>
          <div className="flex items-center justify-end pt-1 border-t border-zinc-800/70">
            <button
              type="button"
              onClick={dismiss}
              className="text-xs text-zinc-500 hover:text-zinc-300 transition"
              data-testid="onboarding-checklist-dismiss"
            >
              Dismiss
            </button>
          </div>
        </div>
      </Card>
    </div>
  );
}
