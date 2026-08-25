// /api/views/[viewId] — resolve or delete one saved task-board view (task-e8aaf32e).
//
// GET    → TENANT-scoped (deliberately NOT user-scoped): a saved view is
//          shareable within its tenant, so any member who receives a
//          /work?view=<id> link can resolve it. Never crosses tenants.
// DELETE → OWNER-scoped (tenant + user): only the user who saved a view can
//          delete it.
import { NextResponse } from 'next/server';
import { connectDB, SavedView } from '@/lib/db';
import { getActiveViewer } from '@/lib/viewer';
import { VIEW_ID_RE, type SavedViewSummary } from '@/lib/saved-views';

// NOTE: plain { tenantId } equality (not lib/tenant-cookie tenantFilter) —
// savedviews is a NEW dashboard-owned collection whose writer always stamps
// tenantId, so the pre-ADR-010 missing-tenantId catch-all doesn't apply.

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ viewId: string }> }) {
  const { viewId } = await params;
  if (!VIEW_ID_RE.test(viewId)) {
    return NextResponse.json({ error: 'invalid view id' }, { status: 400 });
  }
  try {
    const { tenantId } = await getActiveViewer();
    await connectDB();
    const view = await SavedView.findOne({ tenantId, viewId })
      .lean() as unknown as SavedViewSummary | null;
    if (!view) return NextResponse.json({ error: 'view not found' }, { status: 404 });
    return NextResponse.json({ view: { viewId: view.viewId, name: view.name, filters: view.filters ?? {} } });
  } catch (err) {
    console.error('[api/views] GET one failed:', err);
    return NextResponse.json({ error: 'could not load view' }, { status: 500 });
  }
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ viewId: string }> }) {
  const { viewId } = await params;
  if (!VIEW_ID_RE.test(viewId)) {
    return NextResponse.json({ error: 'invalid view id' }, { status: 400 });
  }
  try {
    const { tenantId, userId } = await getActiveViewer();
    await connectDB();
    const result = await SavedView.deleteOne({ tenantId, userId, viewId });
    if (result.deletedCount === 0) {
      return NextResponse.json({ error: 'view not found' }, { status: 404 });
    }
    return NextResponse.json({ ok: true, viewId });
  } catch (err) {
    console.error('[api/views] DELETE failed:', err);
    return NextResponse.json({ error: 'could not delete view' }, { status: 500 });
  }
}
