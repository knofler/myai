// v2 shell information architecture (DASHBOARD_REDESIGN_2026-09 §"Information
// architecture"). Pure logic — no DOM — so app-shell-v2.tsx stays a thin React
// shell around it (same split as nav-groups.ts). Five operator groups: Operate
// / Brain / Money / Build / Account. Every href below is a route that exists
// under dashboard/src/app today; marketing/legal routes are deliberately absent
// (they left the shell in batch B6 — see app-shell.tsx FULL_BLEED).

export interface NavV2Link {
  href: string;
  label: string;
  icon: string;
}

export interface NavV2Group {
  id: string;
  label: string;
  /** Mobile bottom-tab glyph (Operate/Brain/Money get a primary tab). */
  icon: string;
  links: NavV2Link[];
}

export const NAV_V2_GROUPS: NavV2Group[] = [
  {
    id: 'operate',
    label: 'Operate',
    icon: '◉',
    links: [
      { href: '/fleet', label: 'Fleet', icon: '◫' },
      { href: '/work', label: 'Work', icon: '▶' },
      { href: '/runs', label: 'Runs', icon: '⏱' },
      { href: '/swarm', label: 'Swarm', icon: '⧉' },
      { href: '/logs', label: 'Logs', icon: '☰' },
      { href: '/status', label: 'Status', icon: '◍' },
    ],
  },
  {
    id: 'brain',
    label: 'Brain',
    icon: '❋',
    links: [
      { href: '/brain', label: 'Brain', icon: '❋' },
      { href: '/memory', label: 'Memory', icon: '∞' },
      { href: '/sessions', label: 'Sessions', icon: '⌘' },
      { href: '/context', label: 'Context', icon: '⊡' },
      { href: '/search', label: 'Search', icon: '⌕' },
      { href: '/registry', label: 'Registry', icon: '#' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    icon: '✦',
    links: [
      { href: '/savings', label: 'Tokens saved', icon: '✦' },
      { href: '/velocity', label: 'Velocity', icon: '↗' },
      { href: '/analytics', label: 'Analytics', icon: '◔' },
      { href: '/billing', label: 'Billing', icon: '$' },
      { href: '/revenue', label: 'Revenue', icon: '$' },
      { href: '/referrals', label: 'Referrals', icon: '↗' },
    ],
  },
  {
    id: 'build',
    label: 'Build',
    icon: '⊞',
    links: [
      { href: '/apps', label: 'Apps', icon: '⊞' },
      { href: '/projects', label: 'Projects', icon: '⧉' },
      { href: '/marketplace', label: 'Marketplace', icon: '⬡' },
      { href: '/connectors', label: 'Connectors', icon: '⧉' },
      { href: '/api-keys', label: 'API Keys', icon: '⚿' },
      { href: '/developers', label: 'Developers', icon: '{}' },
      { href: '/documentation', label: 'Docs', icon: '❏' },
    ],
  },
  {
    id: 'account',
    label: 'Account',
    icon: '⛨',
    links: [
      { href: '/security', label: 'Security', icon: '⛨' },
      { href: '/2fa', label: 'Two-Factor', icon: '⛨' },
      { href: '/notifications', label: 'Notifications', icon: '🔔' },
      { href: '/audit', label: 'Audit', icon: '⛨' },
    ],
  },
];

// Mobile bottom tab bar: Operate / Brain / Money as primary tabs (each jumps to
// its group's first route), then a "More" trigger opening a sheet with Build +
// Account. Matches DASHBOARD_REDESIGN §Shell "Operate / Brain / Money / More".
export const MOBILE_V2_PRIMARY_IDS = ['operate', 'brain', 'money'] as const;

export function isActive(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

/** Which group (if any) owns the active route. */
export function groupIdForPathname(pathname: string): string | undefined {
  return NAV_V2_GROUPS.find((g) => g.links.some((l) => isActive(pathname, l.href)))?.id;
}

/** Primary bottom-tab groups (Operate/Brain/Money), each with a jump target. */
export function primaryMobileTabs(): { id: string; label: string; icon: string; href: string }[] {
  return MOBILE_V2_PRIMARY_IDS.map((id) => {
    const g = NAV_V2_GROUPS.find((grp) => grp.id === id)!;
    return { id: g.id, label: g.label, icon: g.icon, href: g.links[0].href };
  });
}

/** Groups shown inside the "More" sheet (everything not a primary tab). */
export function moreMobileGroups(): NavV2Group[] {
  return NAV_V2_GROUPS.filter((g) => !MOBILE_V2_PRIMARY_IDS.includes(g.id as (typeof MOBILE_V2_PRIMARY_IDS)[number]));
}
