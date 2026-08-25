// /velocity — per-repo delivery-velocity report (autonomous output).
//
// Tasks shipped per week, median queued→done cycle time, and throughput trend
// per repo. Distinct from /revenue (money) and the launch-metrics funnel
// (signups): this is the operator/tenant answer to "how much is the fleet
// actually shipping, how fast, and is it speeding up or slowing down?".
//
// Server component: one Task aggregation (buildVelocityPipeline — done tasks
// in the window, projected to {repo, createdAt, completedAt}), folded by the
// pure engine in src/lib/delivery-velocity.ts (mirrored from
// runtime/src/analytics/delivery-velocity.ts).

import type { PipelineStage } from 'mongoose';
import { connectDB, Task } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import {
  buildVelocityPipeline,
  computeDeliveryVelocity,
  velocityWindowStart,
  fmtCycleMs,
  DEFAULT_VELOCITY_WEEKS,
  type VelocityTaskRow,
  type VelocityTrend,
} from '@/lib/delivery-velocity';
import { StatCard, Card, EmptyState, THead } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';

export const dynamic = 'force-dynamic';

function trendLabel(trend: VelocityTrend): string {
  const arrow = trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '→';
  const pct = trend.deltaPct === null ? null : Math.round(trend.deltaPct * 100);
  const label = pct === null ? (trend.recent > 0 ? 'new' : '—') : `${pct > 0 ? '+' : ''}${pct}%`;
  return `${arrow} ${label}`;
}

function TrendBadge({ trend }: { trend: VelocityTrend }) {
  const pct = trend.deltaPct === null ? null : Math.round(trend.deltaPct * 100);
  const label = pct === null ? (trend.recent > 0 ? 'new' : '—') : `${pct > 0 ? '+' : ''}${pct}%`;
  const cls =
    trend.direction === 'up' ? 'text-emerald-400' : trend.direction === 'down' ? 'text-red-400' : 'text-[rgb(var(--text-muted))]';
  const arrow = trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '→';
  return (
    <span className={`font-mono text-xs ${cls}`} title={`recent half ${trend.recent} vs prior half ${trend.prior}`}>
      {arrow} {label}
    </span>
  );
}

function WeekBars({ counts, accent = 'bg-teal-500/70' }: { counts: number[]; accent?: string }) {
  const max = Math.max(1, ...counts);
  return (
    <div className="flex items-end gap-[3px] h-8">
      {counts.map((c, i) => (
        <div
          key={i}
          className={`w-2 rounded-sm ${c > 0 ? accent : 'bg-[rgb(var(--bg-hover))]'}`}
          style={{ height: `${Math.max(8, (c / max) * 100)}%` }}
          title={`${c} shipped`}
        />
      ))}
    </div>
  );
}

export default async function VelocityPage() {
  let dbError = false;
  try {
    await connectDB();
  } catch {
    dbError = true;
  }

  if (dbError) {
    return (
      <div className="max-w-7xl mx-auto">
        <PageHeader title="Velocity" subtitle="Tasks shipped/week · cycle time · throughput trend, per repo." />
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
          Database not reachable — delivery-velocity metrics need the gateway Mongo at :27200.
        </div>
      </div>
    );
  }

  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);
  const now = new Date();
  const since = velocityWindowStart(now, DEFAULT_VELOCITY_WEEKS);

  const rows = await Task.aggregate<VelocityTaskRow>(
    buildVelocityPipeline(since, tf) as unknown as PipelineStage[],
  );
  const report = computeDeliveryVelocity(rows, { weeks: DEFAULT_VELOCITY_WEEKS, now });
  const { fleet, repos, weekStarts } = report;

  const thisWeek = fleet.shippedByWeek[fleet.shippedByWeek.length - 1] ?? 0;
  const prevWeek = fleet.shippedByWeek[fleet.shippedByWeek.length - 2] ?? 0;
  const perWeekAvg = fleet.totalShipped / DEFAULT_VELOCITY_WEEKS;
  const weekLabel = (key: string) => key.slice(5); // MM-DD of the UTC Monday

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={60} />
      <PageHeader
        title="Velocity"
        subtitle={`Tasks shipped/week · median queued→done cycle time · throughput trend — per repo, last ${DEFAULT_VELOCITY_WEEKS} weeks (UTC weeks from ${weekStarts[0]}).`}
      />

      {/* Headline stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label={`Shipped (${DEFAULT_VELOCITY_WEEKS}w)`}
          value={fleet.totalShipped}
          sub={`~${perWeekAvg.toFixed(1)}/week · ${repos.length} repo${repos.length === 1 ? '' : 's'}`}
          accent="green"
        />
        <StatCard label="This week" value={thisWeek} sub={`prev week ${prevWeek}`} accent="blue" />
        <StatCard
          label="Median cycle time"
          value={fmtCycleMs(fleet.medianCycleMs)}
          sub={`p90 ${fmtCycleMs(fleet.p90CycleMs)} · queued→done`}
          accent="purple"
        />
        <StatCard
          label="Throughput trend"
          value={trendLabel(fleet.trend)}
          sub={`last ${Math.floor(DEFAULT_VELOCITY_WEEKS / 2)}w (${fleet.trend.recent}) vs prior (${fleet.trend.prior})`}
          accent={fleet.trend.direction === 'up' ? 'green' : fleet.trend.direction === 'down' ? 'red' : 'gray'}
        />
      </div>

      {/* Fleet weekly throughput */}
      <Card title="Weekly throughput — fleet" meta={`${fleet.totalShipped} tasks shipped in window`} accent="emerald" className="mb-6">
        {fleet.totalShipped === 0 ? (
          <EmptyState>No tasks shipped in the last {DEFAULT_VELOCITY_WEEKS} weeks — velocity appears once the queue starts completing work.</EmptyState>
        ) : (
          <div className="p-5">
            <div className="flex items-end gap-2 h-32">
              {fleet.shippedByWeek.map((count, i) => {
                const max = Math.max(1, ...fleet.shippedByWeek);
                return (
                  <div key={weekStarts[i]} className="flex-1 flex flex-col items-center gap-1">
                    <span className="text-[10px] font-mono text-[rgb(var(--text-secondary))]">{count > 0 ? count : ''}</span>
                    <div
                      className={`w-full rounded-t ${count > 0 ? 'bg-gradient-to-t from-teal-600/70 to-emerald-400/70' : 'bg-[rgb(var(--bg-hover))]'}`}
                      style={{ height: `${Math.max(4, (count / max) * 100)}%` }}
                    />
                    <span className="text-[10px] text-[rgb(var(--text-muted))] font-mono">{weekLabel(weekStarts[i])}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      {/* Per-repo breakdown */}
      <Card title="Per-repo velocity" meta="sorted by tasks shipped" accent="blue">
        {repos.length === 0 ? (
          <EmptyState>No shipped tasks yet in this window.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <THead
                cols={[
                  { label: 'Repo' },
                  { label: `${DEFAULT_VELOCITY_WEEKS}-week` },
                  { label: 'Shipped', align: 'right' },
                  { label: '/week', align: 'right' },
                  { label: 'Median cycle', align: 'right' },
                  { label: 'p90', align: 'right' },
                  { label: 'Trend', align: 'right' },
                  { label: 'Last shipped', align: 'right' },
                ]}
              />
              <tbody>
                {repos.map((r) => (
                  <tr key={r.repo} className="border-b border-[rgb(var(--border-subtle))]/60 hover:bg-[rgb(var(--bg-hover))]/40">
                    <td className="px-4 py-2.5 font-mono text-[rgb(var(--text-primary))]">{r.repo}</td>
                    <td className="px-4 py-2.5"><WeekBars counts={r.shippedByWeek} /></td>
                    <td className="px-4 py-2.5 text-right font-mono">{r.totalShipped}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[rgb(var(--text-secondary))]">
                      {(r.totalShipped / DEFAULT_VELOCITY_WEEKS).toFixed(1)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">{fmtCycleMs(r.medianCycleMs)}</td>
                    <td className="px-4 py-2.5 text-right font-mono text-[rgb(var(--text-secondary))]">{fmtCycleMs(r.p90CycleMs)}</td>
                    <td className="px-4 py-2.5 text-right"><TrendBadge trend={r.trend} /></td>
                    <td className="px-4 py-2.5 text-right font-mono text-xs text-[rgb(var(--text-muted))]">
                      {r.lastShippedAt ? r.lastShippedAt.slice(0, 10) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <p className="text-xs text-[rgb(var(--text-muted))] mt-4">
        Cycle time = task <code>createdAt</code> (queued) → <code>completedAt</code> (done). Weeks bucket by UTC Monday.
        Trend compares the recent half-window against the prior half (±10% reads as flat).
      </p>
    </div>
  );
}
