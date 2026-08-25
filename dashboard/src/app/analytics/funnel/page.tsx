// /analytics/funnel — the operator ACTIVATION funnel: where do signups fall
// out of the journey signup → project connected → first task executed → first
// task shipped, with an explicit per-stage drop-off and signup-cohort break-out
// (month or ISO week) so onboarding fixes show up as newer cohorts converting
// better.
//
// Distinct from /analytics (blended continuity-aha + self-serve funnels, no
// drop-off, no cohorts) and from /revenue (MRR/churn — money, not activation).
// AGGREGATED ACROSS TENANTS — operator/product view; counts tenants only,
// never any tenant's content (same ADR-014 posture as the /analytics funnels).
//
// Server component reading the Mongo ActivationEvent mirror + the pure engine
// (src/lib/activation-cohorts.ts, mirrored from
// runtime/src/analytics/activation-cohorts.ts). Filters are plain links
// (?cohort=month|week & window=30|90|all) — no client JS.

import { connectDB, ActivationEvent } from '@/lib/db';
import {
  computeFunnelDropoff,
  OPERATOR_FUNNEL_STEPS,
  type CohortGranularity,
  type FunnelEventRow,
} from '@/lib/activation-cohorts';
import { StatCard, Card, EmptyState } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const WINDOWS: ReadonlyArray<{ key: string; label: string; days?: number }> = [
  { key: '30', label: 'Last 30d', days: 30 },
  { key: '90', label: 'Last 90d', days: 90 },
  { key: 'all', label: 'All time' },
];

const GRANULARITIES: ReadonlyArray<{ key: CohortGranularity; label: string }> = [
  { key: 'month', label: 'Monthly cohorts' },
  { key: 'week', label: 'Weekly cohorts' },
];

interface EventDoc { tenantId: string; step: string; occurredAt?: Date; createdAt?: Date }

function FilterPill({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`text-xs rounded-lg px-3 py-1.5 border transition-colors ${
        active
          ? 'border-teal-500/50 bg-teal-500/10 text-teal-300'
          : 'border-[rgb(var(--border-subtle))] text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]'
      }`}
    >
      {label}
    </Link>
  );
}

export default async function ActivationFunnelPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string; window?: string }>;
}) {
  const params = await searchParams;
  const granularity: CohortGranularity = params.cohort === 'week' ? 'week' : 'month';
  const windowKey = WINDOWS.some((w) => w.key === params.window) ? (params.window as string) : 'all';
  const windowDays = WINDOWS.find((w) => w.key === windowKey)?.days;
  const since = windowDays ? new Date(Date.now() - windowDays * 86_400_000) : undefined;

  let dbError = false;
  try { await connectDB(); } catch { dbError = true; }

  if (dbError) {
    return (
      <div className="max-w-7xl mx-auto">
        <PageHeader title="Activation funnel" subtitle="Signup → first ship, with per-stage drop-off and signup cohorts." />
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
          Database not reachable — the funnel needs the gateway Mongo at :27200.
        </div>
      </div>
    );
  }

  // First-touch rows for the four operator stages. Cross-tenant BY DESIGN —
  // this is the operator/product view; it counts tenants, never their content.
  const docs = (await ActivationEvent.find(
    {
      step: { $in: OPERATOR_FUNNEL_STEPS.map((s) => s.step) },
      ...(since ? { occurredAt: { $gte: since } } : {}),
    },
    { tenantId: 1, step: 1, occurredAt: 1, createdAt: 1 },
  ).lean()) as unknown as EventDoc[];

  const rows: FunnelEventRow[] = docs
    .filter((d) => d.tenantId && (d.occurredAt || d.createdAt))
    .map((d) => ({ tenantId: d.tenantId, step: d.step, at: new Date((d.occurredAt ?? d.createdAt) as Date) }));

  const report = computeFunnelDropoff(rows, { granularity, since });
  const hasData = report.stages.some((s) => s.tenants > 0);
  const maxCohortSignups = Math.max(...report.cohorts.map((c) => c.signups), 1);

  const qs = (cohort: CohortGranularity, win: string) => `/analytics/funnel?cohort=${cohort}&window=${win}`;

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={60} />
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title="Activation funnel"
          subtitle="Where signups fall out of signup → project connected → first task executed → first task shipped — per-stage drop-off + signup cohorts (operator view)."
        />
        <Link href="/analytics" className="text-xs text-teal-400 hover:text-teal-300 border border-teal-500/30 rounded-lg px-3 py-1.5 shrink-0 mt-1">
          ← Analytics
        </Link>
      </div>

      {/* Filters — cohort granularity + window, as plain links */}
      <div className="flex flex-wrap items-center gap-2 mb-6">
        {WINDOWS.map((w) => (
          <FilterPill key={w.key} href={qs(granularity, w.key)} label={w.label} active={w.key === windowKey} />
        ))}
        <span className="w-px h-5 bg-[rgb(var(--border-subtle))] mx-1" />
        {GRANULARITIES.map((g) => (
          <FilterPill key={g.key} href={qs(g.key, windowKey)} label={g.label} active={g.key === granularity} />
        ))}
      </div>

      {/* Headline stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Signed up" value={report.signups} sub={windowDays ? `last ${windowDays}d` : 'all time'} accent="blue" />
        <StatCard label="Shipped first task" value={report.shipped} sub={`${report.conversionRate}% of signups`} accent="green" />
        <StatCard
          label="Signup → ship conversion"
          value={hasData ? `${report.conversionRate}%` : '—'}
          sub="the activation-to-value rate"
          accent={report.conversionRate >= 50 ? 'green' : 'yellow'}
        />
        <StatCard
          label="Biggest leak"
          value={report.worstStage ? `−${report.worstStage.droppedOff}` : '—'}
          sub={report.worstStage ? `before "${report.worstStage.label}" · ${report.worstStage.dropOffPct}% lost` : 'no drop-off recorded'}
          accent={report.worstStage ? 'yellow' : 'gray'}
        />
      </div>

      {/* The funnel with per-stage drop-off */}
      <Card
        title="Journey drop-off"
        meta={hasData ? `${report.signups} signed up · ${report.shipped} shipped · ${report.conversionRate}% end-to-end` : 'no activation events yet'}
        accent="emerald"
      >
        <div className="p-5">
          <p className="text-xs text-[rgb(var(--text-muted))] mb-5">
            Distinct tenants at each stage of the activation journey{windowDays ? ` (milestones in the last ${windowDays} days)` : ''}.
            The red figure between stages is the drop-off — tenants that reached the previous stage but never this one.
            Privacy-respecting: first-touch milestones from gateway chokepoints, counts only, no third-party tracker.
          </p>
          {!hasData ? (
            <EmptyState>The funnel fills in as tenants sign up, connect a project, and ship tasks.</EmptyState>
          ) : (
            <div className="space-y-1">
              {report.stages.map((s, i) => (
                <div key={s.step}>
                  {i > 0 && (
                    <div className="flex items-center gap-2 pl-4 py-1 text-[11px] font-mono">
                      <span className="text-zinc-600">↓</span>
                      {s.droppedOff > 0 ? (
                        <span className="text-red-400/80">−{s.droppedOff} dropped off ({s.dropOffPct}%)</span>
                      ) : (
                        <span className="text-zinc-600">no drop-off</span>
                      )}
                      <span className="text-zinc-600">· {s.stepConversion}% step conversion</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-[rgb(var(--text-primary))]">{s.label}</span>
                    <span className="font-mono text-[rgb(var(--text-muted))]">
                      {s.tenants} {s.tenants === 1 ? 'tenant' : 'tenants'} · {s.pctOfSignup}% of signups
                    </span>
                  </div>
                  <div className="h-5 bg-[rgb(var(--bg-page))] rounded overflow-hidden">
                    <div
                      className={`h-full rounded ${i === report.stages.length - 1 ? 'bg-gradient-to-r from-teal-500/80 to-emerald-400/80' : 'bg-teal-600/50'}`}
                      style={{ width: `${Math.max(s.pctOfSignup, s.tenants > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Card>

      {/* Signup cohorts */}
      <div className="mt-8">
        <Card
          title={`Signup cohorts — ${granularity === 'week' ? 'ISO week' : 'month'}`}
          meta={report.cohorts.length > 0 ? `${report.cohorts.length} cohorts` : 'no cohorts yet'}
          accent="blue"
        >
          <div className="p-5">
            <p className="text-xs text-[rgb(var(--text-muted))] mb-4">
              The same funnel per signup cohort (cohort = when the tenant signed up; later milestones count into
              their signup cohort whenever they happened). An onboarding fix shows up here as newer cohorts
              converting better — a blended all-time number can&apos;t show that.
            </p>
            {report.cohorts.length === 0 ? (
              <EmptyState>Cohorts appear as tenants sign up{windowDays ? ' inside the selected window' : ''}.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-[10px] uppercase tracking-wider text-zinc-600 border-b border-[rgb(var(--border-subtle))]">
                      <th className="text-left py-2 pr-3">Cohort</th>
                      <th className="text-right py-2 px-3">Signed up</th>
                      {OPERATOR_FUNNEL_STEPS.slice(1).map((s) => (
                        <th key={s.step} className="text-right py-2 px-3">{s.label}</th>
                      ))}
                      <th className="text-right py-2 pl-3">Conversion</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.cohorts.map((c) => (
                      <tr key={c.cohort} className="border-b border-[rgb(var(--border-subtle))]/50">
                        <td className="py-2 pr-3 font-mono text-[rgb(var(--text-primary))]">{c.cohort}</td>
                        <td className="py-2 px-3 text-right font-mono text-[rgb(var(--text-primary))]">
                          <div className="flex items-center justify-end gap-2">
                            <div className="w-16 h-2 bg-[rgb(var(--bg-page))] rounded-full overflow-hidden hidden sm:block">
                              <div className="h-full rounded-full bg-sky-500/60" style={{ width: `${(c.signups / maxCohortSignups) * 100}%` }} />
                            </div>
                            {c.signups}
                          </div>
                        </td>
                        {c.stages.slice(1).map((n, i) => {
                          const pct = c.signups > 0 ? Math.round((n / c.signups) * 100) : 0;
                          return (
                            <td key={OPERATOR_FUNNEL_STEPS[i + 1].step} className="py-2 px-3 text-right font-mono">
                              <span className="text-[rgb(var(--text-primary))]">{n}</span>
                              <span className="text-zinc-600"> · {pct}%</span>
                            </td>
                          );
                        })}
                        <td className={`py-2 pl-3 text-right font-mono font-semibold ${c.conversionRate >= 50 ? 'text-emerald-400' : c.conversionRate > 0 ? 'text-yellow-400' : 'text-zinc-600'}`}>
                          {c.conversionRate}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
