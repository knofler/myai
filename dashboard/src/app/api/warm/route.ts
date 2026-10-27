// GET /api/warm — fill the server data cache for the slow brain reads.
// Called once by this server at startup (instrumentation.ts), or by a
// scheduler holding CRON_SECRET. Returns per-read timings, never data.
// 502 when a read failed, so a caller can tell a warm cache from a cold one.
import { NextResponse } from 'next/server';
import { connection } from 'next/server';
import { runWarm, warmAuthorized } from '@/lib/warm';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  await connection(); // always run per request — never prerender the warm-up at build time
  if (!warmAuthorized(req.headers)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const t = Date.now();
  const reads = await runWarm();
  const ok = reads.every((r) => r.ok);
  return NextResponse.json({ ok, ms: Date.now() - t, reads }, { status: ok ? 200 : 502 });
}
