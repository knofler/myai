// GET /api/tasks/[taskId]/artifacts/[artifactId] — download a single captured
// artifact. Decodes gzip+base64-stored content back to raw bytes (see the
// gateway's artifact-store.ts encoding) and streams it with a Content-Disposition
// so the browser saves it under its original filename.
import { gunzipSync } from 'node:zlib';
import { NextResponse } from 'next/server';
import { connectDB, Artifact } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string; artifactId: string }> }) {
  const { taskId, artifactId } = await params;
  await connectDB();
  const tenantId = await getActiveTenant();
  const doc = await Artifact.findOne({ ...tenantFilter(tenantId), taskId, artifactId }).lean() as {
    filename: string; contentType: string; encoding: string; content: string;
  } | null;
  if (!doc) return NextResponse.json({ error: 'Artifact not found' }, { status: 404 });

  const buffer = doc.encoding === 'gzip+base64'
    ? gunzipSync(Buffer.from(doc.content, 'base64'))
    : Buffer.from(doc.content, 'utf8');

  return new NextResponse(new Uint8Array(buffer), {
    status: 200,
    headers: {
      'Content-Type': doc.contentType || 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${doc.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'no-store',
    },
  });
}
