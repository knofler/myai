// Saved task-board views (task-e8aaf32e) — pure, client-safe logic shared by
// the /work page, the /api/views routes, and the SavedViewsBar client
// component. A saved view is a named bundle of task-board filters
// (repo / priority / status / agent / lane, plus the /work tab) persisted
// per user and tenant-scoped, applied via a shareable `/work?view=<id>` URL.
//
// No `next/headers`, no Mongo, no node built-ins here — the client bundle
// imports this file, so it must stay pure (same rule as tenant-cookie.ts).

export const VIEW_PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export const VIEW_STATUSES = ['pending', 'working', 'review', 'done', 'blocked', 'paused', 'dead_letter'] as const;
export const VIEW_LANES = ['claude', 'agentic-fallback'] as const;
// Must stay in sync with the tabs array in src/app/work/page.tsx.
export const WORK_TABS = ['queue', 'review', 'schedules', 'recurring', 'plans', 'orchestration', 'deadletter', 'leases', 'blockers'] as const;

export type ViewPriority = (typeof VIEW_PRIORITIES)[number];
export type ViewStatus = (typeof VIEW_STATUSES)[number];
export type ViewLane = (typeof VIEW_LANES)[number];

/** The board's status-lens tabs — how a stored `status` filter maps onto /work.
 *  blocked/paused have no dedicated tab today, so they resolve to no tab. */
export const STATUS_TAB: Partial<Record<ViewStatus, string>> = {
  pending: 'queue',
  review: 'review',
  dead_letter: 'deadletter',
  working: 'orchestration',
  done: 'orchestration',
};

/** Reverse lens: the status a tab pins, for tabs that ARE a single-status lens
 *  (orchestration mixes working+done, so it maps to none). Used when stamping
 *  the current board state into a new saved view so the stored object is
 *  self-describing in task language. */
export const TAB_STATUS: Record<string, ViewStatus> = {
  review: 'review',
  deadletter: 'dead_letter',
};

export interface SavedViewFilters {
  tab?: string;
  repo?: string;
  priority?: ViewPriority;
  status?: ViewStatus;
  agent?: string;
  lane?: ViewLane;
}

export interface SavedViewSummary {
  viewId: string;
  name: string;
  filters: SavedViewFilters;
}

export const MAX_VIEW_NAME = 60;
export const MAX_VIEWS_PER_USER = 50;
export const VIEW_ID_RE = /^sv-[0-9a-f]{12}$/;

// Repo folder names and agent slugs — conservative charset, no spaces.
const SLUG_RE = /^[A-Za-z0-9._/-]{1,100}$/;

/** Validate a ?priority= / stored priority value; anything else drops the filter. */
export function asPriority(v: unknown): ViewPriority | undefined {
  return VIEW_PRIORITIES.includes(v as ViewPriority) ? (v as ViewPriority) : undefined;
}

/** Validate a ?lane= / stored lane value; anything else drops the filter. */
export function asLane(v: unknown): ViewLane | undefined {
  return VIEW_LANES.includes(v as ViewLane) ? (v as ViewLane) : undefined;
}

/** Validate a stored status value; anything else drops the filter. */
export function asStatus(v: unknown): ViewStatus | undefined {
  return VIEW_STATUSES.includes(v as ViewStatus) ? (v as ViewStatus) : undefined;
}

/** Validate a ?agent= / ?repo= slug; anything else drops the filter (an
 *  unrecognized value must never blank the board via an unvalidated query). */
export function asSlug(v: unknown): string | undefined {
  return typeof v === 'string' && SLUG_RE.test(v) ? v : undefined;
}

/** Sanitize an arbitrary filters object down to the known, valid dimensions.
 *  Unknown keys and invalid values are dropped, never rejected — a stale
 *  stored view degrades to a broader lens instead of an error. */
export function sanitizeFilters(raw: unknown): SavedViewFilters {
  if (typeof raw !== 'object' || raw === null) return {};
  const f = raw as Record<string, unknown>;
  const out: SavedViewFilters = {};
  const tab = typeof f.tab === 'string' && (WORK_TABS as readonly string[]).includes(f.tab) ? f.tab : undefined;
  if (tab) out.tab = tab;
  const repo = asSlug(f.repo);
  if (repo) out.repo = repo;
  const priority = asPriority(f.priority);
  if (priority) out.priority = priority;
  const status = asStatus(f.status);
  if (status) out.status = status;
  const agent = asSlug(f.agent);
  if (agent) out.agent = agent;
  const lane = asLane(f.lane);
  if (lane) out.lane = lane;
  return out;
}

export function hasAnyFilter(f: SavedViewFilters): boolean {
  return Boolean(f.repo || f.priority || f.status || f.agent || f.lane || (f.tab && f.tab !== 'queue'));
}

export type ParseViewResult =
  | { ok: true; name: string; filters: SavedViewFilters }
  | { ok: false; error: string };

/** Validate a POST /api/views body. Strict on name, lenient-but-sanitizing on
 *  filters — except a view that filters nothing is rejected outright. */
export function parseSavedViewCreate(body: unknown): ParseViewResult {
  if (typeof body !== 'object' || body === null) {
    return { ok: false, error: 'body must be { name, filters }' };
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name) return { ok: false, error: 'name (non-empty string) is required' };
  if (name.length > MAX_VIEW_NAME) {
    return { ok: false, error: `name must be at most ${MAX_VIEW_NAME} characters` };
  }
  const filters = sanitizeFilters(b.filters);
  if (!hasAnyFilter(filters)) {
    return { ok: false, error: 'filters must set at least one of tab/repo/priority/status/agent/lane' };
  }
  return { ok: true, name, filters };
}

/** Build the /work URL a view's filters resolve to. `tab` wins when stored;
 *  otherwise the status-lens mapping picks the tab. Passing `viewId` makes the
 *  link self-identifying (?view=) so the bar can highlight the active view and
 *  the address bar stays shareable. */
export function viewHref(filters: SavedViewFilters, viewId?: string, base = '/work'): string {
  const qs = new URLSearchParams();
  const tab = filters.tab ?? (filters.status ? STATUS_TAB[filters.status] : undefined);
  if (tab && tab !== 'queue') qs.set('tab', tab);
  if (filters.repo) qs.set('repo', filters.repo);
  if (filters.priority) qs.set('priority', filters.priority);
  if (filters.agent) qs.set('agent', filters.agent);
  if (filters.lane) qs.set('lane', filters.lane);
  if (viewId) qs.set('view', viewId);
  const s = qs.toString();
  return s ? `${base}?${s}` : base;
}

/** One-line human summary of what a view filters on (chip tooltip). */
export function describeFilters(f: SavedViewFilters): string {
  const parts: string[] = [];
  if (f.tab && f.tab !== 'queue') parts.push(`tab:${f.tab}`);
  if (f.status) parts.push(`status:${f.status}`);
  if (f.repo) parts.push(`repo:${f.repo}`);
  if (f.priority) parts.push(f.priority);
  if (f.agent) parts.push(`agent:${f.agent}`);
  if (f.lane) parts.push(`lane:${f.lane}`);
  return parts.join(' · ') || 'no filters';
}
