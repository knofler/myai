// POST /api/apps/new — the "New App" flow (MVP M3 / §7.2 Day 5).
//
// A tenant describes an app idea behind the dashboard; this route does the two
// halves of M3 atomically, scoped to the active tenant:
//
//   1. REGISTERS the new repo in the gateway directory — an App Directory card
//      (RepoCard) appears immediately on /apps with a "scaffolding queued"
//      status, so the operator sees the app the moment they submit.
//   2. TRIGGERS the agentFlow pipeline — a `pending` task is queued for the
//      off-hours runner (per-tenant pickup, M4) carrying the idea + an explicit
//      `init blueprint` / agentFlow scaffold instruction. The runner scaffolds
//      the repo and builds it on the next free-window run, landing on `test`
//      for `ship it` review.
//
// TENANCY: writes go straight to the dashboard's Mongo connection with the
// active tenant id — the same pattern the M2 signup route uses (Tenant.create).
// We do NOT route through the gateway here: the in-cluster bridge token always
// resolves to the *default* tenant (see runtime/src/core/auth.ts resolveNoKey),
// which would mis-scope a real tenant's app. The runner and /apps + /work views
// read these same tenant-scoped collections, so the loop stays consistent.
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { connectDB, RepoCard, Task } from '@/lib/db';
import { getActiveTenant } from '@/lib/tenant';
import { validateNewAppInput, buildScaffoldTaskDescription } from '@/lib/new-app';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const validated = validateNewAppInput(body);
  if (!validated.ok) return NextResponse.json(validated.error, { status: 400 });
  const { name, description, githubSlug, priority } = validated.input;
  const { repoName } = validated;

  const tenantId = await getActiveTenant();

  try {
    await connectDB();

    // Idempotency / dedupe: one card per (tenant, repoName). A re-submit of the
    // same app is a no-op-ish 409 rather than a second scaffold task.
    const existing = await RepoCard.findOne({ tenantId, repoName }).lean();
    if (existing) {
      return NextResponse.json(
        { error: `an app named "${repoName}" already exists in your directory` },
        { status: 409 },
      );
    }

    const now = new Date();
    const githubUrl = githubSlug ? `https://github.com/${githubSlug}` : undefined;

    // ── 1. Register the repo in the gateway directory ──────────────
    await RepoCard.create({
      tenantId,
      repoName,
      description,
      group: 'New Apps',
      appUrl: githubUrl,
      lastStatus:
        'Queued — the agentFlow pipeline (init blueprint) will scaffold this app on the next off-hours run.',
      lastStatusLevel: 'warn',
      reportedBy: 'dashboard:new-app',
      createdAt: now,
      updatedAt: now,
    });

    // ── 2. Trigger the agentFlow pipeline (off-hours runner picks it up) ──
    const taskId = `task-${randomUUID()}`;
    await Task.create({
      tenantId,
      taskId,
      repo: repoName,
      title: `New App: ${name} — init blueprint + build`,
      description: buildScaffoldTaskDescription({ name, description, githubSlug }, repoName),
      priority,
      status: 'pending',
      assignedAgent: 'solution-architect',
      recommendedModel: 'claude-fable-5',
      source: 'manual',
      sourceId: `new-app:${repoName}`,
      notes: githubSlug ? `GitHub: ${githubSlug}` : undefined,
      createdAt: now,
      updatedAt: now,
    });

    return NextResponse.json({
      ok: true,
      repoName,
      taskId,
      message: `"${name}" registered and queued for the agentFlow pipeline.`,
    });
  } catch (err) {
    console.error('[apps/new] failed:', err);
    return NextResponse.json({ error: 'could not create app — try again' }, { status: 500 });
  }
}
