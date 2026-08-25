'use client';

// CoachMarks — the "SHOWS you where" counterpart to <OnboardingChecklist>'s
// "tells you what". Floats a single arrow-callout next to whichever checklist
// CTA is live right now (data-testid="onboarding-cta-<step>", rendered by
// onboarding-checklist.tsx), walking a first-time operator through connect a
// repo -> queue a task -> watch the runner one live target at a time — the
// spotlight simply follows the checklist's own "next" step as it progresses,
// so there is nothing to keep in sync by hand.
//
// Dismissible (permanently, via localStorage — same pattern as
// <OnboardingChecklist>'s own dismiss and <ProductTour>'s "seen" flag) and it
// retires itself on its own once the three-step walk completes, even without
// an explicit dismiss.

import { useCallback, useEffect, useState } from 'react';
import { COACH_MARK_COPY, nextCoachMarkStep, shouldShowCoachMark } from '@/lib/coach-marks';
import type { OnboardingStep } from '@/lib/onboarding-checklist';

const DISMISS_KEY = 'myai:coachmarks:v1:dismissed';

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function measure(id: string): Rect | null {
  const el = document.querySelector(`[data-testid="onboarding-cta-${id}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

export function CoachMarks({ steps }: { steps: OnboardingStep[] }) {
  const [mounted, setMounted] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [rect, setRect] = useState<Rect | null>(null);

  const target = nextCoachMarkStep(steps);

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

  // Track the live target's position so the callout follows it across
  // resizes, scrolls, and the layout shifts as the checklist re-renders
  // between steps (the target testid changes identity each time).
  useEffect(() => {
    if (!mounted || dismissed || !target) {
      setRect(null);
      return;
    }
    const update = () => setRect(measure(target.id));
    update();
    window.addEventListener('resize', update);
    window.addEventListener('scroll', update, true);
    // Layout can shift after mount (fonts, async card content) without firing
    // resize/scroll — a short-lived poll catches that without pulling in an
    // observer dependency for a handful of cheap reads.
    const poll = window.setInterval(update, 400);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
      window.clearInterval(poll);
    };
  }, [mounted, dismissed, target]);

  if (!mounted || !shouldShowCoachMark(steps, dismissed) || !target || !rect) return null;

  const copy = COACH_MARK_COPY[target.id as 'connect' | 'describe' | 'watch'];
  const top = rect.top + rect.height + 10;
  const left = Math.max(12, Math.min(rect.left, window.innerWidth - 288 - 12));

  return (
    <div data-testid="coach-mark" data-coach-step={target.id}>
      {/* spotlight ring around the live target */}
      <div
        aria-hidden
        className="fixed z-[90] rounded-lg ring-2 ring-teal-400/80 ring-offset-2 ring-offset-[rgb(var(--bg-page))] pointer-events-none animate-pulse"
        style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }}
      />
      {/* arrow callout */}
      <div
        className="fixed z-[91] w-72 gel-surface rounded-xl border border-teal-500/50 p-3.5 shadow-2xl"
        style={{ top, left }}
        role="tooltip"
        data-testid="coach-mark-callout"
      >
        <div
          aria-hidden
          className="absolute -top-1.5 left-6 h-3 w-3 rotate-45 border-l border-t border-teal-500/50 bg-[rgb(var(--bg-surface))]"
        />
        <p className="text-xs font-semibold text-teal-300">{copy.title}</p>
        <p className="mt-1 text-xs leading-relaxed text-[rgb(var(--text-secondary))]">{copy.body}</p>
        <div className="mt-2.5 flex items-center justify-end">
          <button
            type="button"
            onClick={dismiss}
            className="text-[11px] text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] transition"
            data-testid="coach-mark-dismiss"
          >
            Got it, dismiss tour
          </button>
        </div>
      </div>
    </div>
  );
}
