// /api/projects — bulk multi-repo orchestration mutations (ADR-015 Phase 2).
//
// The cross-repo task board's two levers, server-side so a batch is created /
// reprioritized atomically-ish and audited (one log line) rather than N
// dashboard round-trips:
//
//   • POST {action:'fanout'}       — one task description → N repo-stamped tasks
//                                     linked by a shared batchId, cap-enforced.
//   • POST {action:'reprioritize'} — bump a set of tasks (by id) or a whole
//                                     repo's pending queue to a new priority.
//
// TENANCY: writes go straight to the dashboard's Mongo connection scoped to the
// active tenant — the same pattern the New App flow (api/apps/new) and the
// connector manager use, NOT the gateway bridge token (which resolves to the
// default tenant and would mis-scope a real tenant's tasks). The runner and
// /work + /projects views read these same tenant-scoped collections, so the
// loop stays consistent. This deliberately does NOT rebuild any execution
// machinery: fan-out tasks are ordinary queue tasks the off-hours runner picks
// up like any other (ADR-015 §5).
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { connectDB, Task, RepoCard, FleetRun } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { planFanout, fanoutPreamble, PRIORITIES, type Priority } from '@/lib/projects';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// GET — the tenant's known repo names (RepoCard directory), sorted. Powers the
// command palette's "jump to repo" / "dispatch a task" quick actions, which
// need a repo list client-side without re-fetching the whole /projects rollup.
export async function GET() {
  await connectDB();
  const tenantId = await getActiveTenant();
  const cards = await RepoCard.find(tenantFilter(tenantId)).select('repoName').lean() as unknown as Array<{ repoName?: string }>;
  const repos = Array.from(new Set(cards.map((c) => c.repoName).filter((r): r is string => !!r))).sort((a, b) => a.localeCompare(b));
  return NextResponse.json({ repos });
}

// Team tier repo cap (ADR-015 §4 guardrail); planFanout also clamps to MAX_FANOUT.
const DEFAULT_REPO_LIMIT = 25;

async function handleFanout(tenantId: string, body: Record<string, unknown>) {
  const reposIn = Array.isArray(body.repos) ? (body.repos as unknown[]).map(String) : [];
  const plan = planFanout({
    repos: reposIn,
    title: typeof body.title === 'string' ? body.title : '',
    priority: body.priority as Priority | undefined,
    topology: body.topology as never,
    planRepoLimit: DEFAULT_REPO_LIMIT,
  });
  if (!plan.ok) return NextResponse.json({ error: plan.error }, { status: 400 });

  await connectDB();
  const batchId = `batch-${randomUUID().slice(0, 8)}`;
  const now = new Date();
  const details = typeof body.details === 'string' ? body.details.trim() : '';
  const assignedAgent = typeof body.assignedAgent === 'string' && body.assignedAgent.trim()
    ? body.assignedAgent.trim()
    : undefined;

  const docs = plan.repos.map((repo) => {
    const preamble = fanoutPreamble(plan.topology, plan.repos, batchId);
    return {
      tenantId,
      taskId: `task-${randomUUID()}`,
      repo,
      title: plan.title,
      description: details ? `${preamble}\n\n${details}` : preamble,
      priority: plan.priority,
      status: 'pending' as const,
      assignedAgent,
      source: 'manual' as const,
      sourceId: batchId,
      notes: `fan-out batch ${batchId}${plan.topology ? ` · ${plan.topology}` : ''}`,
      createdAt: now,
      updatedAt: now,
    };
  });

  const created = await Task.insertMany(docs, { ordered: false });
  console.log(`[api/projects] fanout ${batchId}: ${created.length} tasks across ${plan.repos.length} repos (tenant ${tenantId})`);

  // ADR-015 §3: give the batch its own FleetRun so a tenant fanning a task
  // across N repos has one place to check "how is my batch doing" instead of
  // opening N tabs on /work. type:'task-fanout' keeps it out of /fleet's
  // morning-resume-all console (that query filters the type out — see
  // dashboard/src/app/fleet/page.tsx). Best-effort: a failure here must not
  // roll back the tasks that already landed.
  try {
    await FleetRun.create({
      tenantId,
      runId: batchId,
      type: 'task-fanout',
      status: 'running',
      startedAt: now,
      repos: plan.repos.map((repo) => ({ repo, recommendation: 'pending', actionStatus: 'pending', updatedAt: now })),
      summary: { total: plan.repos.length, needsAction: plan.repos.length, shipped: 0, failed: 0 },
    });
  } catch (err) {
    console.error(`[api/projects] fanout ${batchId}: FleetRun.create failed (tasks still created):`, err);
  }

  return NextResponse.json({
    ok: true,
    batchId,
    priority: plan.priority,
    topology: plan.topology ?? null,
    taskIds: created.map((t: { taskId?: string }) => t.taskId),
    count: created.length,
  });
}

async function handleReprioritize(tenantId: string, body: Record<string, unknown>) {
  const priority = body.priority as Priority;
  if (!PRIORITIES.includes(priority)) {
    return NextResponse.json({ error: 'priority must be one of P0, P1, P2, P3' }, { status: 400 });
  }

  await connectDB();
  const tf = tenantFilter(tenantId);
  const now = new Date();

  // Two targeting modes: an explicit set of taskIds, or every pending task in a
  // repo. Only pending tasks are ever reprioritized — a working/review/done task
  // must not have its priority yanked mid-flight.
  const taskIds = Array.isArray(body.taskIds) ? (body.taskIds as unknown[]).map(String).filter(Boolean) : [];
  const repo = typeof body.repo === 'string' ? body.repo.trim() : '';

  let filter: Record<string, unknown>;
  if (taskIds.length > 0) {
    filter = { ...tf, taskId: { $in: taskIds }, status: 'pending' };
  } else if (repo) {
    filter = { ...tf, repo, status: 'pending' };
  } else {
    return NextResponse.json({ error: 'provide taskIds[] or a repo' }, { status: 400 });
  }

  const res = await Task.updateMany(filter, { $set: { priority, updatedAt: now } });
  console.log(`[api/projects] reprioritize → ${priority}: ${res.modifiedCount} tasks (tenant ${tenantId})`);
  return NextResponse.json({ ok: true, priority, modified: res.modifiedCount ?? 0 });
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const action = typeof body.action === 'string' ? body.action : '';
  const tenantId = await getActiveTenant();

  try {
    if (action === 'fanout') return await handleFanout(tenantId, body);
    if (action === 'reprioritize') return await handleReprioritize(tenantId, body);
    return NextResponse.json({ error: `unknown action "${action}"` }, { status: 400 });
  } catch (err) {
    console.error('[api/projects] POST failed:', err);
    return NextResponse.json({ error: 'orchestration operation failed' }, { status: 500 });
  }
}
