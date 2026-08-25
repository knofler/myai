// /api/views — saved task-board views (task-e8aaf32e).
//
// GET  → the current user's saved views (tenant + user scoped).
// POST → save the current filter set as a named view. Saving an existing name
//        overwrites that view's filters (upsert-by-name), so re-saving a
//        recurring triage lens never piles up duplicates.
//
// TENANCY / IDENTITY: like /api/recurring, writes go straight to the
// dashboard's Mongo connection. Scope comes from getActiveViewer — the
// gateway-verified session identity, falling back to the default tenant's
// local-operator on unauthenticated local installs — never from a
// client-writable cookie (see lib/tenant.ts / GHSA-ffgf-pmmg-cjj5).
import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { connectDB, SavedView } from '@/lib/db';
import { getActiveViewer } from '@/lib/viewer';
import { parseSavedViewCreate, MAX_VIEWS_PER_USER, type SavedViewSummary } from '@/lib/saved-views';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function newViewId(): string {
  return `sv-${crypto.randomBytes(6).toString('hex')}`;
}

interface SavedViewRow extends SavedViewSummary {
  updatedAt?: Date;
}

export async function GET() {
  try {
    const { tenantId, userId } = await getActiveViewer();
    await connectDB();
    const views = await SavedView.find({ tenantId, userId })
      .sort({ name: 1 })
      .limit(MAX_VIEWS_PER_USER)
      .lean() as unknown as SavedViewRow[];
    return NextResponse.json({
      views: views.map((v) => ({ viewId: v.viewId, name: v.name, filters: v.filters ?? {} })),
    });
  } catch (err) {
    console.error('[api/views] GET failed:', err);
    return NextResponse.json({ error: 'could not load saved views' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const parsed = parseSavedViewCreate(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });

  try {
    const { tenantId, userId } = await getActiveViewer();
    await connectDB();
    const now = new Date();

    // Upsert-by-name: same name for the same user updates in place.
    const existing = await SavedView.findOne({ tenantId, userId, name: parsed.name })
      .lean() as unknown as SavedViewRow | null;
    if (existing) {
      await SavedView.updateOne(
        { tenantId, userId, viewId: existing.viewId },
        { $set: { filters: parsed.filters, updatedAt: now } },
      );
      return NextResponse.json({ ok: true, view: { viewId: existing.viewId, name: parsed.name, filters: parsed.filters }, updated: true });
    }

    const count = await SavedView.countDocuments({ tenantId, userId });
    if (count >= MAX_VIEWS_PER_USER) {
      return NextResponse.json({ error: `view limit reached (${MAX_VIEWS_PER_USER}) — delete one first` }, { status: 400 });
    }

    const viewId = newViewId();
    await SavedView.create({ tenantId, userId, viewId, name: parsed.name, filters: parsed.filters, createdAt: now, updatedAt: now });
    return NextResponse.json({ ok: true, view: { viewId, name: parsed.name, filters: parsed.filters }, updated: false });
  } catch (err) {
    console.error('[api/views] POST failed:', err);
    return NextResponse.json({ error: 'could not save view' }, { status: 500 });
  }
}
