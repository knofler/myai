// GET /api/changelog — recent CHANGELOG.md releases for the in-app "what's
// new" widget. Reads straight off the AI_ROOT mount (lib/changelog.ts) —
// no gateway round-trip needed, same as the /work Blockers tab reading
// config/user_blockers.md directly.
import { NextResponse } from 'next/server';
import { readChangelog } from '@/lib/changelog';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_LIMIT = 5;

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limitRaw = Number(url.searchParams.get('limit') ?? String(DEFAULT_LIMIT));
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 20) : DEFAULT_LIMIT;
  try {
    const releases = (await readChangelog()).slice(0, limit);
    return NextResponse.json({ ok: true, releases });
  } catch (err) {
    console.error('[api/changelog] GET failed:', err);
    return NextResponse.json({ ok: false, error: 'could not load changelog', releases: [] }, { status: 500 });
  }
}
