// /api/recurring/[recurringId] — the dashboard's one write to the recurring
// runner-task collection (task-b8ddab7d): the enabled on/off toggle rendered
// on /work's Recurring tab. Everything else (create/update/delete, the
// cron/next-fire bookkeeping) is gateway-owned via the recurring_tasks_* MCP
// tools; the toggle alone lives here so pausing a nightly job is one tap.
//
// TENANCY: like /api/connectors, the write goes straight to the dashboard's
// Mongo connection scoped to the active tenant (getActiveTenant derives it
// from the verified session — never from a client-writable cookie, see
// lib/tenant.ts / GHSA-ffgf-pmmg-cjj5).
import { NextResponse } from 'next/server';
import { connectDB, RecurringTask } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request, { params }: { params: Promise<{ recurringId: string }> }) {
  const { recurringId } = await params;
  let body: { enabled?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  if (typeof body.enabled !== 'boolean') {
    return NextResponse.json({ error: 'enabled (boolean) is required — this route only toggles' }, { status: 400 });
  }

  try {
    const tenantId = await getActiveTenant();
    await connectDB();
    const result = await RecurringTask.updateOne(
      { ...tenantFilter(tenantId), recurringId },
      { $set: { enabled: body.enabled, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      return NextResponse.json({ error: 'recurring task not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, recurringId, enabled: body.enabled });
  } catch (err) {
    console.error('[api/recurring] PATCH failed:', err);
    return NextResponse.json({ error: 'could not update recurring task' }, { status: 500 });
  }
}
