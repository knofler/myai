// /revenue — operator revenue dashboard (GTM / board metrics).
//
// MRR, ARR, net-revenue-retention, logo churn, and blended LTV computed from
// Stripe-synced subscription state on the Tenant collection. Read-only and
// AGGREGATED ACROSS TENANTS — this is the operator/board view (no tenant content
// ever leaves the aggregate), feeding plan/GRAND_PRODUCT_ROADMAP §5
// ($10M+ ARR target; <2% monthly logo churn).
//
// Server component reading the Mongo Tenant mirror + the pure revenue engine
// (src/lib/revenue.ts, mirrored from runtime/src/analytics/revenue.ts).

import { connectDB, Tenant, MrrSnapshot } from '@/lib/db';
import { fmtUsd } from '@/lib/format';
import {
  computeMrr,
  computeRetention,
  mrrForSnapshot,
  blendedLtv,
  avgLifetimeMonths,
  DEFAULT_PRICING,
  type TenantBillingSnapshot,
  type BillingInterval,
} from '@/lib/revenue';
import { historicalMrrAsOf, type MrrSnapshotPoint } from '@/lib/mrr-snapshots';
import type { TenantPlan, SubscriptionStatus } from '@/lib/billing';
import { StatCard, Card, EmptyState } from '@/components/ui/card';
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

const PLAN_LABEL: Record<TenantPlan, string> = { free: 'Free', solo: 'Solo', team: 'Team', scale: 'Scale' };
const WINDOW_DAYS = 30;

function pct(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export default async function RevenuePage() {
  let dbError = false;
  try {
    await connectDB();
  } catch {
    dbError = true;
  }

  if (dbError) {
    return (
      <div className="max-w-7xl mx-auto">
        <PageHeader title="Revenue" subtitle="MRR, ARR, retention, churn, and LTV across all tenants." />
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
          Database not reachable — revenue metrics need the gateway Mongo at :27200.
        </div>
      </div>
    );
  }

  // Operator view — read EVERY tenant (no tenant filter). Only non-secret
  // subscription/billing fields are projected; no tenant content is read.
  const tenants = (await Tenant.find(
    { status: { $ne: 'deleted' } },
    { tenantId: 1, plan: 1, subscriptionStatus: 1, billingInterval: 1, status: 1, createdAt: 1, updatedAt: 1, currentPeriodEnd: 1 },
  ).lean()) as unknown as TenantRow[];

  const snapshots: TenantBillingSnapshot[] = tenants.map((t) => ({
    tenantId: t.tenantId,
    plan: (t.plan ?? 'free') as TenantPlan,
    subscriptionStatus: t.subscriptionStatus,
    billingInterval: t.billingInterval,
  }));

  const summary = computeMrr(snapshots);

  // ── Retention cohort (trailing 30d) ────────────────────────────
  // Prefer the real starting MRR from the nightly mrr_snapshot_sweep job
  // (MrrSnapshot collection) when a tenant has at least 2 persisted daily
  // points reaching back to the window start. Tenants with fewer snapshots
  // (job hasn't run long enough for them yet) fall back to the reconstructed
  // proxy: tenants that existed before the window AND were paying at its
  // start (still active now, OR churned/lapsed DURING the window) — an
  // approximation of true point-in-time NRR.
  const windowStart = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000);
  const snapshotDocs = (await MrrSnapshot.find(
    { tenantId: { $in: tenants.map((t) => t.tenantId) } },
    { tenantId: 1, mrr: 1, capturedAt: 1 },
  ).lean()) as unknown as Array<{ tenantId: string; mrr: number; capturedAt: Date }>;
  const snapshotsByTenant = new Map<string, MrrSnapshotPoint[]>();
  for (const s of snapshotDocs) {
    const list = snapshotsByTenant.get(s.tenantId) ?? [];
    list.push({ mrr: s.mrr, capturedAt: new Date(s.capturedAt) });
    snapshotsByTenant.set(s.tenantId, list);
  }
  const byId = new Map(tenants.map((t) => [t.tenantId, t]));
  const activeNow = new Set(snapshots.filter((s) => mrrForSnapshot(s) > 0).map((s) => s.tenantId));

  const startingActive: Array<{ tenantId: string; mrr: number }> = [];
  const currentMrrById: Record<string, number> = {};
  let newLogos = 0;
  let churnedLogos = 0;

  for (const s of snapshots) {
    const row = byId.get(s.tenantId);
    const createdAt = row?.createdAt ? new Date(row.createdAt) : undefined;
    const currentMrr = mrrForSnapshot(s);
    const isActive = currentMrr > 0;

    if (isActive && createdAt && createdAt >= windowStart) newLogos += 1;

    const lapsed = !isActive && (s.subscriptionStatus === 'canceled' || s.subscriptionStatus === 'past_due');
    const lastChange = row?.currentPeriodEnd
      ? new Date(row.currentPeriodEnd)
      : row?.updatedAt
        ? new Date(row.updatedAt)
        : undefined;
    const churnedInWindow = lapsed && !!lastChange && lastChange >= windowStart && !!createdAt && createdAt < windowStart;

    // Started the window as a paying account?
    const startedPaying = (isActive && createdAt && createdAt < windowStart) || churnedInWindow;
    if (startedPaying) {
      // Starting MRR: what they paid at window start. Prefer the real
      // persisted snapshot closest to (at or before) windowStart; fall back
      // to the proxy (active-now → current MRR; churned → what the last
      // plan would bill) for tenants with fewer than 2 snapshots.
      const historical = historicalMrrAsOf(snapshotsByTenant.get(s.tenantId) ?? [], windowStart);
      const startMrr = historical ?? (isActive
        ? currentMrr
        : mrrForSnapshot({ tenantId: s.tenantId, plan: s.plan, subscriptionStatus: 'active', billingInterval: s.billingInterval }));
      startingActive.push({ tenantId: s.tenantId, mrr: startMrr });
      currentMrrById[s.tenantId] = currentMrr;
      if (!isActive) churnedLogos += 1;
    }
  }

  const retention = computeRetention({ startingActive, currentMrrById });
  const ltv = blendedLtv(summary.arpa, retention.logoChurnRate);
  const lifetimeMonths = avgLifetimeMonths(retention.logoChurnRate);

  const totalTenants = tenants.length;
  const paidShare = totalTenants > 0 ? summary.activeLogos / totalTenants : 0;
  const churnHealthy = retention.logoChurnRate <= 0.02; // roadmap target: <2% monthly logo churn
  const nrrHealthy = retention.netRevenueRetention >= 1;

  const maxPlanMrr = Math.max(...summary.byPlan.map((p) => p.mrr), 1);

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={60} />
      <PageHeader
        title="Revenue"
        subtitle="MRR · ARR · net-revenue-retention · logo churn · blended LTV — aggregated across all tenants (operator view)."
      >
        <Link href="/revenue/nrr" className="text-xs text-blue-400 hover:text-blue-300 border border-blue-500/30 rounded-lg px-3 py-1.5">
          NRR cohorts →
        </Link>
      </PageHeader>

      {/* Headline metrics */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="MRR" value={fmtUsd(summary.mrr)} sub={`${summary.activeLogos} paying ${summary.activeLogos === 1 ? 'logo' : 'logos'}`} accent="green" />
        <StatCard label="ARR" value={fmtUsd(summary.arr)} sub="MRR × 12" accent="green" />
        <StatCard label="ARPA" value={fmtUsd(summary.arpa)} sub="avg revenue / account" accent="blue" />
        <StatCard label="Blended LTV" value={ltv === null ? '—' : fmtUsd(ltv)} sub={lifetimeMonths === null ? 'no churn yet' : `~${lifetimeMonths.toFixed(0)} mo lifetime`} accent="blue" />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label={`Net revenue retention (${WINDOW_DAYS}d)`} value={retention.startingMrr > 0 ? pct(retention.netRevenueRetention) : '—'} sub={nrrHealthy ? 'net expansion' : 'net contraction'} accent={nrrHealthy ? 'green' : 'yellow'} />
        <StatCard label={`Logo churn (${WINDOW_DAYS}d)`} value={retention.startingLogos > 0 ? pct(retention.logoChurnRate) : '—'} sub={`${retention.churnedLogos} of ${retention.startingLogos} · target <2%`} accent={churnHealthy ? 'green' : 'yellow'} />
        <StatCard label={`Gross rev. churn (${WINDOW_DAYS}d)`} value={retention.startingMrr > 0 ? pct(retention.grossRevenueChurnRate) : '—'} sub={fmtUsd(retention.churnedMrr) + ' lost'} accent={retention.grossRevenueChurnRate <= 0.02 ? 'green' : 'yellow'} />
        <StatCard label={`New logos (${WINDOW_DAYS}d)`} value={newLogos} sub={`${churnedLogos} churned · ${(paidShare * 100).toFixed(0)}% of ${totalTenants} tenants paid`} accent="green" />
      </div>

      {/* MRR by plan */}
      <div className="mb-8">
        <Card title="MRR by plan" meta={summary.activeLogos > 0 ? `${fmtUsd(summary.mrr)} total across ${summary.byPlan.length} ${summary.byPlan.length === 1 ? 'tier' : 'tiers'}` : 'no paying tenants yet'} accent="emerald">
          <div className="p-5 space-y-4">
            {summary.byPlan.length === 0 ? (
              <EmptyState>No paying tenants yet — MRR fills in as tenants subscribe via Stripe checkout.</EmptyState>
            ) : (
              summary.byPlan.map((p) => {
                const w = (p.mrr / maxPlanMrr) * 100;
                const share = summary.mrr > 0 ? Math.round((p.mrr / summary.mrr) * 100) : 0;
                return (
                  <div key={p.plan}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-zinc-300">{PLAN_LABEL[p.plan]}</span>
                      <span className="font-mono text-zinc-500">
                        {fmtUsd(p.mrr)}/mo · {p.logos} {p.logos === 1 ? 'logo' : 'logos'} · {share}%
                      </span>
                    </div>
                    <div className="h-4 bg-zinc-950 rounded overflow-hidden">
                      <div className="h-full rounded bg-gradient-to-r from-teal-500/80 to-emerald-400/80" style={{ width: `${Math.max(w, 2)}%` }} />
                    </div>
                    <p className="text-[10px] text-zinc-600 mt-1 font-mono">
                      list {fmtUsd(DEFAULT_PRICING.monthly[p.plan])}/mo · {fmtUsd(DEFAULT_PRICING.annual[p.plan])}/yr
                    </p>
                  </div>
                );
              })
            )}
          </div>
        </Card>
      </div>

      {/* Retention detail + methodology */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card title="Retention cohort" meta={`trailing ${WINDOW_DAYS} days`} accent="blue">
          <div className="p-5 space-y-3 text-xs">
            {retention.startingLogos === 0 ? (
              <EmptyState>No paying cohort at the window start yet — retention fills in as the paying base ages past {WINDOW_DAYS} days.</EmptyState>
            ) : (
              <div className="space-y-2 font-mono">
                <Row label="Starting paying logos" value={String(retention.startingLogos)} />
                <Row label="Starting MRR" value={fmtUsd(retention.startingMrr)} />
                <Row label="Retained logos" value={`${retention.retainedLogos} (${pct(1 - retention.logoChurnRate)})`} />
                <Row label="Churned logos" value={`${retention.churnedLogos} (${pct(retention.logoChurnRate)})`} />
                <Row label="Retained MRR (net)" value={fmtUsd(retention.retainedMrr)} />
                <Row label="Net revenue retention" value={pct(retention.netRevenueRetention)} />
              </div>
            )}
          </div>
        </Card>

        <Card title="How these are computed" accent="amber">
          <div className="p-5 text-xs text-zinc-500 space-y-2">
            <p><span className="text-zinc-300">MRR</span> sums the monthly-normalized price of every tenant on a paid plan with an <code className="text-zinc-400">active</code>/<code className="text-zinc-400">trialing</code> Stripe subscription. Annual plans contribute annual ÷ 12; <code className="text-zinc-400">past_due</code> (dunning grace) is excluded — matching the entitlement gate.</p>
            <p><span className="text-zinc-300">NRR &amp; churn</span> compare the paying cohort at the start of the {WINDOW_DAYS}-day window against where those same accounts are now (expansion, contraction, and churn included).</p>
            <p><span className="text-zinc-300">Blended LTV</span> = ARPA ÷ monthly logo-churn rate.</p>
            <p className="text-zinc-600 pt-1 border-t border-zinc-800">
              Starting MRR prefers the real snapshot from the nightly MRR-snapshot job closest to the window start; tenants with fewer than 2 persisted snapshots fall back to a reconstruction from current subscription state. Pricing defaults come from the roadmap and are overridable via <code className="text-zinc-400">MYAI_PRICE_*</code> env vars.
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-zinc-400">{label}</span>
      <span className="text-zinc-200">{value}</span>
    </div>
  );
}
