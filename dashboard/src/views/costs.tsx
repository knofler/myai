import { StatCard } from '@/components/ui/card';
import { connectDB, BudgetUsage } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';

export const dynamic = 'force-dynamic';

// Phase 5e — Comprehensive cost analytics dashboard.
//
// Five sections:
//   1. Stat cards: all-time spend, MTD, today, avg daily (trailing 30d)
//   2. Provider × model breakdown table
//   3. 30-day daily spend bar chart (table-based)
//   4. Top 10 most expensive calls
//   5. Monthly trend (last 6 months)

interface AggTotal { _id: null; total: number }
interface ProviderModelRow {
  _id: { provider: string; model: string };
  totalCost: number;
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
}
interface DailyBucket {
  _id: string; // YYYY-MM-DD
  cost: number;
  calls: number;
}
interface MonthlyBucket {
  _id: string; // YYYY-MM
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

function fmtUsd(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function startOfMonthUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfDayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function thirtyDaysAgoUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29));
}

function sixMonthsAgoUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5, 1));
}

function lastNDates(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function lastNMonths(n: number): string[] {
  const out: string[] = [];
  const today = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - i, 1));
    out.push(d.toISOString().slice(0, 7));
  }
  return out;
}

export default async function CostsPage() {
  await connectDB();

  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const monthStart = startOfMonthUTC();
  const dayStart = startOfDayUTC();
  const thirtyDaysStart = thirtyDaysAgoUTC();
  const sixMonthsStart = sixMonthsAgoUTC();

  const [
    allTimeAgg,
    mtdAgg,
    todayAgg,
    thirtyDayAgg,
    providerModelRows,
    dailyBuckets,
    monthlyBuckets,
    topExpensiveDocs,
  ] = await Promise.all([
    // 1. All-time total
    BudgetUsage.aggregate<AggTotal>([
      { $match: { ...tf } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]),
    // 2. Month-to-date
    BudgetUsage.aggregate<AggTotal>([
      { $match: { ...tf, createdAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]),
    // 3. Today
    BudgetUsage.aggregate<AggTotal>([
      { $match: { ...tf, createdAt: { $gte: dayStart } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]),
    // 4. Trailing 30d total (for average)
    BudgetUsage.aggregate<AggTotal>([
      { $match: { ...tf, createdAt: { $gte: thirtyDaysStart } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]),
    // 5. Provider x Model breakdown (MTD)
    BudgetUsage.aggregate<ProviderModelRow>([
      { $match: { ...tf, createdAt: { $gte: monthStart } } },
      {
        $group: {
          _id: { provider: '$provider', model: '$model' },
          totalCost: { $sum: '$costUsd' },
          totalCalls: { $sum: 1 },
          totalInputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
          totalOutputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
        },
      },
      { $sort: { totalCost: -1 } },
    ]),
    // 6. Daily buckets (30 days)
    BudgetUsage.aggregate<DailyBucket>([
      { $match: { ...tf, createdAt: { $gte: thirtyDaysStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } },
          cost: { $sum: '$costUsd' },
          calls: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // 7. Monthly buckets (last 6 months)
    BudgetUsage.aggregate<MonthlyBucket>([
      { $match: { ...tf, createdAt: { $gte: sixMonthsStart } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt', timezone: 'UTC' } },
          cost: { $sum: '$costUsd' },
          calls: { $sum: 1 },
          inputTokens: { $sum: { $ifNull: ['$inputTokens', 0] } },
          outputTokens: { $sum: { $ifNull: ['$outputTokens', 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    // 8. Top 10 most expensive calls (all time)
    BudgetUsage.find({ ...tf })
      .sort({ costUsd: -1 })
      .limit(10)
      .lean(),
  ]);

  const allTimeSpend = allTimeAgg[0]?.total ?? 0;
  const mtdSpend = mtdAgg[0]?.total ?? 0;
  const todaySpend = todayAgg[0]?.total ?? 0;
  const thirtyDaySpend = thirtyDayAgg[0]?.total ?? 0;
  const avgDaily30d = thirtyDaySpend / 30;

  // Build 30-day daily series, filling missing days with 0.
  const dates = lastNDates(30);
  const bucketsByDate = new Map<string, DailyBucket>(dailyBuckets.map(b => [b._id, b]));
  const dailySeries: DailyBucket[] = dates.map(d => bucketsByDate.get(d) ?? { _id: d, cost: 0, calls: 0 });
  const maxDailyCost = Math.max(...dailySeries.map(d => d.cost), 0.01);
  const peakDay = dailySeries.reduce<DailyBucket>((peak, d) => (d.cost > peak.cost ? d : peak), dailySeries[0]);

  // Build 6-month series, filling missing months with 0.
  const months = lastNMonths(6);
  const bucketsByMonth = new Map<string, MonthlyBucket>(monthlyBuckets.map(b => [b._id, b]));
  const monthlySeries: MonthlyBucket[] = months.map(m => bucketsByMonth.get(m) ?? { _id: m, cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 });
  const maxMonthlyCost = Math.max(...monthlySeries.map(m => m.cost), 0.01);

  const numFmt = new Intl.NumberFormat('en-US');

  return (
    <div>
      {/* Header */}

      {/* ── 1. Stat Cards ─────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard
          label="Total spend (all time)"
          value={fmtUsd(allTimeSpend)}
          sub="Across all providers and models"
          accent="green"
        />
        <StatCard
          label="This month"
          value={fmtUsd(mtdSpend)}
          sub={`Since ${monthStart.toISOString().slice(0, 10)} UTC`}
          accent="blue"
        />
        <StatCard
          label="Today"
          value={fmtUsd(todaySpend)}
          sub={`Since ${dayStart.toISOString().slice(0, 10)} UTC`}
          accent={todaySpend > 0 ? 'yellow' : 'gray'}
        />
        <StatCard
          label="Avg daily (30d)"
          value={fmtUsd(avgDaily30d)}
          sub={`${fmtUsd(thirtyDaySpend)} over 30 days`}
          accent="gray"
        />
      </div>

      {/* ── 2. Provider x Model Breakdown ─────────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-800 flex items-baseline justify-between">
          <h2 className="text-lg font-semibold">Provider breakdown (MTD)</h2>
          <span className="text-xs text-zinc-500">{providerModelRows.length} model(s)</span>
        </div>
        {providerModelRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-zinc-500">
            No spend recorded this month. Route calls through the gateway with <code className="text-zinc-400">BUDGETS_ENABLED=1</code> to populate.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">Model</th>
                  <th className="px-4 py-3 text-right">Calls</th>
                  <th className="px-4 py-3 text-right">Tokens in</th>
                  <th className="px-4 py-3 text-right">Tokens out</th>
                  <th className="px-4 py-3 text-right">Total cost</th>
                  <th className="px-4 py-3 text-right">Avg / call</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {providerModelRows.map((row) => {
                  const avgPerCall = row.totalCalls > 0 ? row.totalCost / row.totalCalls : 0;
                  return (
                    <tr key={`${row._id.provider}-${row._id.model}`} className="hover:bg-zinc-800/30 transition-colors">
                      <td className="m-title px-4 py-2.5 text-zinc-300">
                        {row._id.provider ?? '(unknown)'}
                      </td>
                      <td data-label="Model" className="px-4 py-2.5 text-xs font-mono text-zinc-400">
                        {row._id.model ?? '(unknown)'}
                      </td>
                      <td data-label="Calls" className="px-4 py-2.5 text-right text-zinc-400 font-mono">
                        {numFmt.format(row.totalCalls)}
                      </td>
                      <td data-label="Tokens in" className="px-4 py-2.5 text-right text-zinc-400 font-mono text-xs">
                        {fmtTokens(row.totalInputTokens)}
                      </td>
                      <td data-label="Tokens out" className="px-4 py-2.5 text-right text-zinc-400 font-mono text-xs">
                        {fmtTokens(row.totalOutputTokens)}
                      </td>
                      <td data-label="Total cost" className="px-4 py-2.5 text-right text-zinc-200 font-mono font-semibold">
                        {fmtUsd(row.totalCost)}
                      </td>
                      <td data-label="Avg / call" className="px-4 py-2.5 text-right text-xs text-zinc-500 font-mono">
                        {fmtUsd(avgPerCall)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t border-zinc-700 bg-zinc-950/50">
                  <td className="m-title px-4 py-2.5 text-xs text-zinc-400 font-semibold" colSpan={2}>
                    Total
                  </td>
                  <td data-label="Calls" className="px-4 py-2.5 text-right text-zinc-300 font-mono text-xs">
                    {numFmt.format(providerModelRows.reduce((s: number, r: ProviderModelRow) => s + r.totalCalls, 0))}
                  </td>
                  <td data-label="Tokens in" className="px-4 py-2.5 text-right text-zinc-300 font-mono text-xs">
                    {fmtTokens(providerModelRows.reduce((s: number, r: ProviderModelRow) => s + r.totalInputTokens, 0))}
                  </td>
                  <td data-label="Tokens out" className="px-4 py-2.5 text-right text-zinc-300 font-mono text-xs">
                    {fmtTokens(providerModelRows.reduce((s: number, r: ProviderModelRow) => s + r.totalOutputTokens, 0))}
                  </td>
                  <td data-label="Total cost" className="px-4 py-2.5 text-right text-emerald-400 font-mono font-bold">
                    {fmtUsd(providerModelRows.reduce((s: number, r: ProviderModelRow) => s + r.totalCost, 0))}
                  </td>
                  <td className="m-hide px-4 py-2.5" />
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* ── 3. 30-Day Daily Spend Chart ───────────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold">Daily spend (30 days)</h2>
          <div className="text-xs text-zinc-500">
            Peak: <span className="text-zinc-300">{fmtUsd(peakDay.cost)}</span> on {peakDay._id}
          </div>
        </div>
        <div className="space-y-1">
          {dailySeries.map((d) => {
            const widthPct = (d.cost / maxDailyCost) * 100;
            const isToday = d._id === dates[dates.length - 1];
            return (
              <div key={d._id} className="flex items-center gap-3 text-xs font-mono">
                <span className={`w-20 text-right ${isToday ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {d._id.slice(5)}
                </span>
                <div className="flex-1 h-4 bg-zinc-950 rounded overflow-hidden relative">
                  <div
                    className={`absolute left-0 top-0 h-full rounded ${isToday ? 'bg-emerald-500/60' : 'bg-zinc-600'}`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
                <span className={`w-16 text-right ${d.cost > 0 ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {d.cost > 0 ? fmtUsd(d.cost) : '—'}
                </span>
                <span className="w-10 text-right text-zinc-600">
                  {d.calls > 0 ? `${d.calls}` : ''}
                </span>
              </div>
            );
          })}
        </div>
        {dailySeries.every(d => d.cost === 0) && (
          <div className="mt-3 text-xs text-zinc-600 text-center">
            No spend recorded in the last 30 days.
          </div>
        )}
      </div>

      {/* ── 4. Top 10 Most Expensive Calls ────────────────────── */}
      <div className="mb-8">
        <h2 className="text-lg font-semibold mb-3">Top 10 most expensive calls</h2>
        {topExpensiveDocs.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center text-zinc-500 text-sm">
            No calls recorded yet.
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <div className="overflow-x-auto">
              <table className="card-table w-full text-sm">
                <thead>
                  <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                    <th className="px-4 py-3">When</th>
                    <th className="px-4 py-3">Agent</th>
                    <th className="px-4 py-3">Provider</th>
                    <th className="px-4 py-3">Model</th>
                    <th className="px-4 py-3 text-right">Tokens in</th>
                    <th className="px-4 py-3 text-right">Tokens out</th>
                    <th className="px-4 py-3 text-right">Cost</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800/50">
                  {topExpensiveDocs.map((doc: Record<string, unknown>) => {
                    const r = doc;
                    const created = r.createdAt ? new Date(r.createdAt as Date) : null;
                    return (
                      <tr key={String(r._id)} className="hover:bg-zinc-800/30 transition-colors">
                        <td className="m-title px-4 py-2.5 text-xs text-zinc-500 whitespace-nowrap">
                          {created ? created.toLocaleString() : '-'}
                        </td>
                        <td data-label="Agent" className="px-4 py-2.5 text-zinc-300 truncate max-w-[140px]">
                          {(r.agentName as string) || '-'}
                        </td>
                        <td data-label="Provider" className="px-4 py-2.5 text-xs text-zinc-500">
                          {(r.provider as string) || '-'}
                        </td>
                        <td data-label="Model" className="px-4 py-2.5 text-xs font-mono text-zinc-400">
                          {(r.model as string) || '-'}
                        </td>
                        <td data-label="Tokens in" className="px-4 py-2.5 text-right text-xs text-zinc-400 font-mono">
                          {numFmt.format((r.inputTokens as number) ?? 0)}
                        </td>
                        <td data-label="Tokens out" className="px-4 py-2.5 text-right text-xs text-zinc-400 font-mono">
                          {numFmt.format((r.outputTokens as number) ?? 0)}
                        </td>
                        <td data-label="Cost" className="px-4 py-2.5 text-right text-zinc-200 font-mono font-semibold">
                          {fmtUsd((r.costUsd as number) ?? 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* ── 5. Monthly Trend (Last 6 Months) ──────────────────── */}
      <div className="mb-8 bg-zinc-900 border border-zinc-800 rounded-lg p-5">
        <div className="flex items-baseline justify-between mb-4">
          <h2 className="text-lg font-semibold">Monthly trend (6 months)</h2>
          <span className="text-xs text-zinc-500">
            {months[0]} to {months[months.length - 1]}
          </span>
        </div>

        {/* Bar chart */}
        <div className="flex items-end gap-2 h-40 mb-4">
          {monthlySeries.map((m) => {
            const heightPct = (m.cost / maxMonthlyCost) * 100;
            const isCurrent = m._id === months[months.length - 1];
            return (
              <div key={m._id} className="flex-1 flex flex-col items-center gap-1">
                <span className={`text-xs font-mono ${m.cost > 0 ? 'text-zinc-300' : 'text-zinc-700'}`}>
                  {m.cost > 0 ? fmtUsd(m.cost) : ''}
                </span>
                <div className="w-full flex items-end justify-center" style={{ height: '100px' }}>
                  <div
                    className={`w-full max-w-16 rounded-t ${isCurrent ? 'bg-emerald-500/60' : 'bg-zinc-600'}`}
                    style={{ height: `${Math.max(heightPct, m.cost > 0 ? 2 : 0)}%` }}
                  />
                </div>
                <span className={`text-[10px] font-mono ${isCurrent ? 'text-emerald-400' : 'text-zinc-500'}`}>
                  {m._id.slice(5)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Detail table below chart */}
        <div className="overflow-x-auto">
          <table className="card-table w-full text-xs">
            <thead>
              <tr className="border-b border-zinc-800 text-left text-zinc-500 uppercase tracking-wider">
                <th className="px-3 py-2">Month</th>
                <th className="px-3 py-2 text-right">Calls</th>
                <th className="px-3 py-2 text-right">Tokens in</th>
                <th className="px-3 py-2 text-right">Tokens out</th>
                <th className="px-3 py-2 text-right">Spend</th>
                <th className="px-3 py-2 text-right">vs prev</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {monthlySeries.map((m, i) => {
                const prev = i > 0 ? monthlySeries[i - 1].cost : 0;
                const delta = prev > 0 ? ((m.cost - prev) / prev) * 100 : 0;
                const isCurrent = m._id === months[months.length - 1];
                return (
                  <tr key={m._id} className={`hover:bg-zinc-800/30 transition-colors ${isCurrent ? 'bg-emerald-500/5' : ''}`}>
                    <td className={`m-title px-3 py-2 font-mono ${isCurrent ? 'text-emerald-400' : 'text-zinc-300'}`}>
                      {m._id}
                    </td>
                    <td data-label="Calls" className="px-3 py-2 text-right text-zinc-400 font-mono">
                      {numFmt.format(m.calls)}
                    </td>
                    <td data-label="Tokens in" className="px-3 py-2 text-right text-zinc-400 font-mono">
                      {fmtTokens(m.inputTokens)}
                    </td>
                    <td data-label="Tokens out" className="px-3 py-2 text-right text-zinc-400 font-mono">
                      {fmtTokens(m.outputTokens)}
                    </td>
                    <td data-label="Spend" className="px-3 py-2 text-right text-zinc-200 font-mono font-semibold">
                      {m.cost > 0 ? fmtUsd(m.cost) : '—'}
                    </td>
                    <td data-label="vs prev" className="px-3 py-2 text-right font-mono">
                      {i === 0 || prev === 0 ? (
                        <span className="text-zinc-700">—</span>
                      ) : delta > 0 ? (
                        <span className="text-red-400">+{delta.toFixed(0)}%</span>
                      ) : delta < 0 ? (
                        <span className="text-emerald-400">{delta.toFixed(0)}%</span>
                      ) : (
                        <span className="text-zinc-500">0%</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {monthlySeries.every(m => m.cost === 0) && (
          <div className="mt-3 text-xs text-zinc-600 text-center">
            No spend recorded in the last 6 months.
          </div>
        )}
      </div>

    </div>
  );
}

