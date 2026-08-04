// Sidebar nav grouping — pure logic (no DOM). The flat 20-entry route list
// grew too long to scan, so it's organised into a small number of labelled,
// collapsible sections here; nav.tsx stays a thin React/localStorage shell
// around these functions (same split as theme.ts / product-tour-logic.ts).

export interface NavLink {
  href: string;
  label: string;
  short: string;
  icon: string;
  hint: string;
  primary: boolean;
}

export interface NavGroup {
  id: string;
  label: string;
  links: NavLink[];
}

// The canonical flat route list — nav order = operator journey order:
// what's happening → what's queued → where are my apps → how it's performing →
// how the system behaves → what it can do → what it documents → what it learned.
// This is also what the mobile bottom tab bar's primary-6 selection is derived
// from (unchanged from before grouping), so its order matters independent of
// the grouped sidebar order below.
export const FLAT_LINKS: NavLink[] = [
  { href: '/', label: 'Mission Control', short: 'Home', icon: '◉', hint: 'running · review · next', primary: true },
  { href: '/work', label: 'Work', short: 'Work', icon: '▶', hint: 'queue · schedules · plans', primary: true },
  { href: '/fleet', label: 'Fleet', short: 'Fleet', icon: '◫', hint: 'morning sweep · live progress', primary: true },
  { href: '/swarm', label: 'Swarm', short: 'Swarm', icon: '⧉', hint: 'topology · live lanes', primary: false },
  { href: '/projects', label: 'Projects', short: 'Projects', icon: '⧉', hint: 'cross-repo board · bulk dispatch', primary: false },
  { href: '/apps', label: 'Apps', short: 'Apps', icon: '⊞', hint: 'directory · repo health', primary: true },
  { href: '/analytics', label: 'Analytics', short: 'Stats', icon: '◔', hint: 'throughput · cost · runner', primary: true },
  { href: '/savings', label: 'Tokens saved', short: 'Saved', icon: '✦', hint: 'per-user savings · share card', primary: false },
  { href: '/recap', label: 'Year in review', short: 'Recap', icon: '★', hint: 'tasks shipped · hours saved · share card', primary: false },
  { href: '/revenue', label: 'Revenue', short: 'Revenue', icon: '$', hint: 'MRR · ARR · churn · LTV', primary: false },
  { href: '/system', label: 'System', short: 'System', icon: '⚙', hint: 'routing · budgets · costs', primary: true },
  { href: '/connectors', label: 'Connectors', short: 'Plugs', icon: '⧉', hint: 'MCP bundle · custom', primary: false },
  { href: '/registry', label: 'Registry', short: 'Registry', icon: '#', hint: 'agents · skills · rules', primary: false },
  { href: '/marketplace', label: 'Marketplace', short: 'Market', icon: '⬡', hint: 'browse · install agents & skills', primary: false },
  { href: '/showcase', label: 'Showcase', short: 'Showcase', icon: '❏', hint: 'what myAI is · capabilities', primary: true },
  { href: '/notifications', label: 'Notifications', short: 'Alerts', icon: '🔔', hint: 'alerts · history', primary: false },
  { href: '/memory', label: 'Memory', short: 'Memory', icon: '∞', hint: 'sona · sessions', primary: false },
  { href: '/brain', label: 'Brain', short: 'Brain', icon: '❋', hint: 'namespaces · atoms · stashes', primary: false },
  { href: '/context', label: 'Your Context', short: 'Context', icon: '⊡', hint: 'view · download · port', primary: false },
  { href: '/api-keys', label: 'API Keys', short: 'Keys', icon: '⚿', hint: 'create · scope · rotate · revoke', primary: false },
  { href: '/sessions', label: 'Sessions', short: 'Sessions', icon: '⌘', hint: 'devices · last-seen · revoke', primary: false },
  { href: '/audit', label: 'Audit', short: 'Audit', icon: '⛨', hint: 'privileged actions · permissions · export', primary: false },
  { href: '/logs', label: 'Logs', short: 'Logs', icon: '☰', hint: 'live tail · correlation ids · redacted', primary: false },
];

// Group definitions reference FLAT_LINKS by href (never invent a route) —
// every href must appear in exactly one group, enforced by nav-groups.test.ts.
const GROUP_DEFS: { id: string; label: string; hrefs: string[] }[] = [
  { id: 'overview', label: 'Overview', hrefs: ['/', '/showcase'] },
  { id: 'work', label: 'Work', hrefs: ['/work', '/fleet', '/swarm', '/projects', '/apps'] },
  { id: 'insights', label: 'Insights & Billing', hrefs: ['/analytics', '/savings', '/recap', '/revenue'] },
  { id: 'system', label: 'System', hrefs: ['/system', '/connectors', '/registry', '/marketplace', '/logs'] },
  { id: 'brain', label: 'Brain & Memory', hrefs: ['/memory', '/brain', '/context'] },
  { id: 'account', label: 'Account', hrefs: ['/notifications', '/api-keys', '/sessions', '/audit'] },
];

function linkByHref(href: string): NavLink {
  const link = FLAT_LINKS.find((l) => l.href === href);
  if (!link) throw new Error(`nav-groups: GROUP_DEFS references unknown route "${href}"`);
  return link;
}

export const NAV_GROUPS: NavGroup[] = GROUP_DEFS.map((g) => ({
  id: g.id,
  label: g.label,
  links: g.hrefs.map(linkByHref),
}));

// Mobile bottom tab bar shows the 6 thumb-reachable primaries in the original
// flat journey order; the full grouped set lives in the sidebar + ⌘K palette.
export const MOBILE_LINKS: NavLink[] = FLAT_LINKS.filter((l) => l.primary).slice(0, 6);

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/** Which group (if any) owns the currently active route. */
export function groupIdForPathname(pathname: string): string | undefined {
  return NAV_GROUPS.find((g) => g.links.some((l) => isActive(pathname, l.href)))?.id;
}

export const NAV_GROUPS_STORAGE_KEY = 'myai.nav.groups.v1';

export type OpenGroupState = Record<string, boolean>;

/** Default open/closed map: only the group containing the current route starts expanded. */
export function defaultOpenGroups(pathname: string): OpenGroupState {
  const activeId = groupIdForPathname(pathname);
  const state: OpenGroupState = {};
  for (const group of NAV_GROUPS) {
    state[group.id] = group.id === activeId;
  }
  return state;
}

export function readStoredOpenGroups(storage: Pick<Storage, 'getItem'>): OpenGroupState | null {
  try {
    const raw = storage.getItem(NAV_GROUPS_STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const result: OpenGroupState = {};
    for (const group of NAV_GROUPS) {
      const value = (parsed as Record<string, unknown>)[group.id];
      if (typeof value === 'boolean') result[group.id] = value;
    }
    return result;
  } catch {
    return null;
  }
}

export function writeStoredOpenGroups(storage: Pick<Storage, 'setItem'>, state: OpenGroupState): void {
  try {
    storage.setItem(NAV_GROUPS_STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable (private mode) — in-memory state still works */
  }
}

/**
 * Resolves the open/closed map used on mount: a stored preference wins per
 * group; any group missing from storage (first run, or a newly added group)
 * falls back to the current-route default so it's never silently hidden.
 */
export function resolveOpenGroups(stored: OpenGroupState | null, pathname: string): OpenGroupState {
  const defaults = defaultOpenGroups(pathname);
  if (!stored) return defaults;
  const resolved: OpenGroupState = {};
  for (const group of NAV_GROUPS) {
    resolved[group.id] = group.id in stored ? stored[group.id] : defaults[group.id];
  }
  return resolved;
}

/** Ensures the group containing `pathname` is open — used when navigating so the active link is never hidden inside a collapsed section. */
export function withActiveGroupOpen(state: OpenGroupState, pathname: string): OpenGroupState {
  const activeId = groupIdForPathname(pathname);
  if (!activeId || state[activeId]) return state;
  return { ...state, [activeId]: true };
}

export function toggleGroup(state: OpenGroupState, groupId: string): OpenGroupState {
  return { ...state, [groupId]: !state[groupId] };
}
