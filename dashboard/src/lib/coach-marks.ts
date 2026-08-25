// Pure logic behind the coach-mark tour (dashboard/src/components/coach-marks.tsx).
//
// The onboarding checklist (lib/onboarding-checklist.ts) already tells a
// first-time operator WHAT to do next; this module decides WHICH single live
// checklist step the coach mark should point an arrow at, and derives the copy
// for it. Kept hermetic (no DOM) so it's unit-testable — the React shell reads
// the DOM position of the target's existing `data-testid="onboarding-cta-*"`
// element and floats a callout next to it.

import type { OnboardingStep } from './onboarding-checklist';

/** Only the first three activation steps get a coach mark — "approve" is a
 * later-lifecycle action (reviewing a finished diff), not part of the guided
 * first-run walk (connect a repo -> queue a task -> watch the runner). */
const COACH_MARK_STEP_IDS: ReadonlyArray<OnboardingStep['id']> = ['connect', 'describe', 'watch'];

export interface CoachMarkCopy {
  title: string;
  body: string;
}

export const COACH_MARK_COPY: Record<'connect' | 'describe' | 'watch', CoachMarkCopy> = {
  connect: {
    title: 'Start here',
    body: 'Point myAI at a repo — everything else in the tour lights up once one exists.',
  },
  describe: {
    title: 'Now queue something',
    body: 'Describe an app or task here — it drops straight into the runner’s queue.',
  },
  watch: {
    title: 'Watch it get picked up',
    body: 'The off-hours runner claims queued work on its next free window — this is where you’ll see it happen.',
  },
};

/**
 * The single step the coach mark should spotlight, or undefined once the
 * three-step activation walk is done (or was never reachable, e.g. the
 * checklist itself is already fully complete). Mirrors `nextOnboardingStep`
 * but scoped to the coach-markable subset.
 */
export function nextCoachMarkStep(steps: OnboardingStep[]): OnboardingStep | undefined {
  return steps.find((s) => COACH_MARK_STEP_IDS.includes(s.id) && !s.done);
}

/** Whether the coach mark should render at all, given dismissal state. */
export function shouldShowCoachMark(steps: OnboardingStep[], dismissed: boolean): boolean {
  if (dismissed) return false;
  return nextCoachMarkStep(steps) !== undefined;
}
