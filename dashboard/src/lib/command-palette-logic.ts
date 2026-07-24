// Command palette — pure logic (no DOM). command-palette.tsx stays a thin
// React/fetch shell around these functions (same split as nav-groups.ts /
// product-tour-logic.ts), so the entry-building and filtering rules are
// unit-testable without a browser.
//
// DASHBOARD Cmd-K powerhouse pass: global nav (existing NAV_ENTRIES) + three
// quick-action kinds — jump to a repo, switch tenant, dispatch a task.

export type PaletteEntryKind = 'nav' | 'repo' | 'tenant' | 'action';

export interface PaletteEntry {
  /** Stable key for React lists and keyboard-nav bookkeeping. */
  id: string;
  kind: PaletteEntryKind;
  label: string;
  hint: string;
  /** Space-joined lowercase search haystack; pre-lowered so filtering never re-lowers per keystroke. */
  keywords: string;
  /** nav/repo entries navigate here. */
  href?: string;
  /** action/tenant entries carry a discriminator + payload for the caller to switch on. */
  actionId?: string;
  payload?: string;
}

export interface TenantLike {
  tenantId: string;
  name: string;
}

const NAV_RAW: Array<Omit<PaletteEntry, 'id' | 'kind' | 'keywords'> & { keywords: string }> = [
  { label: 'Mission Control', hint: 'running · review · up next', href: '/', keywords: 'home status mission control overview' },
  { label: 'Work — Up Next', hint: 'pending queue', href: '/work', keywords: 'tasks queue pending backlog' },
  { label: 'Work — Needs Review', hint: 'waiting on you', href: '/work?tab=review', keywords: 'review approve ship' },
  { label: 'Work — Scheduled Runs', hint: 'cron schedules', href: '/work?tab=schedules', keywords: 'schedule cron fires runner' },
  { label: 'Work — 10-Day Plans', hint: 'per-repo plans', href: '/work?tab=plans', keywords: 'plan ten day roadmap' },
  { label: 'Work — Orchestration', hint: 'dispatch engine', href: '/work?tab=orchestration', keywords: 'orchestration dispatch workers history done' },
  { label: 'Swarm', hint: 'topology picker · live lanes', href: '/swarm', keywords: 'swarm topology hierarchical mesh ring star multi-agent dispatch lanes coordinator' },
  { label: 'Projects', hint: 'cross-repo board · bulk dispatch', href: '/projects', keywords: 'projects cross-repo board bulk dispatch fanout' },
  { label: 'Apps — Directory', hint: 'URLs, mongo, status per app', href: '/apps', keywords: 'apps directory repos urls vercel dns localhost' },
  { label: 'Apps — Repo Health', hint: 'AI/ STATE.md CLAUDE.md', href: '/apps?tab=health', keywords: 'repos health framework compliance' },
  { label: 'System — Routing', hint: 'tiers + agent map', href: '/system', keywords: 'routing llm tiers models' },
  { label: 'System — Budgets', hint: 'caps + guards', href: '/system?tab=budgets', keywords: 'budgets caps spend guard' },
  { label: 'System — Costs', hint: 'spend analytics', href: '/system?tab=costs', keywords: 'costs spend usd tokens analytics' },
  { label: 'System — API Health', hint: 'providers + gateway', href: '/system?tab=api', keywords: 'api health circuit breaker rate limit gateway' },
  { label: 'Registry — Agents', hint: 'specialist agents', href: '/registry', keywords: 'agents specialists' },
  { label: 'Registry — Skills', hint: 'playbooks', href: '/registry?tab=skills', keywords: 'skills playbooks triggers' },
  { label: 'Registry — Hooks', hint: 'event hooks', href: '/registry?tab=hooks', keywords: 'hooks events' },
  { label: 'Registry — Rules', hint: 'governance docs', href: '/registry?tab=rules', keywords: 'rules governance docs' },
  { label: 'Registry — Patterns', hint: 'SONA patterns', href: '/registry?tab=patterns', keywords: 'patterns sona learned' },
  { label: 'Memory — SONA', hint: 'pattern analytics', href: '/memory', keywords: 'memory sona analytics confidence' },
  { label: 'Memory — Sessions', hint: 'sessions + RAG corpus', href: '/memory?tab=sessions', keywords: 'sessions rag corpus vectors recall' },
  { label: 'Brain — Overview', hint: 'namespaces · branches · commits', href: '/brain', keywords: 'brain namespaces branches commits git memory atoms' },
  { label: 'Brain — Atoms', hint: 'sessions · handoffs · memory', href: '/brain?tab=atoms', keywords: 'brain atoms sessions handoffs memory facts' },
  { label: 'Brain — Stashes', hint: 'frozen context', href: '/brain?tab=stashes', keywords: 'brain stashes frozen context pop resume' },
  { label: 'Brain — Provenance', hint: 'code ↔ memory links', href: '/brain?tab=provenance', keywords: 'brain provenance blame code memory links' },
  { label: 'Your Context', hint: 'view · download · port', href: '/context', keywords: 'context portable download upload import export bundle vectors memory own lock-in' },
  { label: 'Analytics', hint: 'throughput · cost · runner', href: '/analytics', keywords: 'analytics throughput cost trend runner sessions plan progress success rate metrics' },
  { label: 'Documentation — Repo READMEs', hint: 'rendered markdown', href: '/documentation', keywords: 'documentation docs readme markdown repo' },
  { label: 'Documentation — Framework Docs', hint: 'AI_RULES, routing, keywords', href: '/documentation?tab=framework', keywords: 'documentation framework rules routing keywords design system' },
  { label: 'Showcase', hint: 'public marketing page', href: '/showcase', keywords: 'showcase marketing public scorecard shipped roadmap' },
  { label: 'Notifications', hint: 'alerts · history', href: '/notifications', keywords: 'notifications alerts bell toast history events' },
];

export const NAV_ENTRIES: PaletteEntry[] = NAV_RAW.map((e, i) => ({
  id: `nav-${i}`,
  kind: 'nav',
  ...e,
}));

/** The one static quick action that switches the palette into dispatch-form mode. */
export const DISPATCH_ACTION_ENTRY: PaletteEntry = {
  id: 'action-dispatch-open',
  kind: 'action',
  label: 'Dispatch a task…',
  hint: 'create + queue',
  keywords: 'dispatch create task new queue run schedule fanout',
  actionId: 'dispatch-open',
};

/** One "switch tenant" entry per tenant other than the active one. */
export function buildTenantEntries(tenants: TenantLike[], currentTenantId?: string | null): PaletteEntry[] {
  return tenants
    .filter((t) => t.tenantId !== currentTenantId)
    .map((t) => ({
      id: `tenant-${t.tenantId}`,
      kind: 'tenant',
      label: `Switch tenant: ${t.name}`,
      hint: 'tenant switch',
      keywords: `switch tenant ${t.name} ${t.tenantId}`.toLowerCase(),
      actionId: 'switch-tenant',
      payload: t.tenantId,
    }));
}

/** One "jump to repo" entry per known repo, deduped and sorted. */
export function buildRepoEntries(repos: string[]): PaletteEntry[] {
  const unique = Array.from(new Set(repos.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  return unique.map((repo) => ({
    id: `repo-${repo}`,
    kind: 'repo',
    label: `Jump to repo: ${repo}`,
    hint: 'work queue',
    keywords: `jump repo ${repo}`.toLowerCase(),
    href: `/work?repo=${encodeURIComponent(repo)}`,
  }));
}

/** Case-insensitive substring match over label + hint + keywords; empty query returns everything. */
export function filterEntries(entries: PaletteEntry[], query: string): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return entries;
  return entries.filter((e) => `${e.label} ${e.hint} ${e.keywords}`.toLowerCase().includes(q));
}

/** Keep the highlighted index in [0, length-1] (or -1 if the list is empty) after a filter/list change. */
export function clampIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  if (index < 0) return 0;
  if (index > length - 1) return length - 1;
  return index;
}
