// POST /api/onboarding/launch — the engine behind the /welcome/start first-run
// wizard (betaC). It does the two middle steps of the guided onboarding
// atomically, scoped to the active tenant, so a brand-new tenant gets real
// value with zero manual wiring:
//
//   1. CONNECTS the repo — upserts an App Directory card (RepoCard) for the
//      repo the operator named (existing GitHub repo via owner/repo, or a fresh
//      project name). The card shows on /apps immediately.
//   2. QUEUES the first task — a `pending` Task carrying the operator's own
//      description. The off-hours runner picks it up on the next free window,
//      lands work on `test`, and it surfaces in /work → Needs Review for a
//      `ship it`.
//
// TENANCY mirrors /api/apps/new: writes go straight to the dashboard's Mongo
// connection with the active tenant id (the in-cluster gateway bridge token
// always resolves to the *default* tenant, which would mis-scope a real
// tenant's work). The runner + /apps + /work views read these same
// tenant-scoped collections, so the loop stays consistent.
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { connectDB, RepoCard, Task } from '@/lib/db';
import { getActiveTenant } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
type Priority = (typeof PRIORITIES)[number];

// owner/repo — the GitHub slug shape.
const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

/** Stable, URL-safe repo name (no random suffix — predictable so the runner can
 *  target it and a re-submit dedupes rather than forking). Matches the helper
 *  in /api/apps/new. */
function slugifyRepoName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || ''
  );
}

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const repoInput = typeof body.repo === 'string' ? body.repo.trim() : '';
  const repoDescription = typeof body.repoDescription === 'string' ? body.repoDescription.trim() : '';
  const taskTitle = typeof body.taskTitle === 'string' ? body.taskTitle.trim() : '';
  const taskDescription = typeof body.taskDescription === 'string' ? body.taskDescription.trim() : '';
  const priority: Priority = PRIORITIES.includes(body.priority as Priority)
    ? (body.priority as Priority)
    : 'P2';

  if (!repoInput) return NextResponse.json({ error: 'a repo or project name is required' }, { status: 400 });
  if (repoInput.length > 120) return NextResponse.json({ error: 'repo name too long (max 120)' }, { status: 400 });
  if (!taskTitle) return NextResponse.json({ error: 'a first task is required' }, { status: 400 });
  if (taskTitle.length > 160) return NextResponse.json({ error: 'task title too long (max 160)' }, { status: 400 });
  if (taskDescription.length > 2000) return NextResponse.json({ error: 'task detail too long (max 2000)' }, { status: 400 });

  // The operator may type a GitHub slug (owner/repo) or a plain project name.
  const isSlug = SLUG_RE.test(repoInput);
  const repoName = slugifyRepoName(isSlug ? repoInput.split('/')[1] : repoInput);
  if (!repoName) {
    return NextResponse.json({ error: 'repo name must contain letters or numbers' }, { status: 400 });
  }
  const githubUrl = isSlug ? `https://github.com/${repoInput}` : undefined;

  const tenantId = await getActiveTenant();

  try {
    await connectDB();
    const now = new Date();

    // ── 1. Connect the repo (idempotent upsert) ───────────────────
    // First-run is forgiving: connecting a repo that already exists just reuses
    // its card and still queues the task — never a hard 409 mid-onboarding.
    const existing = await RepoCard.findOne({ tenantId, repoName }).lean();
    if (!existing) {
      await RepoCard.create({
        tenantId,
        repoName,
        description: repoDescription || `Connected during onboarding${githubUrl ? '' : ' (no GitHub repo linked)'}.`,
        group: 'My Repos',
        appUrl: githubUrl,
        lastStatus: 'Connected — first task queued for the off-hours runner.',
        lastStatusLevel: 'warn',
        reportedBy: 'dashboard:onboarding',
        createdAt: now,
        updatedAt: now,
      });
    }

    // ── 2. Queue the first task (off-hours runner picks it up) ─────
    const taskId = `task-${randomUUID()}`;
    const descriptionLines = [
      `First task queued from the onboarding wizard for repo "${repoName}".`,
      ...(githubUrl ? ['', `GitHub: ${repoInput}`] : []),
      ...(taskDescription ? ['', 'DETAIL:', taskDescription] : []),
      '',
      'Work this autonomously and land changes on `test` for a `ship it` review.',
    ];
    await Task.create({
      tenantId,
      taskId,
      repo: repoName,
      title: taskTitle,
      description: descriptionLines.join('\n'),
      priority,
      status: 'pending',
      // No assignedAgent — the dispatcher auto-selects the right specialist.
      source: 'manual',
      sourceId: `onboarding:${repoName}`,
      notes: 'quick win · onboarding first task',
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json({
      ok: true,
      repoName,
      taskId,
      reused: Boolean(existing),
      message: `"${taskTitle}" queued for ${repoName}. The off-hours runner will pick it up.`,
    });
  } catch (err) {
    console.error('[onboarding/launch] failed:', err);
    return NextResponse.json({ error: 'could not queue your first task — try again' }, { status: 500 });
  }
}
