// /api/logs — tenant-scoped structured request-log viewer backend
// (OBSERVABILITY: correlation ids threaded gateway→runner→agent).
// Thin proxy to the gateway's logs_list MCP tool (mcp/tools.ts), which reads
// monitoring/log-store.ts's ring buffer — the tenant is resolved server-side
// from the gateway credential (lib/gateway.ts's callGateway), never trusted
// from the client. Entries are already redacted at write time.
import { NextRequest, NextResponse } from 'next/server';
import { callGateway } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface LogEntry {
  id: string;
  ts: number;
  tenantId: string;
  correlationId: string;
  service: 'gateway' | 'runner' | 'agent';
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  attributes: Record<string, unknown>;
}

interface LogsListResult {
  entries: LogEntry[];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const args: Record<string, unknown> = {};
  const correlationId = searchParams.get('correlationId');
  const service = searchParams.get('service');
  const level = searchParams.get('level');
  const q = searchParams.get('q');
  const since = searchParams.get('since');
  const limit = searchParams.get('limit');
  if (correlationId) args.correlationId = correlationId;
  if (service) args.service = service;
  if (level) args.level = level;
  if (q) args.q = q;
  if (since) args.since = Number(since);
  if (limit) args.limit = Number(limit);

  const result = await callGateway<LogsListResult>('logs_list', args);
  if (!result) return NextResponse.json({ error: 'failed to reach gateway' }, { status: 502 });
  return NextResponse.json({ count: result.entries.length, entries: result.entries });
}
