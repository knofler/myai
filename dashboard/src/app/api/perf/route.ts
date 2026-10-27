// /api/perf — page-speed telemetry (speed plan step 0).
//   POST: a batch of samples from components/perf-beacon.tsx (sendBeacon, so
//         the body may arrive as text/plain). Validated per sample; junk dropped.
//   GET:  ?hours=24 → p50/p95 per route × device × metric, slowest first.
// Operator-gated by middleware like every non-public /api route.
import { NextResponse } from 'next/server';
import { connectDB, PerfSample } from '@/lib/db';
import { MAX_BATCH, sanitizeSample, summarize, type PerfSample as Sample } from '@/lib/perf';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }
  const raw = Array.isArray(body) ? body.slice(0, MAX_BATCH) : [];
  const samples = raw.map(sanitizeSample).filter((s): s is Sample => s !== null);
  if (!samples.length) return NextResponse.json({ stored: 0 });
  try {
    await connectDB();
    await PerfSample.insertMany(samples, { ordered: false });
    return NextResponse.json({ stored: samples.length });
  } catch (err) {
    console.error('[perf] store failed:', err);
    return NextResponse.json({ error: 'store failed' }, { status: 500 });
  }
}

export async function GET(req: Request) {
  const hours = Math.min(24 * 14, Math.max(1, Number(new URL(req.url).searchParams.get('hours')) || 24));
  try {
    await connectDB();
    const since = new Date(Date.now() - hours * 3600_000);
    const rows = (await PerfSample.find({ createdAt: { $gte: since } }, { route: 1, device: 1, metric: 1, value: 1, _id: 0 })
      .limit(50_000)
      .lean()) as unknown as Sample[];
    return NextResponse.json({ hours, samples: rows.length, rows: summarize(rows) });
  } catch (err) {
    console.error('[perf] summary failed:', err);
    return NextResponse.json({ error: 'summary failed' }, { status: 500 });
  }
}
