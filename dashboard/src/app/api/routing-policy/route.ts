// /api/routing-policy — per-tenant cost-aware routing control-plane.
//
//   • GET  — the active tenant's routing policy (defaults if none saved yet).
//   • POST — persist a sanitized policy (default model, per-priority overrides,
//            monthly budget cap + soft/hard limits).
//
// TENANCY: like /api/connectors, writes go straight to the dashboard's Mongo
// connection scoped to the active tenant — NOT through the gateway bridge token
// (which resolves to the default tenant and would mis-scope a real tenant).
import { NextResponse } from 'next/server';
import { connectDB, RoutingPolicy } from '@/lib/db';
import { getActiveTenant } from '@/lib/tenant';
import {
  DEFAULT_ROUTING_POLICY,
  sanitizePolicy,
  type RoutingPolicy as Policy,
} from '@/lib/routing-policy';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function toPolicy(doc: Record<string, unknown> | null): Policy {
  if (!doc) return { ...DEFAULT_ROUTING_POLICY };
  // Round-trip through the sanitizer so a stale/partial document is normalized.
  return sanitizePolicy({
    enabled: doc.enabled,
    defaultModel: doc.defaultModel,
    priorityOverrides: doc.priorityOverrides,
    monthlyBudgetUsd: doc.monthlyBudgetUsd,
    softLimitPct: doc.softLimitPct,
    hardLimitPct: doc.hardLimitPct,
  });
}

export async function GET() {
  const tenantId = await getActiveTenant();
  try {
    await connectDB();
    const doc = await RoutingPolicy.findOne({ tenantId }).lean();
    return NextResponse.json({ ok: true, policy: toPolicy(doc as Record<string, unknown> | null) });
  } catch (err) {
    console.error('[api/routing-policy] GET failed:', err);
    return NextResponse.json({ error: 'could not load routing policy' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const tenantId = await getActiveTenant();
  const policy = sanitizePolicy(body);

  try {
    await connectDB();
    await RoutingPolicy.updateOne(
      { tenantId },
      {
        $set: {
          enabled: policy.enabled,
          defaultModel: policy.defaultModel,
          priorityOverrides: policy.priorityOverrides,
          monthlyBudgetUsd: policy.monthlyBudgetUsd,
          softLimitPct: policy.softLimitPct,
          hardLimitPct: policy.hardLimitPct,
          updatedAt: new Date(),
        },
        $setOnInsert: { tenantId },
      },
      { upsert: true },
    );
    return NextResponse.json({ ok: true, policy });
  } catch (err) {
    console.error('[api/routing-policy] POST failed:', err);
    return NextResponse.json({ error: 'could not save routing policy' }, { status: 500 });
  }
}
