// Shell information architecture. Pure logic — no DOM — so app-shell-v2.tsx
// stays a thin React shell around it.
//
// Five operator JOBS (dashboard redesign, operator GO 2026-10-21, plan
// https://claude.ai/artifact/XP2z6Vo6TzpLmcPrtYUXys): Today · Swarm · Work ·
// Brain · Settings. They replace the system-shaped Operate / Brain / Money /
// Build / Account groups, whose 31 rows put Swarm at 1-of-31. Each section's
// FIRST link is its landing page; the rail shows the five sections and expands
// the active one. Every href is a route that exists under dashboard/src/app
// today and keeps its URL — pages merge in later phases, with redirects then.
// Marketing/legal routes are deliberately absent (FULL_BLEED_ROUTES below).

export interface NavV2Link {
  href: string;
  label: string;
  icon: string;
}

export interface NavV2Group {
  id: string;
  label: string;
  /** Section glyph — rail row + More-sheet header. */
  icon: string;
  /** links[0] is the section's landing page (the rail row's target). */
  links: NavV2Link[];
}

export const NAV_V2_GROUPS: NavV2Group[] = [
  {
    id: 'today',
    label: 'Today',
    icon: '⌂',
    links: [
      { href: '/', label: 'Today', icon: '⌂' },
      { href: '/status', label: 'Status', icon: '◍' },
      { href: '/notifications', label: 'Notifications', icon: '◔' },
    ],
  },
  {
    id: 'swarm',
    label: 'Swarm',
    icon: '⧉',
    links: [
      { href: '/swarm', label: 'Swarm', icon: '⧉' },
      { href: '/fleet', label: 'Fleet', icon: '◫' },
      { href: '/runs', label: 'Runs', icon: '⏱' },
      { href: '/logs', label: 'Logs', icon: '☰' },
    ],
  },
  {
    id: 'work',
    label: 'Work',
    icon: '▶',
    links: [
      { href: '/work', label: 'Queue', icon: '▶' },
      { href: '/projects', label: 'Projects', icon: '▤' },
      { href: '/apps', label: 'Apps', icon: '⊞' },
    ],
  },
  {
    id: 'brain',
    label: 'Brain',
    icon: '❋',
    links: [
      { href: '/brain', label: 'Brain', icon: '❋' },
      { href: '/ask', label: 'Ask', icon: '?' },
      { href: '/memory', label: 'Memory', icon: '∞' },
      { href: '/sessions', label: 'Sessions', icon: '⌘' },
      { href: '/context', label: 'Context', icon: '⊡' },
      { href: '/search', label: 'Search', icon: '⌕' },
      { href: '/registry', label: 'Registry', icon: '#' },
      { href: '/tour', label: 'Brain tour', icon: '▷' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    icon: '⚙',
    links: [
      // Setup
      { href: '/system', label: 'System', icon: '⚙' },
      { href: '/connectors', label: 'Connections', icon: '⇄' },
      { href: '/api-keys', label: 'API keys', icon: '⚿' },
      // Account
      { href: '/2fa', label: 'Two-factor', icon: '⛨' },
      { href: '/audit', label: 'Audit log', icon: '≡' },
      { href: '/billing', label: 'Billing', icon: '$' },
      // Business — Marketplace (the revenue product) lives here, not in the bar.
      { href: '/marketplace', label: 'Marketplace', icon: '⬡' },
      { href: '/revenue', label: 'Revenue', icon: '£' },
      { href: '/referrals', label: 'Referrals', icon: '↗' },
      { href: '/savings', label: 'Tokens saved', icon: '✦' },
      { href: '/velocity', label: 'Velocity', icon: '»' },
      { href: '/analytics', label: 'Analytics', icon: '◑' },
      // /documentation permanently 307-redirects to /showcase (a full-bleed
      // public surface with no AppShellV2 chrome), so linking it from the
      // operator nav is a one-way door on mobile (same as /developers and
      // /security removed in 1be192e9).
    ],
  },
];

// Mobile bottom bar — Today · Swarm · [+] · Work · More. The three jobs an
// operator does from a phone get slots; the centre slot is not a route — it
// opens the global action sheet. Brain and Settings (Marketplace included)
// move under More as whole sections, so nothing loses its phone affordance
// (nav-v2-reachability.test.ts proves it).
export type MobileBarSlotId = 'today' | 'swarm' | 'action' | 'work' | 'more';

export interface MobileBarSlot {
  id: MobileBarSlotId;
  label: string;
  icon: string;
  /** Absent on the two non-route slots (action sheet, More sheet). */
  href?: string;
}

export const MOBILE_BAR: readonly MobileBarSlot[] = [
  { id: 'today', label: 'Today', icon: '⌂', href: '/' },
  { id: 'swarm', label: 'Swarm', icon: '⧉', href: '/swarm' },
  { id: 'action', label: 'Create', icon: '+' },
  { id: 'work', label: 'Work', icon: '▶', href: '/work' },
  { id: 'more', label: 'More', icon: '⋯' },
];

/** Sections that own a primary bar slot; every other section overflows into More. */
export const MOBILE_V2_PRIMARY_IDS = ['today', 'swarm', 'work'] as const;

/** Which bar slot lights up for a pathname (undefined = no section owns it). */
export function activeBarSlot(pathname: string): MobileBarSlotId | undefined {
  const gid = groupIdForPathname(pathname);
  if (!gid) return undefined;
  return (MOBILE_V2_PRIMARY_IDS as readonly string[]).includes(gid) ? (gid as MobileBarSlotId) : 'more';
}

// The global action sheet behind the centre [+] (mockup screen 10). Every row
// is an EXISTING route — this is one entry point to capability that already
// exists, not new capability. "Give a task" lands on Mission Control's ask bar
// in task mode (it posts to the existing /api/onboarding/launch), so the
// primary action never leaves the operator chrome.
export interface GlobalAction {
  label: string;
  hint: string;
  icon: string;
  href: string;
}

export const GLOBAL_ACTIONS: readonly GlobalAction[] = [
  { label: 'Give a task', hint: 'Add it to the queue', icon: '▶', href: '/?ask=task' },
  { label: 'Ask your brain', hint: 'Search everything myAI knows', icon: '❋', href: '/search' },
  { label: 'Research something', hint: 'Explore what your AI has learned', icon: '⌕', href: '/brain' },
  { label: 'Build an app or feature', hint: 'Scaffold it and queue the build', icon: '⊞', href: '/apps/new' },
  { label: 'Add a memory', hint: 'Tell myAI something to remember', icon: '∞', href: '/memory' },
  { label: 'Connect a tool', hint: 'Plug in a new service', icon: '⧉', href: '/connectors' },
];

/** Window event any surface can dispatch to open the global action sheet. */
export const GLOBAL_ACTION_EVENT = 'myai:global-action';

/**
 * Routes that render WITHOUT operator chrome — public marketing / legal /
 * trust surfaces for logged-out prospects and procurement (app-shell.tsx).
 *
 * It lives HERE, next to the nav, because the two lists have to be disjoint:
 * a nav row pointing at a full-bleed route is a one-way door. `/security` and
 * `/developers` were exactly that — the Account and Build groups linked them,
 * and both render with no rail, no bottom bar and no route home (LegalShell's
 * wordmark goes to /welcome, the marketing site). Keeping both lists in one
 * module lets navNotFullBleed() prove they never overlap again.
 */
export const FULL_BLEED_ROUTES = [
  '/welcome',
  '/recap',
  '/demo',
  '/showcase',
  '/documentation', // 307-redirects to /showcase (full-bleed)
  '/proof',
  '/pricing',
  '/developers',
  // Trust + compliance pack — procurement reads these pre-signature.
  '/privacy',
  '/terms',
  '/acceptable-use',
  '/security',
  '/dpa',
  '/subprocessors',
] as const;

export function isFullBleed(pathname: string): boolean {
  return FULL_BLEED_ROUTES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** Nav rows that land on a chrome-less page — must always be empty. */
export function navRowsIntoFullBleed(): string[] {
  return allNavLinks()
    .map((l) => l.href)
    .filter((href) => isFullBleed(href));
}

// Home (`/`) is Today's landing page. It once belonged to no group, which is
// precisely how it vanished from the IA: B6 swapped nav-groups.ts (which had
// `{ href: '/', label: 'Mission Control', primary: true }`) for NAV_V2_GROUPS
// and nothing carried the home row across. As the first link of the Today
// section it can't fall out again; HOME_LINK stays the named handle the shell
// (wordmark, breadcrumb) and tests use.
export const HOME_LINK: NavV2Link = NAV_V2_GROUPS[0].links[0];

/**
 * Every destination the chrome must be able to reach, home first. This is
 * the reachability contract the shell is tested against — geometry tests
 * (column counts, tap heights) cannot catch a route with no affordance at all.
 */
export function allNavLinks(): NavV2Link[] {
  return NAV_V2_GROUPS.flatMap((g) => g.links);
}

/** The section's landing link — what its rail row and bar slot open. */
export function sectionHref(group: NavV2Group): string {
  return group.links[0].href;
}

/**
 * The active section's links — what the mobile section strip renders and the
 * desktop rail expands under the active section. A bar slot lands on its
 * section's first link only, so without this strip the rest of Today, Swarm
 * and Work (/status, /fleet, /runs, /logs, /projects, …) would have no phone
 * affordance.
 */
export function sectionLinksForPathname(pathname: string): NavV2Link[] {
  const id = groupIdForPathname(pathname);
  return NAV_V2_GROUPS.find((g) => g.id === id)?.links ?? [];
}

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/** Which group (if any) owns the active route. */
export function groupIdForPathname(pathname: string): string | undefined {
  return NAV_V2_GROUPS.find((g) => g.links.some((l) => isActive(pathname, l.href)))?.id;
}

/** Groups with a primary bar slot (Operate), each with its slot's jump target. */
export function primaryMobileTabs(): { id: string; label: string; icon: string; href: string }[] {
  return MOBILE_V2_PRIMARY_IDS.map((id) => {
    const g = NAV_V2_GROUPS.find((grp) => grp.id === id)!;
    const slot = MOBILE_BAR.find((s) => s.id === id);
    return { id: g.id, label: slot?.label ?? g.label, icon: slot?.icon ?? g.icon, href: slot?.href ?? g.links[0].href };
  });
}

/** Groups shown inside the "More" sheet (everything not a primary tab). */
export function moreMobileGroups(): NavV2Group[] {
  return NAV_V2_GROUPS.filter((g) => !MOBILE_V2_PRIMARY_IDS.includes(g.id as (typeof MOBILE_V2_PRIMARY_IDS)[number]));
}
