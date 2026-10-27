// /api/autoship — auto-ship kill switch state + last ship-step verdict
// (task-79a07a7c). Thin JSON wrapper over lib/autoship.ts so the runner page
// (and any other consumer) can poll it without re-implementing the fs reads.
// Auth: not in PUBLIC_PREFIXES, so middleware.ts requires a session same as
// every other /api/* route — this exposes repo-internal operator state, not
// public status.
import { NextResponse } from 'next/server';
import { getAutoshipStatus } from '@/lib/autoship';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = await getAutoshipStatus();
  return NextResponse.json(status);
}
