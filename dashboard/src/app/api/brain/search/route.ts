import { NextRequest, NextResponse } from 'next/server';
import { callGateway } from '@/lib/gateway';

// Federated brain search — proxies to the gateway `brain_search` MCP tool,
// which unions the git-brain atoms (every repo namespace, not readable from
// this container) with the Mongo session-corpus vectors and ranks them
// together. See runtime/src/core/brain-search.ts.

interface FederatedBrainSearchResult {
  query: string;
  count: number;
  atomsScanned: number;
  atomsTruncated: boolean;
  hits: Array<{
    kind: 'atom' | 'session';
    repo: string;
    score: number;
    snippet: string;
    written: string;
    atomKind?: string;
    path?: string;
    source?: string;
    sessionId?: string;
  }>;
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const { query, repo, k, since } = body as {
    query?: string;
    repo?: string;
    k?: number;
    since?: string;
  };

  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return NextResponse.json({ error: 'query is required' }, { status: 400 });
  }

  const result = await callGateway<FederatedBrainSearchResult>('brain_search', {
    query: query.trim(),
    repo,
    k,
    since,
  });

  if (!result) {
    return NextResponse.json({ error: 'gateway unreachable' }, { status: 502 });
  }
  return NextResponse.json(result);
}
