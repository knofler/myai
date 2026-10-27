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
import { StatCard, Card, EmptyState } from '@/components/ui/card';
import { DataTable, type DataRow } from '@/components/ui/data-table';
import { PageHeader } from '@/components/page-header';
import { plural, rate } from '@/lib/summary';
import AutoRefresh from '@/components/auto-refresh';
import { dbUnreachableHint } from '@/lib/db-hint';

export const dynamic = 'force-dynamic';

/* ── The one-line answer (§5.1) ─────────────────────── */

function velocitySummary(
  totalShipped: number,
  repoCount: number,
  thisWeek: number,
  prevWeek: number,
  direction: VelocityTrend['direction'],
): string {
  if (totalShipped === 0) {
    return `Nothing has shipped in the last ${DEFAULT_VELOCITY_WEEKS} weeks. Velocity appears here once your queue starts completing work.`;
  }
  const perWeek = rate(totalShipped / DEFAULT_VELOCITY_WEEKS);
  const head = `Your fleet shipped ${plural(totalShipped, 'task')} in the last ${DEFAULT_VELOCITY_WEEKS} weeks, about ${perWeek} a week across ${plural(repoCount, 'repo')}.`;
  const compare =
    thisWeek > prevWeek ? `up from ${prevWeek} last week`
      : thisWeek < prevWeek ? `down from ${prevWeek} last week`
      : 'the same as last week';
  const pace = direction === 'up' ? 'speeding up' : direction === 'down' ? 'slowing down' : 'holding steady';
  const week = thisWeek === 0 ? 'Nothing has shipped this week' : `${plural(thisWeek, 'task')} shipped this week`;
  return `${head} ${week}, ${compare}, and throughput is ${pace}.`;
}

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
        <PageHeader
          icon="velocity"
          title="Velocity"
          summary="Velocity cannot be read right now because the database is unreachable."
          subtitle="Tasks shipped a week, cycle time and throughput trend, per repo."
        />
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
          {dbUnreachableHint('delivery-velocity metrics')}
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
        icon="velocity"
        title="Velocity"
        summary={velocitySummary(fleet.totalShipped, repos.length, thisWeek, prevWeek, fleet.trend.direction)}
        subtitle={`Last ${DEFAULT_VELOCITY_WEEKS} weeks · UTC weeks from ${weekStarts[0]} · cycle time is queued to done`}
      />

      {/* Headline stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard
          label={`Shipped (${DEFAULT_VELOCITY_WEEKS} weeks)`}
          value={fleet.totalShipped}
          sub={`~${perWeekAvg.toFixed(1)}/week · ${repos.length} repo${repos.length === 1 ? '' : 's'}`}
          icon="check"
          tone={fleet.totalShipped > 0 ? 'ok' : 'muted'}
        />
        <StatCard label="This week" value={thisWeek} sub={`prev week ${prevWeek}`} icon="velocity" tone={thisWeek > 0 ? 'ok' : 'muted'} />
        <StatCard
          label="Median cycle time"
          value={fmtCycleMs(fleet.medianCycleMs)}
          sub={`p90 ${fmtCycleMs(fleet.p90CycleMs)} · queued→done`}
          icon="clock"
          tone="muted"
        />
        <StatCard
          label="Throughput trend"
          value={trendLabel(fleet.trend)}
          sub={`last ${Math.floor(DEFAULT_VELOCITY_WEEKS / 2)}w (${fleet.trend.recent}) vs prior (${fleet.trend.prior})`}
          icon="analytics"
          tone={fleet.totalShipped === 0 ? 'muted' : fleet.trend.direction === 'up' ? 'ok' : fleet.trend.direction === 'down' ? 'warn' : 'muted'}
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
                    <span className="text-label font-mono text-[rgb(var(--text-secondary))]">{count > 0 ? count : ''}</span>
                    <div
                      className={`w-full rounded-t ${count > 0 ? 'bg-gradient-to-t from-teal-600/70 to-emerald-400/70' : 'bg-[rgb(var(--bg-hover))]'}`}
                      style={{ height: `${Math.max(4, (count / max) * 100)}%` }}
                    />
                    <span className="text-label text-[rgb(var(--text-muted))] font-mono">{weekLabel(weekStarts[i])}</span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </Card>

      {/* Per-repo breakdown */}
      {repos.length === 0 ? (
        <Card title="Per-repo velocity" meta="sorted by tasks shipped" accent="blue">
          <EmptyState>No shipped tasks yet in this window.</EmptyState>
        </Card>
      ) : (
        <DataTable
          title="Per-repo velocity"
          searchPlaceholder="Search repos…"
          defaultSort="shipped"
          defaultDesc
          columns={[
            { label: 'Repo', sortKey: 'repo', mobile: 'title' },
            { label: `${DEFAULT_VELOCITY_WEEKS}-week`, mobile: 'detail' },
            { label: 'Shipped', align: 'right', sortKey: 'shipped', mobile: 'meta' },
            { label: '/week', align: 'right', sortKey: 'perWeek', mobile: 'detail' },
            { label: 'Median cycle', align: 'right', sortKey: 'medianCycle', mobile: 'meta' },
            { label: 'p90', align: 'right', sortKey: 'p90Cycle', mobile: 'detail' },
            { label: 'Trend', align: 'right', sortKey: 'trend', mobile: 'meta' },
            { label: 'Last shipped', align: 'right', sortKey: 'lastShipped', mobile: 'detail' },
          ]}
          rows={repos.map((r): DataRow => ({
            id: r.repo,
            search: r.repo.toLowerCase(),
            sort: {
              repo: r.repo,
              shipped: r.totalShipped,
              perWeek: r.totalShipped / DEFAULT_VELOCITY_WEEKS,
              medianCycle: r.medianCycleMs ?? Infinity,
              p90Cycle: r.p90CycleMs ?? Infinity,
              trend: r.trend.deltaPct ?? -Infinity,
              lastShipped: r.lastShippedAt ?? '',
            },
            cells: [
              <span className="font-mono text-[rgb(var(--text-primary))]">{r.repo}</span>,
              <WeekBars counts={r.shippedByWeek} />,
              <span className="font-mono">{r.totalShipped}</span>,
              <span className="font-mono text-[rgb(var(--text-secondary))]">{(r.totalShipped / DEFAULT_VELOCITY_WEEKS).toFixed(1)}</span>,
              <span className="font-mono">{fmtCycleMs(r.medianCycleMs)}</span>,
              <span className="font-mono text-[rgb(var(--text-secondary))]">{fmtCycleMs(r.p90CycleMs)}</span>,
              <TrendBadge trend={r.trend} />,
              <span className="font-mono text-xs text-[rgb(var(--text-muted))]">{r.lastShippedAt ? r.lastShippedAt.slice(0, 10) : '—'}</span>,
            ],
          }))}
        />
      )}

      <p className="text-xs text-[rgb(var(--text-muted))] mt-4">
        Cycle time = task <code>createdAt</code> (queued) → <code>completedAt</code> (done). Weeks bucket by UTC Monday.
        Trend compares the recent half-window against the prior half (±10% reads as flat).
      </p>
    </div>
  );
}
