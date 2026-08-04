// Fleet Overview v0 (plan/MULTI_REPO_ORCHESTRATION_UI_SPEC.md) — pure,
// DOM-free aggregation for the per-repo queue-depth / in-flight / last-ship
// rollup the spec promises. The full ADR-015 grouping + fan-out board already
// shipped at /projects (lib/projects.ts, commit c1e690e) before this spec was
// written, so rather than a competing page, this module supplies the
// observability fields the spec still wants — one in-flight task (agent +
// startedAt) and one last-ship snapshot (RepoCard) per repo, plus the
// fleet-wide summary totals — for the existing /projects page to render
// alongside its per-project rollup. Every field here already comes back from
// tasks_list / repos_card_list; no new gateway tool, no schema change.

export interface FleetTaskLike {
  repo: string;
  status: string;
  assignedAgent?: string;
  startedAt?: string | Date;
}

export interface FleetRepoCardLike {
  repoName?: string;
  lastStatus?: string;
  lastStatusLevel?: 'ok' | 'warn' | 'error' | 'unknown';
  updatedAt?: string | Date;
  commitsAhead?: number;
}

export interface InFlight {
  assignedAgent?: string;
  startedAt?: string | Date;
}

export interface LastShip {
  status?: string;
  level?: 'ok' | 'warn' | 'error' | 'unknown';
  at?: string | Date;
  commitsAhead?: number;
}

const QUEUED_STATUSES = new Set(['pending', 'working']);
const ATTENTION_STATUSES = new Set(['blocked', 'dead_letter']);

/**
 * At most one working task per repo (ADR-011 per-repo lease convention). If a
 * repo somehow has more than one `working` row at once, the earliest
 * `startedAt` wins — the task that's actually been running longest, not
 * whichever row the query happened to return last.
 */
export function buildInFlightByRepo(tasks: FleetTaskLike[]): Record<string, InFlight> {
  const out: Record<string, InFlight> = {};
  for (const t of tasks) {
    if (t.status !== 'working') continue;
    const existing = out[t.repo];
    const ts = t.startedAt ? new Date(t.startedAt).getTime() : Infinity;
    const existingTs = existing?.startedAt ? new Date(existing.startedAt).getTime() : Infinity;
    if (!existing || ts < existingTs) {
      out[t.repo] = { assignedAgent: t.assignedAgent, startedAt: t.startedAt };
    }
  }
  return out;
}

/** Queue depth (pending + working) per repo, from one unfiltered tasks_list call. */
export function buildQueueDepthByRepo(tasks: FleetTaskLike[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tasks) {
    if (!QUEUED_STATUSES.has(t.status)) continue;
    out[t.repo] = (out[t.repo] ?? 0) + 1;
  }
  return out;
}

/** Last-ship snapshot per repo, straight off each repo's App Directory card. */
export function buildLastShipByRepo(cards: FleetRepoCardLike[]): Record<string, LastShip> {
  const out: Record<string, LastShip> = {};
  for (const c of cards) {
    if (!c.repoName) continue;
    out[c.repoName] = { status: c.lastStatus, level: c.lastStatusLevel, at: c.updatedAt, commitsAhead: c.commitsAhead };
  }
  return out;
}

export interface FleetSummary {
  repos: number;
  queueDepth: number;
  inFlight: number;
  needsAttention: number;
}

/**
 * Fleet-wide summary strip totals. `repoCount` is caller-supplied (the known
 * repo set — cards ∪ repos with tasks — since an empty-queue repo wouldn't
 * otherwise appear here); everything else derives from one unfiltered
 * tasks_list call.
 */
export function fleetSummary(tasks: FleetTaskLike[], repoCount: number): FleetSummary {
  let queueDepth = 0;
  let inFlight = 0;
  let needsAttention = 0;
  for (const t of tasks) {
    if (QUEUED_STATUSES.has(t.status)) queueDepth += 1;
    if (t.status === 'working') inFlight += 1;
    if (ATTENTION_STATUSES.has(t.status)) needsAttention += 1;
  }
  return { repos: repoCount, queueDepth, inFlight, needsAttention };
}
