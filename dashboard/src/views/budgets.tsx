import { connectDB, BudgetUsage, User, BudgetCapOverride } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { getBudgetCapSuggestions } from '@/lib/budget-suggestions';
import { BudgetSuggestionsPanel } from '@/components/budget-suggestions-panel';

export const dynamic = 'force-dynamic';

interface BudgetEnv {
  enabled: boolean;
  monthlyHardCapUsd: number;
  monthlyDailyCapUsd: number;
  perChannelMonthlyCapUsd?: number;
  warnThreshold: number;
  downgradeOpusThreshold: number;
  downgradeSonnetThreshold: number;
}

function readBudgetEnv(): BudgetEnv {
  const num = (v: string | undefined, d: number) => {
    if (!v) return d;
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };
  const optNum = (v: string | undefined): number | undefined => {
    if (!v) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    enabled: process.env.BUDGETS_ENABLED === 'true' || process.env.BUDGETS_ENABLED === '1',
    monthlyHardCapUsd: num(process.env.BUDGET_MONTHLY_HARD_USD, 50),
    monthlyDailyCapUsd: num(process.env.BUDGET_DAILY_HARD_USD, 5),
    perChannelMonthlyCapUsd: optNum(process.env.BUDGET_PER_CHANNEL_MONTHLY_USD),
    warnThreshold: num(process.env.BUDGET_WARN_THRESHOLD, 0.5),
    downgradeOpusThreshold: num(process.env.BUDGET_DOWNGRADE_OPUS, 0.8),
    downgradeSonnetThreshold: num(process.env.BUDGET_DOWNGRADE_SONNET, 0.9),
  };
}

function startOfMonthUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

function startOfDayUTC(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function fmtUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

function pct(value: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(100, (value / cap) * 100);
}

function barColor(p: number): string {
  if (p >= 95) return 'bg-red-500';
  if (p >= 80) return 'bg-orange-500';
  if (p >= 50) return 'bg-yellow-500';
  return 'bg-emerald-500';
}

interface GaugeProps {
  label: string;
  value: number;
  cap: number;
  thresholds?: number[];
}

function Gauge({ label, value, cap, thresholds }: GaugeProps) {
  const percentage = pct(value, cap);
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
      <div className="flex items-baseline justify-between mb-2">
        <h3 className="text-sm text-zinc-400 uppercase tracking-wider">{label}</h3>
        <span className="text-xs text-zinc-500 font-mono">{percentage.toFixed(0)}%</span>
      </div>
      <div className="text-2xl font-bold text-zinc-100 mb-3">
        {fmtUsd(value)} <span className="text-sm text-zinc-500 font-normal">/ {fmtUsd(cap)}</span>
      </div>
      <div className="relative h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`absolute left-0 top-0 h-full rounded-full ${barColor(percentage)}`}
          style={{ width: `${percentage}%` }}
        />
        {thresholds?.map((t, i) => (
          <div
            key={i}
            className="absolute top-0 h-full w-px bg-zinc-600"
            style={{ left: `${t * 100}%` }}
            title={`${(t * 100).toFixed(0)}% threshold`}
          />
        ))}
      </div>
    </div>
  );
}

export default async function BudgetsPage() {
  const env = readBudgetEnv();
  await connectDB();

  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const monthStart = startOfMonthUTC();
  const dayStart = startOfDayUTC();

  type AggOne = { _id: null; total: number };
  type AggGrouped = { _id: string | null; cost: number; calls: number };

  type CapOverrideDoc = { monthlyHardCapUsd?: number; dailyCapUsd?: number; perChannelCapUsd?: number };

  const [override, mtdAgg, todayAgg, byProvider, byModel, byChannel, recentDocs, topExpensive, tenantMembers] = await Promise.all([
    BudgetCapOverride.findOne({ tenantId }).lean() as Promise<CapOverrideDoc | null>,
    BudgetUsage.aggregate<AggOne>([
      { $match: { ...tf, createdAt: { $gte: monthStart } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]),
    BudgetUsage.aggregate<AggOne>([
      { $match: { ...tf, createdAt: { $gte: dayStart } } },
      { $group: { _id: null, total: { $sum: '$costUsd' } } },
    ]),
    BudgetUsage.aggregate<AggGrouped>([
      { $match: { ...tf, createdAt: { $gte: monthStart } } },
      { $group: { _id: '$provider', cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
      { $sort: { cost: -1 } },
    ]),
    BudgetUsage.aggregate<AggGrouped>([
      { $match: { ...tf, createdAt: { $gte: monthStart } } },
      { $group: { _id: '$model', cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
      { $sort: { cost: -1 } },
    ]),
    BudgetUsage.aggregate<AggGrouped>([
      { $match: { ...tf, createdAt: { $gte: monthStart } } },
      { $group: { _id: '$channelId', cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
      { $sort: { cost: -1 } },
    ]),
    BudgetUsage.find({ ...tf }).sort({ createdAt: -1 }).limit(50).lean(),
    BudgetUsage.find({ ...tf, createdAt: { $gte: monthStart } }).sort({ costUsd: -1 }).limit(20).lean(),
    User.find({ ...tf }).select('userId email displayName').lean() as Promise<Array<{ userId?: string; email?: string; displayName?: string }>>,
  ]);

  // Operator-applied overrides (Phase 5b §8 follow-up — "Apply suggestion" on
  // the adaptive cap panel) take precedence over the env-var default. A field
  // left unset in the override document falls back to its env var.
  const monthlyHardCapUsd = override?.monthlyHardCapUsd ?? env.monthlyHardCapUsd;
  const dailyCapUsd = override?.dailyCapUsd ?? env.monthlyDailyCapUsd;
  const perChannelCapUsd = override?.perChannelCapUsd ?? env.perChannelMonthlyCapUsd;

  const suggestions = await getBudgetCapSuggestions(tenantId, {
    monthlyHardCapUsd,
    monthlyDailyCapUsd: dailyCapUsd,
    perChannelMonthlyCapUsd: perChannelCapUsd ?? 0,
  }, { enabled: env.enabled });

  // Per-member breakdown (M2 Team tier) — only rendered when the tenant has
  // more than one user. Rows without userId (system/agent traffic, pre-M2
  // rows) group under "(unattributed)".
  const byUser: AggGrouped[] = tenantMembers.length > 1
    ? await BudgetUsage.aggregate<AggGrouped>([
        { $match: { ...tf, createdAt: { $gte: monthStart } } },
        { $group: { _id: '$userId', cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
        { $sort: { cost: -1 } },
      ])
    : [];
  const memberLabel = new Map(
    tenantMembers
      .filter(m => m.userId)
      .map(m => [m.userId as string, m.displayName || m.email || (m.userId as string)]),
  );

  const mtd = mtdAgg[0]?.total ?? 0;
  const today = todayAgg[0]?.total ?? 0;
  const totalCallsThisMonth = byProvider.reduce((sum, p) => sum + p.calls, 0);
  const totalCostThisMonth = byProvider.reduce((sum, p) => sum + p.cost, 0);

  const numFmt = new Intl.NumberFormat('en-US');

  const perChannelEntries = perChannelCapUsd != null
    ? byChannel.filter(c => c._id != null) as Array<AggGrouped & { _id: string }>
    : [];

  return (
    <div>
      <div className="mb-6 flex items-baseline justify-between">
        <p className="text-sm text-zinc-500">
          Spend audit + budget guard status. Month starts {monthStart.toISOString().slice(0, 10)} UTC.
        </p>
        <div className={`text-xs font-mono px-2 py-1 rounded ${
          env.enabled
            ? 'bg-emerald-500/10 text-emerald-400'
            : 'bg-zinc-800 text-zinc-500'
        }`}>
          {env.enabled ? 'GUARDS ENABLED' : 'GUARDS DISABLED'}
        </div>
      </div>

      {!env.enabled && (
        <div className="mb-6 bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400">
          Budget guards are disabled. Set <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">BUDGETS_ENABLED=1</code> in <code className="bg-zinc-800 px-1.5 py-0.5 rounded text-zinc-300">/tmp/.myai-host-env</code> and rebuild the gateway to enable. Spend is still recorded for visibility.
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <Gauge label="Today (UTC)" value={today} cap={dailyCapUsd} />
        <Gauge
          label="Month-to-date"
          value={mtd}
          cap={monthlyHardCapUsd}
          thresholds={[env.downgradeOpusThreshold, env.downgradeSonnetThreshold]}
        />
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-5">
          <h3 className="text-sm text-zinc-400 uppercase tracking-wider mb-2">This month</h3>
          <div className="text-2xl font-bold text-zinc-100">
            {numFmt.format(totalCallsThisMonth)}
            <span className="text-sm text-zinc-500 font-normal"> calls</span>
          </div>
          <p className="text-xs text-zinc-500 mt-3">
            Avg {totalCallsThisMonth > 0 ? fmtUsd(totalCostThisMonth / totalCallsThisMonth) : '$0.00'} / call
          </p>
        </div>
      </div>

      {perChannelCapUsd != null && perChannelEntries.length > 0 && (
        <div className="mb-8">
          <h2 className="text-lg font-semibold mb-3">Per-channel spend</h2>
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 space-y-3">
            {perChannelEntries.map(c => {
              const p = pct(c.cost, perChannelCapUsd!);
              return (
                <div key={c._id}>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="font-mono text-zinc-300">{c._id}</span>
                    <span className="text-zinc-500">{fmtUsd(c.cost)} / {fmtUsd(perChannelCapUsd!)}</span>
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full ${barColor(p)}`}
                      style={{ width: `${p}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <BudgetSuggestionsPanel suggestions={suggestions} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
        <BreakdownTable title="By provider" rows={byProvider} totalCost={totalCostThisMonth} />
        <BreakdownTable title="By model" rows={byModel} totalCost={totalCostThisMonth} />
        <BreakdownTable
          title="By channel"
          rows={byChannel.map(c => ({ ...c, _id: c._id ?? '(no channel)' }))}
          totalCost={totalCostThisMonth}
        />
      </div>

      {byUser.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-8">
          <BreakdownTable
            title={`By member (${tenantMembers.length} in tenant)`}
            rows={byUser.map(u => ({
              ...u,
              _id: u._id ? (memberLabel.get(u._id) ?? u._id) : '(unattributed)',
            }))}
            totalCost={totalCostThisMonth}
          />
        </div>
      )}

      <div>
        <h2 className="text-lg font-semibold mb-3">Top 20 most expensive calls this month</h2>
        {topExpensive.length === 0 ? (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center text-zinc-500 text-sm">
            No spend recorded this month.
          </div>
        ) : (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
            <table className="card-table w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500 uppercase tracking-wider">
                  <th className="px-4 py-3">When</th>
                  <th className="px-4 py-3">Agent</th>
                  <th className="px-4 py-3">Provider / Model</th>
                  <th className="px-4 py-3">Channel</th>
                  <th className="px-4 py-3 text-right">In / Out</th>
                  <th className="px-4 py-3 text-right">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/50">
                {topExpensive.map((row) => {
                  const r = row as Record<string, unknown>;
                  const created = r.createdAt ? new Date(r.createdAt as Date) : null;
                  return (
                    <tr key={String(r._id)} className="hover:bg-zinc-800/30 transition-colors">
                      <td className="m-title px-4 py-2 text-xs text-zinc-500">
                        {created ? created.toLocaleString() : '-'}
                      </td>
                      <td data-label="Agent" className="px-4 py-2 text-zinc-300">{(r.agentName as string) || '-'}</td>
                      <td data-label="Provider / model" className="px-4 py-2 text-xs text-zinc-400">
                        <span className="text-zinc-500">{r.provider as string}</span>
                        {' / '}
                        {r.model as string}
                      </td>
                      <td data-label="Channel" className="px-4 py-2 text-xs font-mono text-zinc-500">
                        {(r.channelId as string) ?? '-'}
                      </td>
                      <td data-label="In / out" className="px-4 py-2 text-right text-xs text-zinc-400 font-mono">
                        {numFmt.format((r.inputTokens as number) ?? 0)}
                        {' / '}
                        {numFmt.format((r.outputTokens as number) ?? 0)}
                      </td>
                      <td data-label="Cost" className="px-4 py-2 text-right text-zinc-200 font-mono">
                        {fmtUsd((r.costUsd as number) ?? 0)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-zinc-600">
          {recentDocs.length} of last 50 calls loaded for context. Showing 20 highest-cost.
        </p>
      </div>
    </div>
  );
}

interface BreakdownRow { _id: string | null; cost: number; calls: number }

function BreakdownTable({ title, rows, totalCost }: { title: string; rows: BreakdownRow[]; totalCost: number }) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
      <div className="px-4 py-3 border-b border-zinc-800">
        <h3 className="text-sm font-semibold">{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="p-6 text-center text-xs text-zinc-500">No data</div>
      ) : (
        <table className="card-table w-full text-sm">
          <tbody className="divide-y divide-zinc-800/50">
            {rows.slice(0, 8).map((r) => {
              const share = totalCost > 0 ? (r.cost / totalCost) * 100 : 0;
              return (
                <tr key={r._id ?? '(none)'} className="hover:bg-zinc-800/30">
                  <td className="m-title px-4 py-2 text-xs text-zinc-300 truncate max-w-[140px]">
                    {r._id ?? '(none)'}
                  </td>
                  <td data-label="Calls" className="px-4 py-2 text-right text-xs text-zinc-500 font-mono">
                    {r.calls}
                  </td>
                  <td data-label="Cost" className="px-4 py-2 text-right text-xs text-zinc-200 font-mono">
                    ${r.cost.toFixed(2)}
                  </td>
                  <td data-label="Share" className="px-4 py-2 text-right text-xs text-zinc-500 font-mono w-12">
                    {share.toFixed(0)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
