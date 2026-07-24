// /system → Policy tab — per-tenant cost-aware routing control-plane.
//
// The Routing tab is a read-only view of the GLOBAL gateway routing config.
// This tab is the per-TENANT control plane: it loads the tenant's saved policy
// (or defaults) plus month-to-date spend, and hands both to the client editor
// (components/routing-policy-form.tsx), which persists via /api/routing-policy.

import { connectDB, RoutingPolicy, BudgetUsage } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { DEFAULT_ROUTING_POLICY, sanitizePolicy, type RoutingPolicy as Policy } from '@/lib/routing-policy';
import RoutingPolicyForm from '@/components/routing-policy-form';

export const dynamic = 'force-dynamic';

function startOfMonthUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export default async function RoutingSettingsView() {
  const tenantId = await getActiveTenant();

  let policy: Policy = { ...DEFAULT_ROUTING_POLICY };
  let spentUsd = 0;
  let dbError = false;

  try {
    await connectDB();
    const [doc, mtdAgg] = await Promise.all([
      RoutingPolicy.findOne({ tenantId }).lean() as Promise<Record<string, unknown> | null>,
      BudgetUsage.aggregate<{ _id: null; total: number }>([
        { $match: { ...tenantFilter(tenantId), createdAt: { $gte: startOfMonthUTC() } } },
        { $group: { _id: null, total: { $sum: '$costUsd' } } },
      ]),
    ]);
    if (doc) policy = sanitizePolicy(doc);
    spentUsd = mtdAgg[0]?.total ?? 0;
  } catch (err) {
    console.error('[routing-settings] load failed:', err);
    dbError = true;
  }

  return (
    <div className="max-w-4xl">
      {dbError && (
        <div className="mb-4 bg-amber-950/30 border border-amber-800/50 rounded-lg p-3 text-xs text-amber-300">
          Could not reach the database — showing defaults. Saving may fail until the DB is reachable.
        </div>
      )}
      <p className="mb-5 text-sm text-zinc-500">
        Set this tenant&apos;s default model, per-priority model overrides, and a monthly budget cap with
        soft/hard limits. Soft/hard limits are the thresholds the token guard enforces.
      </p>
      <RoutingPolicyForm initialPolicy={policy} spentUsd={spentUsd} />
    </div>
  );
}
