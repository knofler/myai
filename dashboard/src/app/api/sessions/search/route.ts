import { NextRequest, NextResponse } from 'next/server';
import { connectDB, Vector } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';

// Phase B6 — RAG corpus text search endpoint.
// Accepts POST { query, limit?, source? } and returns matching vectors
// sorted by createdAt desc. Uses $regex on content for text matching —
// real semantic search lives in the gateway's recall_session MCP tool;
// this endpoint provides browse/filter capability for the dashboard.

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { query, limit = 20, source } = body as {
      query?: string;
      limit?: number;
      source?: string;
    };

    if (!query || typeof query !== 'string' || query.trim().length === 0) {
      return NextResponse.json(
        { error: 'query is required' },
        { status: 400 },
      );
    }

    await connectDB();
    const tenantId = await getActiveTenant();
    const tf = tenantFilter(tenantId);

    const filter: Record<string, unknown> = {
      ...tf,
      content: { $regex: query.trim(), $options: 'i' },
    };
    if (source && source !== 'all') {
      filter.source = source;
    }

    const results = await Vector.find(filter)
      .select('-embedding')
      .sort({ createdAt: -1 })
      .limit(Math.min(limit, 50))
      .lean();

    const serialized = results.map((v) => ({
      _id: String(v._id),
      repo: v.repo as string,
      source: v.source as string,
      content: v.content as string,
      tags: v.tags as string[],
      sessionId: v.sessionId as string,
      createdAt: v.createdAt ? new Date(v.createdAt as Date).toISOString() : null,
      updatedAt: v.updatedAt ? new Date(v.updatedAt as Date).toISOString() : null,
    }));

    return NextResponse.json({ results: serialized, count: serialized.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
