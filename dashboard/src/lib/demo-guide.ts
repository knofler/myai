// Guided demo walk (GRAND_PRODUCT §7.4 GTM proof surface) — the ordered stops
// a prospect on the hosted read-only demo (documentation/HOSTED_DEMO.md) is
// walked through so they see the full idea→app→schedule→ops→support loop
// before signing up.
//
// Pure data + path logic, no DOM/React — the client shell
// (components/demo-guide.tsx) renders whichever stop matches the current
// pathname and links to the next one. Every href must point at a page that
// shows data seeded by scripts/myai_demo.sh, so the tour never lands a
// prospect on an empty panel; demo-guide.test.ts enforces that each stop's
// page exists on disk.

export interface DemoGuideStop {
  /** Loop beat this stop demonstrates. */
  id: 'idea' | 'app' | 'schedule' | 'ops' | 'support';
  /** Dashboard route the stop lives on (must be a real, seeded page). */
  href: string;
  eyebrow: string;
  title: string;
  body: string;
}

export const DEMO_GUIDE_STOPS: readonly DemoGuideStop[] = [
  {
    id: 'idea',
    href: '/work',
    eyebrow: 'Idea',
    title: 'An idea becomes a plan and a queue.',
    body: 'This Work board is seeded the way a real tenant’s looks: a 10-day plan and a task queue the off-hours runner works through. Describe an app and it lands here.',
  },
  {
    id: 'app',
    href: '/apps',
    eyebrow: 'App',
    title: 'The app takes shape, repo by repo.',
    body: 'Every connected repo reports its health here — the storefront demo app shipped v1.2 last night while nobody was watching.',
  },
  {
    id: 'schedule',
    href: '/system',
    eyebrow: 'Schedule',
    title: 'Work runs itself off-hours.',
    body: 'Schedules hand queued work to the autonomous runner on its free window. You review diffs in the morning instead of babysitting sessions.',
  },
  {
    id: 'ops',
    href: '/fleet',
    eyebrow: 'Ops',
    title: 'One directory for everything you run.',
    body: 'The fleet directory tracks every repo’s live status — the seeded cards show a healthy ship, a latency warning, and an expired-certificate incident side by side.',
  },
  {
    id: 'support',
    href: '/ask',
    eyebrow: 'Support',
    title: 'Questions loop straight back into the queue.',
    body: 'Ask a specialist agent anything about the workspace. In a real tenant, support tickets become queued tasks — closing the loop this tour just walked.',
  },
];

/**
 * Index of the stop the given pathname belongs to, or -1 when the visitor is
 * off the tour path. Matches the stop's route and its sub-pages
 * (`/work/task-x` still counts as the Work stop) but never a mere prefix
 * (`/workshop` is not `/work`).
 */
export function stopIndexForPath(pathname: string): number {
  return DEMO_GUIDE_STOPS.findIndex(
    (s) => pathname === s.href || pathname.startsWith(`${s.href}/`),
  );
}

export function isLastStop(index: number): boolean {
  return index === DEMO_GUIDE_STOPS.length - 1;
}

/** sessionStorage key for the per-visit "hide guide" flag — session-scoped on
 * purpose so the guide resets on the next visit (reset-on-load, like the demo
 * tenant's data: nothing a visitor does survives them leaving). */
export const DEMO_GUIDE_DISMISS_KEY = 'myai:demo-guide:v1:hidden';
