// GET /api/billing/spend-status — tenant-facing FINOPS spend-alert status:
// current billing-period (calendar-month UTC) LLM spend vs. the plan's
// included allowance, and whether the 80%/100% alert has crossed. Mirrors
// runtime/src/llm/spend-alert.ts::getSpendAlertStatus (same convention as
// dashboard/src/lib/billing.ts mirroring runtime/src/core/billing.ts) so the
// dashboard banner can poll on-demand without waiting for the next LLM call
// to trip the gateway's own post-call check.
//
// Distinct from /api/billing/status (subscription entitlement) and
// /api/billing/overage (product-usage meter overage invoicing) — this is the
// dollar-spend meter (BudgetUsage) against the plan's included-spend ceiling.
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import { planLimits, type TenantPlan } from '@/lib/billing';
import { BudgetUsage } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const THRESHOLDS = [100, 80] as const;

function startOfMonthUTC(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function crossedThreshold(spentUsd: number, includedUsd: number): 80 | 100 | null {
  if (includedUsd <= 0) return null;
  for (const threshold of THRESHOLDS) {
    if (spentUsd >= includedUsd * (threshold / 100)) return threshold;
  }
  return null;
}

export async function GET(req: Request) {
  const auth = await authenticateTenant(keyFromRequest(req));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const plan = auth.tenant.plan as TenantPlan;
  const includedUsd = planLimits(plan).includedSpendUsd;
  const unlimited = includedUsd < 0;

  let spentUsd = 0;
  if (!unlimited) {
    const result = await BudgetUsage.aggregate([
      { $match: { tenantId: auth.tenant.tenantId, createdAt: { $gte: startOfMonthUTC() } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]);
    spentUsd = result[0]?.total ?? 0;
  }

  const pct = unlimited || includedUsd <= 0 ? null : (spentUsd / includedUsd) * 100;
  const alertLevel = unlimited ? null : crossedThreshold(spentUsd, includedUsd);

  return NextResponse.json({ plan, includedUsd, spentUsd, pct, alertLevel, unlimited });
}
