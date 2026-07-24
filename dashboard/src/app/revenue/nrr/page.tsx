// /revenue/nrr — NRR cohort report: expansion vs contraction vs churn, broken
// out PER SIGNUP-MONTH COHORT rather than one blended trailing window.
//
// Distinct from /revenue (MRR/ARR/single-window NRR/logo churn/LTV): that page
// answers "what is our retention right now"; this page answers the
// retention-QUALITY question investors ask next — "which cohorts retain well,
// and is retention driven by expansion or just the absence of churn?"
//
// Server component reading the Mongo Tenant mirror + the pure cohort engine
// (src/lib/nrr-cohort.ts, mirrored from runtime/src/analytics/nrr-cohort.ts).

import { connectDB, Tenant } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import { mrrForSnapshot, type TenantBillingSnapshot, type BillingInterval } from '@/lib/revenue';
import { computeCohortNrrReport, type CohortInput } from '@/lib/nrr-cohort';
import type { TenantPlan, SubscriptionStatus } from '@/lib/billing';
import { Card, EmptyState } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

interface TenantRow {
  tenantId: string;
  plan?: TenantPlan;
  subscriptionStatus?: SubscriptionStatus;
  billingInterval?: BillingInterval;
  status?: string;
  createdAt?: Date;
  updatedAt?: Date;
  currentPeriodEnd?: Date;
}

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

function cohortMonthLabel(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

export default async function NrrCohortPage() {
  let dbError = false;
  try {
    await connectDB();
  } catch {
    dbError = true;
  }

  if (dbError) {
    return (
      <div className="max-w-7xl mx-auto">
        <PageHeader title="NRR cohorts" subtitle="Expansion vs contraction vs churn, per signup-month cohort." />
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
          Database not reachable — NRR cohorts need the gateway Mongo at :27200.
        </div>
      </div>
    );
  }

  const tenants = (await Tenant.find(
    { status: { $ne: 'deleted' } },
    { tenantId: 1, plan: 1, subscriptionStatus: 1, billingInterval: 1, status: 1, createdAt: 1, updatedAt: 1, currentPeriodEnd: 1 },
  ).lean()) as unknown as TenantRow[];

  // ── Reconstruct one starting-MRR point per tenant, bucketed by signup month ──
  // We don't persist historical MRR snapshots yet (same gap noted on /revenue),
  // so each account gets exactly ONE observed point ("now"): active accounts use
  // their current MRR as the starting-MRR proxy (we cannot yet tell whether an
  // active account has already expanded/contracted since signup — that needs a
  // persisted monthly snapshot); lapsed accounts use what their last known plan
  // would have billed, so they show up as churned MRR against their cohort.
  // Expansion/contraction will start reading real, nonzero values once a
  // nightly MRR-snapshot job lands (tracked alongside the /revenue TODO).
  const cohortMap = new Map<string, { accounts: { tenantId: string; startingMrr: number }[]; currentMrrById: Record<string, number> }>();

  for (const t of tenants) {
    if (!t.createdAt) continue;
    const snap: TenantBillingSnapshot = {
      tenantId: t.tenantId,
      plan: (t.plan ?? 'free') as TenantPlan,
      subscriptionStatus: t.subscriptionStatus,
      billingInterval: t.billingInterval,
    };
    const currentMrr = mrrForSnapshot(snap);
    const isActive = currentMrr > 0;
    if (!isActive && t.subscriptionStatus !== 'canceled' && t.subscriptionStatus !== 'past_due') continue; // never paid

    const startingMrr = isActive
      ? currentMrr
      : mrrForSnapshot({ ...snap, subscriptionStatus: 'active' }); // best-effort: what the lapsed plan would bill

    if (startingMrr <= 0) continue;

    const cohortMonth = cohortMonthLabel(new Date(t.createdAt));
    const entry = cohortMap.get(cohortMonth) ?? { accounts: [], currentMrrById: {} };
    entry.accounts.push({ tenantId: t.tenantId, startingMrr });
    entry.currentMrrById[t.tenantId] = currentMrr;
    cohortMap.set(cohortMonth, entry);
  }

  const cohortInputs: CohortInput[] = [...cohortMap.entries()].map(([cohortMonth, { accounts, currentMrrById }]) => ({
    cohortMonth,
    startingAccounts: accounts,
    monthlySnapshots: [{ month: 'now', monthsSinceStart: 0, currentMrrById }],
  }));

  const report = computeCohortNrrReport(cohortInputs)
    .map((series) => series[0])
    .filter((p): p is NonNullable<typeof p> => !!p)
    .reverse(); // newest cohort first

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={60} />
      <PageHeader
        title="NRR cohorts"
        subtitle="Expansion vs contraction vs churn, per signup-month cohort — the retention-quality lens behind the single NRR number on /revenue."
      >
        <Link href="/revenue" className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded-lg px-3 py-1.5">
          ← Revenue overview
        </Link>
      </PageHeader>

      <div className="mb-8">
        <Card
          title="Cohort retention"
          meta={report.length > 0 ? `${report.length} signup-month ${report.length === 1 ? 'cohort' : 'cohorts'}` : 'no paying cohorts yet'}
          accent="blue"
        >
          <div className="p-5">
            {report.length === 0 ? (
              <EmptyState>No paying cohorts yet — this fills in as tenants subscribe via Stripe checkout.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs font-mono">
                  <thead>
                    <tr className="text-zinc-500 border-b border-zinc-800">
                      <th className="text-left py-2 pr-4">Cohort</th>
                      <th className="text-right py-2 pr-4">Logos</th>
                      <th className="text-right py-2 pr-4">Starting MRR</th>
                      <th className="text-right py-2 pr-4">Expansion</th>
                      <th className="text-right py-2 pr-4">Contraction</th>
                      <th className="text-right py-2 pr-4">Churned</th>
                      <th className="text-right py-2 pr-4">Ending MRR</th>
                      <th className="text-right py-2">NRR</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.map((p) => (
                      <tr key={p.cohortMonth} className="border-b border-zinc-900/60">
                        <td className="py-2 pr-4 text-zinc-300">{p.cohortMonth}</td>
                        <td className="py-2 pr-4 text-right text-zinc-500">{p.startingLogos}</td>
                        <td className="py-2 pr-4 text-right text-zinc-400">{fmtUsd(p.startingMrr)}</td>
                        <td className="py-2 pr-4 text-right text-emerald-400">{p.expansionMrr > 0 ? `+${fmtUsd(p.expansionMrr)}` : '—'}</td>
                        <td className="py-2 pr-4 text-right text-amber-400">{p.contractionMrr > 0 ? `-${fmtUsd(p.contractionMrr)}` : '—'}</td>
                        <td className="py-2 pr-4 text-right text-red-400">{p.churnedMrr > 0 ? `-${fmtUsd(p.churnedMrr)} (${p.churnedLogos})` : '—'}</td>
                        <td className="py-2 pr-4 text-right text-zinc-300">{fmtUsd(p.endingMrr)}</td>
                        <td className={`py-2 text-right ${p.netRevenueRetention >= 1 ? 'text-emerald-400' : 'text-amber-400'}`}>{pct(p.netRevenueRetention)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </div>

      <Card title="How this is computed" accent="amber">
        <div className="p-5 text-xs text-zinc-500 space-y-2">
          <p>
            Each row is a <span className="text-zinc-300">signup-month cohort</span> — every tenant that started paying in that
            calendar month. <span className="text-zinc-300">Expansion</span> is MRR gained by accounts now paying more than
            their cohort start (upgrades/overage); <span className="text-zinc-300">contraction</span> is MRR lost by accounts
            still paying but less (downgrades); <span className="text-zinc-300">churned</span> is MRR from accounts now fully
            cancelled. NRR = ending MRR ÷ starting MRR (&gt;100% = net expansion).
          </p>
          <p className="text-zinc-600 pt-1 border-t border-zinc-800">
            No historical MRR snapshots are persisted yet, so each account contributes a single observed point (now):
            still-active accounts use their current MRR as the starting-MRR proxy, so expansion/contraction read 0 until a
            nightly MRR-snapshot job lands and starts distinguishing "upgraded since signup" from "always paid this much" —
            same gap noted on <code className="text-zinc-400">/revenue</code>. Churn is already exact.
          </p>
        </div>
      </Card>
    </div>
  );
}
