// Pure, hermetic logic behind the ProductTour "make the intro SEEN" behaviour.
//
// Operators were skipping the first-run intro before the continuity value ever
// landed. The fix is behavioural, not cosmetic: the exit is de-emphasised and
// briefly withheld while the opening value auto-advances — never trapping the
// user, just making the payload unmissable. The timing/gating decisions live
// here as pure functions so they can be unit-tested in the dashboard's
// node-environment vitest run (no jsdom needed), and the React component stays a
// thin shell around them.

/** How long the very first slide holds before the skip/close affordance appears (ms). */
export const SKIP_REVEAL_MS = 6000;

/** Number of leading "value" slides that auto-advance on their own (until the user takes control). */
export const AUTO_ADVANCE_STEPS = 2;

/** How long each auto-advancing slide dwells before moving on (ms). */
export const AUTO_ADVANCE_MS = 7000;

/**
 * Whether the skip/close affordance should be available yet.
 *
 * The intent: on the opening slide, hold the exit back for a short beat so the
 * value engages first; from the second slide onward the user has clearly opted
 * in, so skip is always available. This is the ONLY gate on dismissal — it is
 * deliberately short and self-releasing so the user is never trapped.
 */
export function canSkip(
  stepIndex: number,
  msOnStep: number,
  revealMs: number = SKIP_REVEAL_MS,
): boolean {
  if (stepIndex >= 1) return true;
  return msOnStep >= revealMs;
}

/**
 * Whether the tour should auto-advance off the current slide.
 *
 * Only the leading value slides auto-advance, and only until the user takes
 * manual control (Next/Back/keyboard) — after that the tour never moves without
 * them. The final slide never auto-advances (it holds the CTA).
 */
export function shouldAutoAdvance(
  stepIndex: number,
  totalSteps: number,
  userInteracted: boolean,
  autoAdvanceSteps: number = AUTO_ADVANCE_STEPS,
): boolean {
  if (userInteracted) return false;
  if (totalSteps <= 1) return false;
  if (stepIndex >= totalSteps - 1) return false; // never auto-advance off the last slide
  return stepIndex < autoAdvanceSteps;
}
