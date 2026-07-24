// GET /api/tasks/[taskId]/artifacts — list the artifacts (diff / build-test
// output / reports) a runner session captured for a task, metadata only.
// Powers the "Artifacts" affordance on the /work Needs Review drawer so an
// operator can review autonomous work without re-running it.
import { NextResponse } from 'next/server';
import { connectDB, Artifact } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

export async function GET(_req: Request, { params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  await connectDB();
  const tenantId = await getActiveTenant();
  const artifacts = await Artifact.find({ ...tenantFilter(tenantId), taskId })
    .select('artifactId taskId repo kind filename contentType sizeBytes truncated createdAt -_id')
    .sort({ createdAt: 1 })
    .lean();
  return NextResponse.json({ count: artifacts.length, artifacts });
}
