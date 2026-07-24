// /api/search — cross-entity search index: tasks, plans, and directory repos
// (tenant-scoped Mongo mirrors) plus brain atoms/sessions (proxied to the
// gateway's federated brain_search — see api/brain/search/route.ts for the
// same proxy pattern; the gateway resolves tenant server-side, never trusted
// from the client per lib/tenant.ts). This is the backing search layer
// beneath (distinct from) the Cmd-K palette (command-palette-logic.ts), which
// only resolves nav/repo/tenant/action shortcuts, not entity content.
//
// All scoring/ranking is pure logic in lib/search.ts — this route stays a
// thin fetch-and-rank shell (same split as api/projects/route.ts delegating
// to lib/projects.ts).
import { NextRequest, NextResponse } from 'next/server';
import { connectDB, Task, PlanDay, RepoCard } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { callGateway } from '@/lib/gateway';
import {
  tokenize,
  clampLimit,
  parseKinds,
  rankTasks,
  rankPlans,
  rankRepos,
  mapBrainHits,
  mergeResults,
  type SearchHit,
  type SearchHitKind,
  type TaskLike,
  type PlanLike,
  type RepoLike,
  type BrainHitLike,
} from '@/lib/search';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The Mongo-backed kinds are scanned (not paged) then ranked in-process, same
// approach as brain-search.ts's atom scan — fine at this corpus size, and it
// keeps the index logic DB-agnostic and unit-testable.
const SCAN_CAP = 500;

interface FederatedBrainSearchResult {
  hits: BrainHitLike[];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const q = (searchParams.get('q') ?? '').trim();
  if (!q) return NextResponse.json({ error: 'q is required' }, { status: 400 });

  const limit = clampLimit(Number(searchParams.get('limit') ?? '') || undefined);
  const kinds = parseKinds(searchParams.get('types'));
  const terms = tokenize(q);

  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const wantsMongo = kinds.has('task') || kinds.has('plan') || kinds.has('repo');
  if (wantsMongo) await connectDB();
  const wantsBrain = kinds.has('atom') || kinds.has('session');

  const [taskDocs, planDocs, repoDocs, brainResult] = await Promise.all([
    kinds.has('task')
      ? (Task.find(tf).select('taskId repo title description').limit(SCAN_CAP).lean() as unknown as Promise<TaskLike[]>)
      : Promise.resolve([] as TaskLike[]),
    kinds.has('plan')
      ? (PlanDay.find(tf).select('repo day focus notes').limit(SCAN_CAP).lean() as unknown as Promise<PlanLike[]>)
      : Promise.resolve([] as PlanLike[]),
    kinds.has('repo')
      ? (RepoCard.find(tf).select('repoName description group').limit(SCAN_CAP).lean() as unknown as Promise<RepoLike[]>)
      : Promise.resolve([] as RepoLike[]),
    wantsBrain
      ? callGateway<FederatedBrainSearchResult>('brain_search', { query: q, k: limit })
      : Promise.resolve(null),
  ]);

  const groups: Record<SearchHitKind, SearchHit[]> = { task: [], plan: [], repo: [], atom: [], session: [] };
  groups.task = kinds.has('task') ? rankTasks(taskDocs, terms, limit) : [];
  groups.plan = kinds.has('plan') ? rankPlans(planDocs, terms, limit) : [];
  groups.repo = kinds.has('repo') ? rankRepos(repoDocs, terms, limit) : [];
  if (brainResult?.hits?.length) {
    const mapped = mapBrainHits(brainResult.hits);
    groups.atom = kinds.has('atom') ? mapped.filter((h) => h.kind === 'atom').slice(0, limit) : [];
    groups.session = kinds.has('session') ? mapped.filter((h) => h.kind === 'session').slice(0, limit) : [];
  }

  const results = mergeResults(Object.values(groups), limit * Object.keys(groups).length);

  return NextResponse.json({ query: q, count: results.length, groups, results });
}
