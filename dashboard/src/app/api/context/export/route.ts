// GET /api/context/export — one-click DOWNLOAD of the tenant's portable
// context as a single JSON bundle (CONTEXT-PORT 3).
//
// Assembles what the dashboard can reach WITHOUT filesystem/git access: the RAG
// vector corpus (content + metadata, embeddings excluded to keep it light) and
// gateway session history, both from the local Mongo mirror scoped to the
// active tenant. The heavyweight lossless tar.gz (memory markdown + vectors
// WITH embeddings + the whole git brain repo + ~/.myai config) is produced by
// the `myai context export` CLI (CONTEXT-PORT 1) — surfaced on the page.
//
// "Your context is yours, portable, importable" — this is the download half.
import { NextResponse } from 'next/server';
import { connectDB, Vector, Session } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { CONTEXT_BUNDLE_KIND, CONTEXT_BUNDLE_VERSION } from '@/lib/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const tenantId = await getActiveTenant();
  try {
    await connectDB();
    const tf = tenantFilter(tenantId);

    // Vectors: never select `embedding` (384-dim float array — huge and
    // re-derivable on import via re-embedding). The lossless embedding dump is
    // the CLI's `myai context export` job.
    const vectors = (await Vector.find({ ...tf })
      .select('-embedding -__v -_id')
      .sort({ createdAt: -1 })
      .limit(20000)
      .lean()) as unknown[];

    const sessions = (await Session.find({ ...tf })
      .select('-__v -_id')
      .sort({ updatedAt: -1 })
      .limit(2000)
      .lean()) as unknown[];

    const bundle = {
      kind: CONTEXT_BUNDLE_KIND,
      formatVersion: CONTEXT_BUNDLE_VERSION,
      tenantId,
      generatedAt: new Date().toISOString(),
      note:
        'Portable myAI context bundle (dashboard slice — vectors without embeddings + sessions). ' +
        'For the full lossless archive (memory markdown + vectors WITH embeddings + git brain + config), run: myai context export',
      summary: { totalItems: vectors.length + sessions.length, estimatedTokens: 0 },
      vectors,
      sessions,
      brain: null,
    };

    const body = JSON.stringify(bundle, null, 2);
    const stamp = bundle.generatedAt.slice(0, 10);
    return new NextResponse(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="myai-context-${stamp}.json"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'export failed' },
      { status: 500 },
    );
  }
}
