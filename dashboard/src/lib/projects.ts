// Multi-repo orchestration — pure logic for the cross-repo task board (ADR-015).
//
// A "project" is a named repo group (`RepoCard.group`) given a first-class UI
// axis: ungrouped repos fall under an implicit "Ungrouped" project (zero
// migration — today's flat directory renders as one project). This module holds
// the PURE, DOM-free logic that the /projects server page and /api/projects
// route share, so both the rollup maths and the fan-out/reprioritize guardrails
// are unit-testable without a database or a browser.

export type StatusLevel = 'ok' | 'warn' | 'error' | 'unknown';
export type TaskStatus = 'pending' | 'working' | 'review' | 'done' | 'blocked';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';
export type Topology = 'hierarchical' | 'star' | 'mesh' | 'ring';

/** The implicit bucket for repos without a `group`. */
export const UNGROUPED = 'Ungrouped';

export const PRIORITIES: Priority[] = ['P0', 'P1', 'P2', 'P3'];
export const PRIORITY_ORDER: Record<Priority, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

// v1 offers only the topologies today's independent-lane runner maps onto
// honestly (ADR-015 §3 "the honest v1"); mesh/ring are agent-coordinated and
// deliberately not selectable as a strategy hint yet.
export const OFFERED_TOPOLOGIES: Topology[] = ['hierarchical', 'star'];

// Worst-wins ordering for a project's health rollup: a single errored repo
// colours the whole project red.
const LEVEL_RANK: Record<StatusLevel, number> = { unknown: 0, ok: 1, warn: 2, error: 3 };

export interface RepoCardLike {
  repoName?: string;
  group?: string;
  lastStatusLevel?: StatusLevel;
}

/** Per-repo task counts, keyed by status (missing keys treated as 0). */
export type RepoTaskCounts = Partial<Record<TaskStatus, number>>;

export interface ProjectMeta {
  label?: string;
  color?: string;
  description?: string;
}

export interface RepoRollup {
  repo: string;
  level: StatusLevel;
  counts: Required<Record<TaskStatus, number>>;
  open: number; // pending + working — the actionable backlog
}

export interface ProjectRollup {
  group: string; // slug / group key ("Ungrouped" for the implicit bucket)
  label: string; // display label (from meta, else the group key)
  color?: string;
  description?: string;
  repos: RepoRollup[];
  repoCount: number;
  level: StatusLevel; // worst-wins across the project's repos
  counts: Required<Record<TaskStatus, number>>; // summed across repos
  open: number; // summed pending + working
}

const ZERO_COUNTS = (): Required<Record<TaskStatus, number>> => ({
  pending: 0,
  working: 0,
  review: 0,
  done: 0,
  blocked: 0,
});

/** The worse of two health levels (unknown < ok < warn < error). */
export function worstLevel(a: StatusLevel | undefined, b: StatusLevel | undefined): StatusLevel {
  const ra = LEVEL_RANK[a ?? 'unknown'];
  const rb = LEVEL_RANK[b ?? 'unknown'];
  return ra >= rb ? (a ?? 'unknown') : (b ?? 'unknown');
}

/** Normalise a repo's status counts into a fully-populated shape + open total. */
function rollupRepo(repo: string, level: StatusLevel, counts: RepoTaskCounts): RepoRollup {
  const full = ZERO_COUNTS();
  for (const k of Object.keys(full) as TaskStatus[]) full[k] = counts[k] ?? 0;
  return { repo, level, counts: full, open: full.pending + full.working };
}

/**
 * Fold repo cards + per-repo task counts into per-project rollups (worst-wins
 * health, summed task counts). Repos with no `group` collect under "Ungrouped".
 * Any repo that has tasks but no card still appears (as an Ungrouped, unknown-
 * health repo) so the board never hides queued work behind a missing card.
 *
 * Returns projects sorted by actionable backlog (open desc) then label, with
 * "Ungrouped" always last so named projects lead.
 */
export function buildProjectRollups(
  cards: RepoCardLike[],
  taskCounts: Record<string, RepoTaskCounts>,
  meta: Record<string, ProjectMeta> = {},
): ProjectRollup[] {
  const cardByRepo = new Map<string, RepoCardLike>();
  for (const c of cards) if (c.repoName) cardByRepo.set(c.repoName, c);

  // Every repo we know about — from a card or from having tasks queued.
  const repos = new Set<string>([...cardByRepo.keys(), ...Object.keys(taskCounts)]);

  const groups = new Map<string, RepoRollup[]>();
  for (const repo of repos) {
    const card = cardByRepo.get(repo);
    const group = card?.group?.trim() || UNGROUPED;
    const rollup = rollupRepo(repo, card?.lastStatusLevel ?? 'unknown', taskCounts[repo] ?? {});
    const list = groups.get(group) ?? [];
    list.push(rollup);
    groups.set(group, list);
  }

  const projects: ProjectRollup[] = [];
  for (const [group, repoRollups] of groups) {
    repoRollups.sort((a, b) => b.open - a.open || a.repo.localeCompare(b.repo));
    const counts = ZERO_COUNTS();
    let level: StatusLevel = 'unknown';
    for (const r of repoRollups) {
      for (const k of Object.keys(counts) as TaskStatus[]) counts[k] += r.counts[k];
      level = worstLevel(level, r.level);
    }
    const m = meta[group] ?? {};
    projects.push({
      group,
      label: m.label?.trim() || group,
      color: m.color,
      description: m.description,
      repos: repoRollups,
      repoCount: repoRollups.length,
      level,
      counts,
      open: counts.pending + counts.working,
    });
  }

  projects.sort((a, b) => {
    if (a.group === UNGROUPED) return 1;
    if (b.group === UNGROUPED) return -1;
    return b.open - a.open || a.label.localeCompare(b.label);
  });
  return projects;
}

export interface FanoutInput {
  repos: string[];
  title: string;
  priority?: Priority;
  topology?: Topology;
  planRepoLimit?: number; // tenant plan repo cap (Team = 15)
}

export interface FanoutPlan {
  ok: boolean;
  error?: string;
  repos: string[]; // de-duplicated, order-preserved
  title: string;
  priority: Priority;
  topology?: Topology;
}

/** Hard ceiling on a single batch regardless of plan (ADR-015 §4 guardrail). */
export const MAX_FANOUT = 25;

/**
 * Validate + normalise a fan-out request: de-dupe repos, enforce the batch cap
 * and the tenant's plan repo limit, require a title, and coerce priority. This
 * is the guardrail the API route trusts — every task the composer creates is an
 * ordinary queue task, so a bad batch must be rejected before any write.
 */
export function planFanout(input: FanoutInput): FanoutPlan {
  const priority: Priority = PRIORITIES.includes(input.priority as Priority)
    ? (input.priority as Priority)
    : 'P2';
  const topology = OFFERED_TOPOLOGIES.includes(input.topology as Topology)
    ? (input.topology as Topology)
    : undefined;

  const title = (input.title ?? '').trim();
  const repos = Array.from(new Set((input.repos ?? []).map((r) => r.trim()).filter(Boolean)));

  const base: Omit<FanoutPlan, 'ok' | 'error'> = { repos, title, priority, topology };

  if (!title) return { ...base, ok: false, error: 'A task description is required.' };
  if (title.length > 300) return { ...base, ok: false, error: 'Task description too long (max 300 chars).' };
  if (repos.length === 0) return { ...base, ok: false, error: 'Select at least one repo.' };

  const cap = Math.min(MAX_FANOUT, input.planRepoLimit ?? MAX_FANOUT);
  if (repos.length > cap) {
    return { ...base, ok: false, error: `Batch too large: ${repos.length} repos exceeds the limit of ${cap}.` };
  }
  return { ...base, ok: true };
}

/**
 * The `details` preamble stamped on each fan-out task so the runner/agent knows
 * it is one independent lane of a coordinated batch. Honest about semantics:
 * hierarchical/star map onto today's independent-lane execution — the hint is a
 * strategy note, not a synchronization guarantee (ADR-015 §3).
 */
export function fanoutPreamble(topology: Topology | undefined, repos: string[], batchId: string): string {
  const others = repos.join(', ');
  const strategy = topology ? `${topology}-topology ` : '';
  return `[batch ${batchId}] Part of a ${strategy}multi-repo batch across: ${others}. Independent lane — do not couple to the other repos' work.`;
}

/** Priority one step more/less urgent, clamped at the ends (drag / bump). */
export function bumpPriority(current: Priority, direction: 'up' | 'down'): Priority {
  const idx = PRIORITY_ORDER[current] ?? 2;
  const next = direction === 'up' ? Math.max(0, idx - 1) : Math.min(PRIORITIES.length - 1, idx + 1);
  return PRIORITIES[next];
}
