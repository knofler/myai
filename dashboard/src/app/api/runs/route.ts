// /api/runs — tenant-scoped runner job-history search backend (OBSERVABILITY,
// task-1873b3be). Thin proxy to the gateway's job_history_search MCP tool
// (mcp/tools.ts → tasks/job-history-store.ts), the durable archive of past
// runner fires — the tenant is resolved server-side from the gateway
// credential (lib/gateway.ts's callGateway), never trusted from the client.
// RESULT lines / error excerpts are redacted at write time.
import { NextRequest, NextResponse } from 'next/server';
import { callGateway } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface JobHistoryEntry {
  jobId: string;
  repo: string;
  taskId: string;
  status: 'done' | 'blocked' | 'failed' | 'no-result';
  resultLine: string;
  errorExcerpt: string;
  exitCode?: number;
  machine?: string;
  model?: string;
  logFile?: string;
  startedAt: string;
  durationSeconds?: number;
}

interface JobHistorySearchResult {
  total: number;
  entries: JobHistoryEntry[];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const args: Record<string, unknown> = {};
  const repo = searchParams.get('repo');
  const taskId = searchParams.get('taskId');
  const status = searchParams.get('status');
  const q = searchParams.get('q');
  const since = searchParams.get('since');
  const until = searchParams.get('until');
  const limit = searchParams.get('limit');
  if (repo) args.repo = repo;
  if (taskId) args.taskId = taskId;
  if (status) args.status = status;
  if (q) args.q = q;
  if (since) args.since = Number(since);
  if (until) args.until = Number(until);
  if (limit) args.limit = Number(limit);

  const result = await callGateway<JobHistorySearchResult>('job_history_search', args);
  if (!result) return NextResponse.json({ error: 'failed to reach gateway' }, { status: 502 });
  return NextResponse.json({ total: result.total, entries: result.entries });
}
