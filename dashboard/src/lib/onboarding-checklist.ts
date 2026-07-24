// Pure logic behind the in-dashboard first-run activation checklist (Mission
// Control). Walks a brand-new tenant through the loop the whole product rests
// on: connect a repo → describe an app / queue a task → watch the off-hours
// runner pick it up → review and approve the result. Kept hermetic (no DOM,
// no Mongo) so step derivation is unit-testable; the React shell
// (onboarding-checklist.tsx) is a thin wrapper that adds localStorage dismissal.

export interface OnboardingCounts {
  /** Repo/app cards registered for this tenant (any status). */
  repoCount: number;
  /** Tasks ever queued for this tenant (any status). */
  taskCount: number;
  /** Tasks the runner has picked up at least once (working, review, or done). */
  pickedUpCount: number;
  /** Tasks approved through to done (a completed `ship it`). */
  doneCount: number;
}

export interface OnboardingStep {
  id: 'connect' | 'describe' | 'watch' | 'approve';
  label: string;
  desc: string;
  href: string;
  cta: string;
  done: boolean;
}

/** Builds the 4 checklist steps with their done-state derived from live counts. */
export function buildOnboardingSteps(counts: OnboardingCounts): OnboardingStep[] {
  return [
    {
      id: 'connect',
      label: 'Connect a repo',
      desc: 'Point myAI at a GitHub repo or a new project name.',
      href: '/welcome/start',
      cta: 'Connect a repo',
      done: counts.repoCount > 0,
    },
    {
      id: 'describe',
      label: 'Describe an app & queue a task',
      desc: 'Tell it what to build — it lands in the queue for the runner.',
      href: '/welcome/start',
      cta: 'Queue a task',
      done: counts.taskCount > 0,
    },
    {
      id: 'watch',
      label: 'Watch the off-hours runner',
      desc: 'The runner picks up queued work on the next free window.',
      href: '/work?tab=orchestration',
      cta: 'Watch runner',
      done: counts.pickedUpCount > 0,
    },
    {
      id: 'approve',
      label: 'Review & approve the result',
      desc: 'Check the diff, then `ship it` to merge.',
      href: '/work?tab=review',
      cta: 'Review & approve',
      done: counts.doneCount > 0,
    },
  ];
}

/** Whether every step is complete — the checklist auto-retires once true. */
export function isOnboardingComplete(steps: OnboardingStep[]): boolean {
  return steps.every((s) => s.done);
}

/** The first not-yet-done step — the one the checklist should spotlight with a CTA. */
export function nextOnboardingStep(steps: OnboardingStep[]): OnboardingStep | undefined {
  return steps.find((s) => !s.done);
}
