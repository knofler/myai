// Cross-entity search — pure scoring/ranking logic (no DOM, no DB, no
// gateway fetch). api/search/route.ts stays a thin fetch-and-rank shell
// around these functions (same split as command-palette-logic.ts /
// nav-groups.ts). Spans four entity kinds — tasks, plans, directory repos
// (all tenant-scoped Mongo mirrors), and brain atoms/sessions (the gateway's
// already-tenant-scoped federated brain_search, see api/brain/search/route.ts)
// — merged into one ranked result set. This is the backing index beneath
// (distinct from) the Cmd-K palette: the palette only resolves nav/repo/
// tenant/action *shortcuts*, never searches entity content.

export type SearchHitKind = 'task' | 'plan' | 'repo' | 'atom' | 'session';

export const SEARCH_KINDS: SearchHitKind[] = ['task', 'plan', 'repo', 'atom', 'session'];

export interface SearchHit {
  kind: SearchHitKind;
  id: string;
  title: string;
  snippet: string;
  repo?: string;
  href: string;
  score: number;
}

export interface TaskLike {
  taskId: string;
  repo: string;
  title: string;
  description?: string;
}

export interface PlanLike {
  repo: string;
  day: number;
  focus: string;
  notes?: string;
}

export interface RepoLike {
  repoName: string;
  description?: string;
  group?: string;
}

/** Shape of one hit from the gateway's federated brain_search (runtime/src/core/brain-search.ts BrainSearchHit). */
export interface BrainHitLike {
  kind: 'atom' | 'session';
  repo: string;
  score: number;
  snippet: string;
  atomKind?: string;
  sessionId?: string;
}

const SNIPPET_CHARS = 160;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

/** Clamp a requested per-kind result limit into (0, MAX_LIMIT], falling back to DEFAULT_LIMIT for anything not a positive number. */
export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT, max = MAX_LIMIT): number {
  const n = Math.trunc(limit ?? NaN);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

/** Parse a `types=task,plan` query param into a validated kind set; empty/invalid input means "all kinds". */
export function parseKinds(typesParam: string | null | undefined): Set<SearchHitKind> {
  if (!typesParam) return new Set(SEARCH_KINDS);
  const requested = typesParam
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter((t): t is SearchHitKind => (SEARCH_KINDS as string[]).includes(t));
  return requested.length > 0 ? new Set(requested) : new Set(SEARCH_KINDS);
}

function collapse(text: string, max = SNIPPET_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Case-insensitive term-frequency count — the same scorer brain-search.ts uses for atoms, kept consistent so relevance doesn't feel different per entity kind. */
export function scoreText(haystack: string, terms: string[]): number {
  const lower = haystack.toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (!term) continue;
    let idx = lower.indexOf(term);
    while (idx !== -1) {
      score += 1;
      idx = lower.indexOf(term, idx + term.length);
    }
  }
  return score;
}

/** The first line mentioning a query term, tightened; else the head of the body. */
function snippetFor(body: string, terms: string[]): string {
  for (const line of body.split('\n')) {
    const lower = line.toLowerCase();
    if (line.trim() && terms.some((t) => lower.includes(t))) return collapse(line);
  }
  return collapse(body);
}

export function rankTasks(tasks: TaskLike[], terms: string[], limit: number): SearchHit[] {
  return tasks
    .map((task) => ({ task, score: scoreText(`${task.title} ${task.description ?? ''}`, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ task, score }) => ({
      kind: 'task' as const,
      id: task.taskId,
      title: task.title,
      snippet: snippetFor(task.description || task.title, terms),
      repo: task.repo,
      href: `/work?repo=${encodeURIComponent(task.repo)}`,
      score,
    }));
}

export function rankPlans(plans: PlanLike[], terms: string[], limit: number): SearchHit[] {
  return plans
    .map((plan) => ({ plan, score: scoreText(`${plan.focus} ${plan.notes ?? ''}`, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ plan, score }) => ({
      kind: 'plan' as const,
      id: `${plan.repo}-day${plan.day}`,
      title: `${plan.repo} · Day ${plan.day}: ${plan.focus}`,
      snippet: snippetFor(plan.notes || plan.focus, terms),
      repo: plan.repo,
      href: `/work?tab=plans&repo=${encodeURIComponent(plan.repo)}`,
      score,
    }));
}

export function rankRepos(repos: RepoLike[], terms: string[], limit: number): SearchHit[] {
  return repos
    .map((repo) => ({ repo, score: scoreText(`${repo.repoName} ${repo.description ?? ''} ${repo.group ?? ''}`, terms) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ repo, score }) => ({
      kind: 'repo' as const,
      id: repo.repoName,
      title: repo.repoName,
      snippet: collapse(repo.description || repo.group || repo.repoName),
      repo: repo.repoName,
      href: `/apps?tab=health&repo=${encodeURIComponent(repo.repoName)}`,
      score,
    }));
}

/** Map the gateway's already-scored+ranked brain hits into the shared SearchHit shape — no re-scoring, since brain-search.ts already normalizes atom/session scores to [0,1] before returning them. */
export function mapBrainHits(hits: BrainHitLike[]): SearchHit[] {
  return hits.map((hit, i) => ({
    kind: hit.kind,
    id: hit.sessionId || `${hit.kind}-${hit.repo}-${i}`,
    title: hit.kind === 'atom' ? `${hit.repo} · ${hit.atomKind ?? 'atom'}` : `${hit.repo} · session`,
    snippet: collapse(hit.snippet),
    repo: hit.repo,
    href: hit.kind === 'atom' ? `/brain?tab=atoms&repo=${encodeURIComponent(hit.repo)}` : `/memory?tab=sessions&repo=${encodeURIComponent(hit.repo)}`,
    score: hit.score,
  }));
}

/** Normalize a group's scores to [0, 1] so a term-count scale (tasks/plans/repos) merges with the brain's already-[0,1] score without one dominating purely by scorer magnitude. A no-op (score 1) when every hit in the group ties. */
function normalize(hits: SearchHit[]): SearchHit[] {
  if (hits.length === 0) return hits;
  const scores = hits.map((h) => h.score);
  const max = Math.max(...scores);
  const min = Math.min(...scores);
  const range = max - min;
  return hits.map((h) => ({ ...h, score: range > 0 ? (h.score - min) / range : 1 }));
}

/** Merge per-kind result groups into one ranked, capped list for the "All" view. */
export function mergeResults(groups: SearchHit[][], limit: number): SearchHit[] {
  const merged = groups.flatMap((g) => normalize(g));
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}
