// GET /api/notifications — recent notifier history for the active tenant.
//
// Backs the /notifications history page and the bell's initial load. The live
// feed for toasts is the SSE route (./stream). Both read from the gateway's
// `notifications_history` MCP tool via fetchNotificationHistory().
//
// REALTIME_NOTIFICATIONS plan, Phase 5.
import { NextResponse } from 'next/server';
import { fetchNotificationHistory } from '@/lib/notifications';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
  try {
    const notifications = await fetchNotificationHistory(limit);
    return NextResponse.json({ ok: true, count: notifications.length, notifications });
  } catch (err) {
    console.error('[api/notifications] GET failed:', err);
    return NextResponse.json({ ok: false, error: 'could not load notifications', notifications: [] }, { status: 500 });
  }
}
