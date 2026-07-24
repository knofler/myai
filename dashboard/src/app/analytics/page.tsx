// /analytics — fleet analytics in one place:
//   • Task throughput (tasks completed per day, 21d)
//   • Plan progress per repo (done / total plan days)
//   • Runner activity (sessions, success rate, schedule runs)
//   • Cost / budget trend (daily spend, 21d)
//   • Cold start today-vs-brain (avg tokens per session start, legacy vs brain path)
//   • Continuity meter (cold-start tokens saved by context_boot/brain_delta/memory_context)
//
// Server component reading Mongo aggregations + the gateway, themed teal/gel.

import { connectDB, Task, PlanDay, Schedule, Session, BudgetUsage, ContinuityMetric, ActivationEvent } from '@/lib/db';
import { callGateway } from '@/lib/gateway';
import { fmtUsd } from '@/lib/format';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { StatCard, Card, EmptyState } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';

export const dynamic = 'force-dynamic';

interface DayBucket { _id: string; count: number }
interface SpendBucket { _id: string; cost: number; calls: number }
interface PlanDoc { repo: string; status: string }
interface ContinuityBucket { _id: string; tokens: number; boots: number }
interface ActivationBucket { _id: string; tenants: number }

// The activation funnel, in order (mirror of monitoring/activation-funnel.ts).
const ACTIVATION_STEPS: ReadonlyArray<{ step: string; label: string }> = [
  { step: 'signup', label: 'Signed up' },
  { step: 'init', label: 'Project connected' },
  { step: 'first_brain_boot', label: 'First brain boot' },
  { step: 'first_brain_delta', label: 'First brain delta' },
  { step: 'wrapup_merge', label: 'Continuity aha' },
];

// The self-serve conversion funnel — the plain sellable-product question,
// distinct from the "continuity aha" framing above (mirror of
// monitoring/activation-funnel.ts::SELF_SERVE_STEPS).
const SELF_SERVE_STEPS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'signup', label: 'Signed up' },
  { key: 'init', label: 'Project connected' },
  { key: 'first_value', label: 'First task shipped' },
  { key: 'retained', label: 'Retained (2nd task shipped)' },
];
interface BootCompareBucket { _id: null; boots: number; tokens: number; baselineTokens: number; baselineBoots: number }
// Real token burn, month-to-date, from budgetusages. Cache-read is broken out
// explicitly because it dominates raw volume — the compiled context re-read on
// every turn (a real session: ~36M cache-reads vs 308k output over 234 turns).
interface BurnBucket { _id: null; input: number; output: number; cacheCreate: number; cacheRead: number; cost: number; calls: number }

// Gateway hot-path perf meter (in-process p95 + slow-query log) — served live by
// the `perf_stats` MCP tool, not persisted to Mongo. See runtime/monitoring/perf-metrics.ts.
interface ToolPerf { tool: string; count: number; avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number; maxMs: number; slow: number; errors: number }
interface SlowQuery { tool: string; ms: number; tenantId?: string; error: boolean; at: number }
interface PerfStats {
  slowQueryThresholdMs: number;
  tools: ToolPerf[];
  overall: { count: number; avgMs: number; p95Ms: number; slow: number; errors: number };
  slowQueries: SlowQuery[];
  hotPaths: Array<{ tool: string; slow: number; p95Ms: number; count: number }>;
}

// Documented legacy session-start cost (plan/jam/brain-layer.md token-economics
// table: ~50–70k in). Used only until a measured baseline lands in the meter.
const LEGACY_BOOT_EST_TOKENS = 60_000;

// Rolling-window output-token budget — the account-level ceiling the token
// guard meters against (config/session-limits.json → token_budget.rolling_window,
// calibrated 2026-06-10 to ~4.4M / 5h). Overridable so the meter tracks the real
// budget without a code change.
const ROLLING_WINDOW_HOURS = 5;
const ROLLING_OUTPUT_BUDGET = Number(process.env.MYAI_ROLLING_OUTPUT_BUDGET) || 4_400_000;

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
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

export default async function AnalyticsPage() {
  let dbError = false;
  try { await connectDB(); } catch { dbError = true; }

  if (dbError) {
    return (
      <div className="max-w-7xl mx-auto">
        <PageHeader title="Analytics" subtitle="Throughput, plan progress, runner activity, and cost trend." />
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400">
          Database not reachable — analytics need the gateway Mongo at :27200.
        </div>
      </div>
    );
  }

  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const N = 21;
  const windowStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - (N - 1)));
  const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
  const rollingStart = new Date(Date.now() - ROLLING_WINDOW_HOURS * 3_600_000);

  const [
    throughput,
    spendDaily,
    plans,
    doneTotal,
    blockedTotal,
    workingNow,
    sessionTotal,
    sessionClosed,
    schedules,
    continuityDaily,
    continuityMonth,
    continuityAll,
    bootCompare,
    activationRows,
    selfServeEventRows,
    selfServeRetainedRows,
    burnMonth,
    burnRolling,
  ] = await Promise.all([
    Task.aggregate<DayBucket>([
      { $match: { ...tf, status: 'done', completedAt: { $gte: windowStart } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$completedAt', timezone: 'UTC' } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    BudgetUsage.aggregate<SpendBucket>([
      { $match: { ...tf, createdAt: { $gte: windowStart } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, cost: { $sum: '$costUsd' }, calls: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    PlanDay.find({ ...tf }).lean() as unknown as Promise<PlanDoc[]>,
    Task.countDocuments({ ...tf, status: 'done' }) as Promise<number>,
    Task.countDocuments({ ...tf, status: 'blocked' }) as Promise<number>,
    Task.countDocuments({ ...tf, status: 'working' }) as Promise<number>,
    Session.countDocuments({ ...tf }) as Promise<number>,
    Session.countDocuments({ ...tf, status: 'closed' }) as Promise<number>,
    Schedule.find({ ...tf }).lean() as unknown as Promise<Array<{ runCount?: number; errorCount?: number; enabled?: boolean }>>,
    ContinuityMetric.aggregate<ContinuityBucket>([
      { $match: { ...tf, createdAt: { $gte: windowStart } } },
      { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: 'UTC' } }, tokens: { $sum: '$tokens' }, boots: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
    ContinuityMetric.aggregate<{ _id: null; tokens: number; boots: number }>([
      { $match: { ...tf, createdAt: { $gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } } },
      { $group: { _id: null, tokens: { $sum: '$tokens' }, boots: { $sum: 1 } } },
    ]),
    ContinuityMetric.aggregate<{ _id: null; tokens: number; boots: number }>([
      { $match: { ...tf } },
      { $group: { _id: null, tokens: { $sum: '$tokens' }, boots: { $sum: 1 } } },
    ]),
    // Cold start today-vs-brain (B7): month-to-date session-start boots
    // (context_boot + brain_delta) with their measured legacy baselines.
    ContinuityMetric.aggregate<BootCompareBucket>([
      { $match: { ...tf, tool: { $in: ['context_boot', 'brain_delta'] }, createdAt: { $gte: new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1)) } } },
      { $group: {
        _id: null,
        boots: { $sum: 1 },
        tokens: { $sum: '$tokens' },
        baselineTokens: { $sum: { $ifNull: ['$baselineTokens', 0] } },
        baselineBoots: { $sum: { $cond: [{ $gt: [{ $ifNull: ['$baselineTokens', 0] }, 0] }, 1, 0] } },
      } },
    ]),
    // Activation funnel — distinct tenants that reached each milestone. Counts
    // only (never any tenant's content); this is the product funnel, so it is
    // intentionally cross-tenant (the operator/product view). See ADR-014.
    ActivationEvent.aggregate<ActivationBucket>([
      { $group: { _id: { step: '$step', tenantId: '$tenantId' } } },
      { $group: { _id: '$_id.step', tenants: { $sum: 1 } } },
    ]),
    // Self-serve conversion — signup → init → first task shipped, from the
    // same ActivationEvent rows ('first_ship' is stamped on a tenant's first
    // done task by the lifecycle-email chokepoint). Cross-tenant, same as the
    // activation funnel above.
    ActivationEvent.aggregate<ActivationBucket>([
      { $match: { step: { $in: ['signup', 'init', 'first_ship'] } } },
      { $group: { _id: { step: '$step', tenantId: '$tenantId' } } },
      { $group: { _id: '$_id.step', tenants: { $sum: 1 } } },
    ]),
    // Self-serve conversion — 'retained': distinct tenants with 2+ done tasks.
    // Computed read-time from Task (a standing state, not a first-touch
    // milestone) — mirror of monitoring/activation-funnel.ts::getSelfServeConversion.
    Task.aggregate<{ tenants: number }>([
      { $match: { status: 'done' } },
      { $group: { _id: '$tenantId', done: { $sum: 1 } } },
      { $match: { done: { $gte: 2 } } },
      { $count: 'tenants' },
    ]),
    // Real token burn month-to-date — output + input + cache-create + cache-read
    // + $ cost, straight from budgetusages. Cache-read is summed separately so
    // the UI can show that it dwarfs everything else.
    BudgetUsage.aggregate<BurnBucket>([
      { $match: { ...tf, createdAt: { $gte: monthStart } } },
      { $group: {
        _id: null,
        input: { $sum: { $ifNull: ['$inputTokens', 0] } },
        output: { $sum: { $ifNull: ['$outputTokens', 0] } },
        cacheCreate: { $sum: { $ifNull: ['$cacheCreationInputTokens', 0] } },
        cacheRead: { $sum: { $ifNull: ['$cacheReadInputTokens', 0] } },
        cost: { $sum: { $ifNull: ['$costUsd', 0] } },
        calls: { $sum: 1 },
      } },
    ]),
    // Rolling-window output burn — the account-level ceiling signal (last 5h).
    BudgetUsage.aggregate<{ _id: null; output: number }>([
      { $match: { ...tf, createdAt: { $gte: rollingStart } } },
      { $group: { _id: null, output: { $sum: { $ifNull: ['$outputTokens', 0] } } } },
    ]),
  ]);

  // Live gateway perf meter — in-process p95 + slow-query log (best-effort; the
  // card renders an empty state when the gateway is unreachable).
  const perf = await callGateway<PerfStats>('perf_stats');
  const perfTools = (perf?.tools ?? []).slice(0, 12);
  const slowQueries = (perf?.slowQueries ?? []).slice(0, 12);
  const slowThreshold = perf?.slowQueryThresholdMs ?? 500;

  const dates = lastNDates(N);

  // Throughput series.
  const tputByDate = new Map(throughput.map((b) => [b._id, b.count]));
  const tputSeries = dates.map((d) => ({ date: d, count: tputByDate.get(d) ?? 0 }));
  const maxTput = Math.max(...tputSeries.map((d) => d.count), 1);
  const tputTotal = tputSeries.reduce((s, d) => s + d.count, 0);
  const tputAvg = tputTotal / N;

  // Spend series.
  const spendByDate = new Map(spendDaily.map((b) => [b._id, b]));
  const spendSeries = dates.map((d) => spendByDate.get(d) ?? { _id: d, cost: 0, calls: 0 });
  const maxSpend = Math.max(...spendSeries.map((d) => d.cost), 0.01);
  const spendTotal = spendSeries.reduce((s, d) => s + d.cost, 0);

  // Plan progress per repo.
  const byRepo: Record<string, { done: number; total: number }> = {};
  for (const p of plans) {
    (byRepo[p.repo] ??= { done: 0, total: 0 });
    byRepo[p.repo].total++;
    if (p.status === 'done') byRepo[p.repo].done++;
  }
  const planRepos = Object.entries(byRepo).sort((a, b) => b[1].total - a[1].total);

  // Continuity meter — cold-start tokens saved.
  const contByDate = new Map(continuityDaily.map((b) => [b._id, b]));
  const contSeries = dates.map((d) => contByDate.get(d) ?? { _id: d, tokens: 0, boots: 0 });
  const maxContTokens = Math.max(...contSeries.map((d) => d.tokens), 1);
  const contMonth = continuityMonth[0] ?? { tokens: 0, boots: 0 };
  const contAll = continuityAll[0] ?? { tokens: 0, boots: 0 };
  const contAvg = contMonth.boots > 0 ? Math.round(contMonth.tokens / contMonth.boots) : 0;

  // Cold start — today vs brain. Brain side = measured boot payloads served
  // this month; legacy side = measured file-read baseline stamped on those
  // boots, or the documented estimate until one is measured.
  const boot = bootCompare[0] ?? { boots: 0, tokens: 0, baselineTokens: 0, baselineBoots: 0 };
  const brainAvg = boot.boots > 0 ? Math.round(boot.tokens / boot.boots) : 0;
  const legacyMeasured = boot.baselineBoots > 0;
  const legacyAvg = legacyMeasured ? Math.round(boot.baselineTokens / boot.baselineBoots) : LEGACY_BOOT_EST_TOKENS;
  const bootSavedPct = brainAvg > 0 && legacyAvg > brainAvg ? Math.round(((legacyAvg - brainAvg) / legacyAvg) * 100) : 0;
  const bootMultiplier = brainAvg > 0 && legacyAvg > brainAvg ? Math.round(legacyAvg / brainAvg) : 0;
  const brainBarPct = legacyAvg > 0 && brainAvg > 0 ? Math.max((brainAvg / legacyAvg) * 100, 1.5) : 0;

  // Real token burn — the "what you burn" side of the hero panel.
  const burn = burnMonth[0] ?? { input: 0, output: 0, cacheCreate: 0, cacheRead: 0, cost: 0, calls: 0 };
  const burnTotal = burn.input + burn.output + burn.cacheCreate + burn.cacheRead;
  const burnRows = [
    { label: 'Cache read', value: burn.cacheRead, color: 'bg-amber-500/70', note: 'compiled context re-read every turn' },
    { label: 'Cache create', value: burn.cacheCreate, color: 'bg-orange-500/70', note: 'prompt written to cache' },
    { label: 'Input', value: burn.input, color: 'bg-sky-500/70', note: 'fresh prompt tokens' },
    { label: 'Output', value: burn.output, color: 'bg-fuchsia-500/70', note: 'tokens the model generated' },
  ];
  const rollingOutput = burnRolling[0]?.output ?? 0;
  const rollingPct = ROLLING_OUTPUT_BUDGET > 0 ? Math.min(100, Math.round((rollingOutput / ROLLING_OUTPUT_BUDGET) * 100)) : 0;
  const rollingColor = rollingPct >= 85 ? 'bg-red-500/70' : rollingPct >= 70 ? 'bg-yellow-500/70' : 'bg-emerald-500/70';

  // Runner activity.
  const resolved = doneTotal + blockedTotal;
  const successRate = resolved > 0 ? Math.round((doneTotal / resolved) * 100) : 100;
  const totalRuns = schedules.reduce((s, x) => s + (x.runCount ?? 0), 0);
  const totalErrs = schedules.reduce((s, x) => s + (x.errorCount ?? 0), 0);
  const runnerRate = totalRuns > 0 ? Math.round(((totalRuns - totalErrs) / totalRuns) * 100) : 100;

  // Activation funnel — distinct tenants per step, per-step conversion, and the
  // headline activation rate (activated ÷ signed up).
  const actByStep = new Map(activationRows.map((r) => [r._id, r.tenants]));
  const actSignups = actByStep.get('signup') ?? 0;
  let actPrev = actSignups;
  const funnel = ACTIVATION_STEPS.map((s, i) => {
    const tenants = actByStep.get(s.step) ?? 0;
    const pctOfSignup = actSignups > 0 ? Math.round((tenants / actSignups) * 100) : 0;
    const stepConversion = i === 0 ? 100 : actPrev > 0 ? Math.round((tenants / actPrev) * 100) : 0;
    actPrev = tenants;
    return { ...s, tenants, pctOfSignup, stepConversion };
  });
  const actActivated = actByStep.get('wrapup_merge') ?? 0;
  const activationRate = actSignups > 0 ? Math.round((actActivated / actSignups) * 100) : 0;
  const funnelHasData = funnel.some((f) => f.tenants > 0);

  // Self-serve conversion — signup → init → first task shipped → retained.
  const ssByStep = new Map(selfServeEventRows.map((r) => [r._id, r.tenants]));
  const ssSignups = ssByStep.get('signup') ?? 0;
  const ssRetained = selfServeRetainedRows[0]?.tenants ?? 0;
  const ssRaw: Record<string, number> = {
    signup: ssSignups,
    init: ssByStep.get('init') ?? 0,
    first_value: ssByStep.get('first_ship') ?? 0,
    retained: ssRetained,
  };
  let ssPrev = ssSignups;
  const selfServeFunnel = SELF_SERVE_STEPS.map((s, i) => {
    const tenants = ssRaw[s.key];
    const pctOfSignup = ssSignups > 0 ? Math.round((tenants / ssSignups) * 100) : 0;
    const stepConversion = i === 0 ? 100 : ssPrev > 0 ? Math.round((tenants / ssPrev) * 100) : 0;
    ssPrev = tenants;
    return { ...s, tenants, pctOfSignup, stepConversion };
  });
  const conversionRate = ssSignups > 0 ? Math.round((ssRetained / ssSignups) * 100) : 0;
  const selfServeHasData = selfServeFunnel.some((f) => f.tenants > 0);

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={30} />
      <PageHeader
        title="Analytics"
        subtitle="Throughput, plan progress, runner activity, cost trend, and cold-start tokens saved across the fleet."
      />

      {/* ── Token economics — what you burn vs what the brain saves (front & centre) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* What you burn */}
        <Card
          title="What you burn"
          meta={burnTotal > 0 ? `${fmtTokens(burnTotal)} tok · ${fmtUsd(burn.cost)} · ${burn.calls} calls (month)` : 'no metered spend yet'}
          accent="amber"
        >
          <div className="p-5 space-y-4">
            <p className="text-xs text-zinc-500">
              Real token burn metered from every gateway call this month.{' '}
              <span className="text-amber-400">Cache-read dominates raw volume</span> — the compiled
              context re-read on every turn, billed at the cheap cached tier but enormous in count.
            </p>
            {burnTotal === 0 ? (
              <EmptyState>No metered spend yet this month — burn fills in as calls flow through the gateway.</EmptyState>
            ) : (
              <>
                <div className="flex h-3 w-full rounded overflow-hidden bg-zinc-950">
                  {burnRows.filter((r) => r.value > 0).map((r) => (
                    <div key={r.label} className={r.color} style={{ width: `${(r.value / burnTotal) * 100}%` }} title={`${r.label}: ${fmtTokens(r.value)}`} />
                  ))}
                </div>
                <div className="space-y-2">
                  {burnRows.map((r) => {
                    const pct = burnTotal > 0 ? (r.value / burnTotal) * 100 : 0;
                    return (
                      <div key={r.label} className="flex items-center gap-3 text-xs">
                        <span className={`w-2.5 h-2.5 rounded-sm ${r.color} shrink-0`} />
                        <span className="text-zinc-300 w-24">{r.label}</span>
                        <span className="font-mono text-zinc-400 w-16 text-right">{fmtTokens(r.value)}</span>
                        <span className="font-mono text-zinc-600 w-12 text-right">{pct < 10 ? pct.toFixed(1) : Math.round(pct)}%</span>
                        <span className="text-zinc-600 truncate hidden sm:block">{r.note}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="pt-3 border-t border-zinc-800">
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-zinc-400">Rolling {ROLLING_WINDOW_HOURS}h output vs budget</span>
                    <span className="font-mono text-zinc-300">{fmtTokens(rollingOutput)} / {fmtTokens(ROLLING_OUTPUT_BUDGET)} · {rollingPct}%</span>
                  </div>
                  <div className="h-2 bg-zinc-950 rounded-full overflow-hidden">
                    <div className={`h-full rounded-full ${rollingColor}`} style={{ width: `${Math.max(rollingPct, 1)}%` }} />
                  </div>
                </div>
              </>
            )}
          </div>
        </Card>

        {/* What the brain saves */}
        <Card
          title="What the brain saves"
          meta={boot.boots > 0 ? `${boot.boots} brain boots this month` : 'no brain boots yet'}
          accent="emerald"
        >
          <div className="p-5">
            <p className="text-xs text-zinc-500 mb-4">
              Every session start the brain serves a compiled <code className="text-zinc-400">context_boot</code> brief
              or <code className="text-zinc-400">brain_delta</code> diff instead of re-reading the full state files.
              Served vs the legacy file-boot baseline:
            </p>
            <div className="flex items-center gap-6">
              <div className="text-center shrink-0">
                <p className="text-5xl font-bold text-emerald-400">{bootSavedPct > 0 ? `${bootSavedPct}%` : '—'}</p>
                <p className="text-xs text-zinc-500 mt-1">fewer tokens per boot</p>
                {bootMultiplier > 1 && <p className="text-xs text-zinc-600 mt-1 font-mono">×{bootMultiplier} cheaper</p>}
              </div>
              <div className="flex-1 space-y-3">
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-400">Legacy file-boot</span>
                    <span className="font-mono text-zinc-300">~{fmtTokens(legacyAvg)}{legacyMeasured ? '' : ' est.'}</span>
                  </div>
                  <div className="h-4 bg-zinc-950 rounded overflow-hidden"><div className="h-full rounded bg-zinc-600" style={{ width: '100%' }} /></div>
                </div>
                <div>
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-zinc-400">Brain-delta boot</span>
                    <span className="font-mono text-emerald-400">{brainAvg > 0 ? `~${fmtTokens(brainAvg)}` : '—'}</span>
                  </div>
                  <div className="h-4 bg-zinc-950 rounded overflow-hidden"><div className="h-full rounded bg-gradient-to-r from-teal-500/80 to-emerald-400/80" style={{ width: `${brainBarPct}%` }} /></div>
                </div>
              </div>
            </div>
            <div className="pt-3 mt-4 border-t border-zinc-800 flex items-center justify-between text-xs">
              <span className="text-zinc-400">Cold-start tokens saved</span>
              <span className="font-mono text-emerald-400">{fmtTokens(contMonth.tokens)} this month · {fmtTokens(contAll.tokens)} all-time</span>
            </div>
          </div>
        </Card>
      </div>

      {/* Headline stats */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <StatCard label={`Tasks done (${N}d)`} value={tputTotal} sub={`~${tputAvg.toFixed(1)}/day`} accent="green" />
        <StatCard label="Task success rate" value={`${successRate}%`} sub={`${doneTotal} done · ${blockedTotal} blocked`} accent={successRate >= 90 ? 'green' : 'yellow'} />
        <StatCard label="Runner success" value={`${runnerRate}%`} sub={`${totalRuns} runs · ${totalErrs} err`} accent={runnerRate >= 90 ? 'green' : 'yellow'} />
        <StatCard label={`Spend (${N}d)`} value={fmtUsd(spendTotal)} sub={`${workingNow} working now`} accent="blue" />
        <StatCard label="Tokens saved (month)" value={fmtTokens(contMonth.tokens)} sub={`${contMonth.boots} boots · ${fmtTokens(contAll.tokens)} all-time`} accent="green" />
      </div>

      {/* Task throughput */}
      <div className="mb-8">
        <Card title="Task throughput" meta={`${tputTotal} completed over ${N} days`} accent="emerald">
          <div className="p-5">
            <div className="flex items-end gap-1 h-40">
              {tputSeries.map((d) => {
                const h = (d.count / maxTput) * 100;
                const isToday = d.date === dates[dates.length - 1];
                return (
                  <div key={d.date} className="flex-1 flex flex-col items-center gap-1 group">
                    <span className="text-[10px] font-mono text-zinc-500 group-hover:text-zinc-300">{d.count > 0 ? d.count : ''}</span>
                    <div className="w-full flex items-end justify-center" style={{ height: '110px' }}>
                      <div
                        className={`w-full rounded-t ${isToday ? 'bg-teal-400/70' : 'bg-teal-600/40'} group-hover:bg-teal-400/70 transition-colors`}
                        style={{ height: `${Math.max(h, d.count > 0 ? 4 : 0)}%` }}
                      />
                    </div>
                    <span className={`text-[9px] font-mono ${isToday ? 'text-teal-400' : 'text-zinc-600'}`}>{d.date.slice(5)}</span>
                  </div>
                );
              })}
            </div>
            {tputTotal === 0 && <p className="mt-3 text-xs text-zinc-600 text-center">No tasks completed in the last {N} days.</p>}
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-8">
        {/* Plan progress per repo */}
        <Card title="Plan progress per repo" meta={`${planRepos.length} repos planned`}>
          <div className="p-5 space-y-3 max-h-[26rem] overflow-y-auto">
            {planRepos.length === 0 ? (
              <EmptyState>No 10-day plans yet. Set one with <code className="text-zinc-400">schedule plan</code>.</EmptyState>
            ) : (
              planRepos.map(([repo, { done, total }]) => {
                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                return (
                  <div key={repo}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="font-mono text-zinc-300 truncate">{repo}</span>
                      <span className="text-zinc-500">{done}/{total} · {pct}%</span>
                    </div>
                    <div className="h-2 bg-zinc-950 rounded-full overflow-hidden">
                      <div className="h-full rounded-full bg-gradient-to-r from-teal-500/70 to-emerald-400/70" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </Card>

        {/* Runner activity */}
        <Card title="Runner activity" meta={`${schedules.filter((s) => s.enabled).length} schedules enabled`} accent="blue">
          <div className="p-5 space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider">Sessions</p>
                <p className="text-2xl font-bold text-zinc-100 mt-1">{sessionTotal}</p>
                <p className="text-xs text-zinc-500 mt-1">{sessionClosed} closed</p>
              </div>
              <div className="rounded-lg bg-zinc-950/60 border border-zinc-800 p-3">
                <p className="text-[11px] text-zinc-500 uppercase tracking-wider">Schedule runs</p>
                <p className="text-2xl font-bold text-zinc-100 mt-1">{totalRuns}</p>
                <p className="text-xs text-zinc-500 mt-1">{totalErrs} errors</p>
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-zinc-400">Runner success rate</span>
                <span className="text-zinc-300">{runnerRate}%</span>
              </div>
              <div className="h-2 bg-zinc-950 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${runnerRate >= 90 ? 'bg-emerald-400/70' : 'bg-yellow-400/70'}`} style={{ width: `${runnerRate}%` }} />
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="text-zinc-400">Task success rate</span>
                <span className="text-zinc-300">{successRate}%</span>
              </div>
              <div className="h-2 bg-zinc-950 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${successRate >= 90 ? 'bg-emerald-400/70' : 'bg-yellow-400/70'}`} style={{ width: `${successRate}%` }} />
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Cost / budget trend */}
      <Card title="Cost / budget trend" meta={`${fmtUsd(spendTotal)} over ${N} days`} accent="blue">
        <div className="p-5 space-y-1">
          {spendSeries.map((d) => {
            const w = (d.cost / maxSpend) * 100;
            const isToday = d._id === dates[dates.length - 1];
            return (
              <div key={d._id} className="flex items-center gap-3 text-xs font-mono">
                <span className={`w-14 text-right ${isToday ? 'text-teal-400' : 'text-zinc-500'}`}>{d._id.slice(5)}</span>
                <div className="flex-1 h-4 bg-zinc-950 rounded overflow-hidden relative">
                  <div className={`absolute left-0 top-0 h-full rounded ${isToday ? 'bg-teal-400/60' : 'bg-zinc-600'}`} style={{ width: `${w}%` }} />
                </div>
                <span className={`w-16 text-right ${d.cost > 0 ? 'text-zinc-300' : 'text-zinc-700'}`}>{d.cost > 0 ? fmtUsd(d.cost) : '—'}</span>
                <span className="w-10 text-right text-zinc-600">{d.calls > 0 ? d.calls : ''}</span>
              </div>
            );
          })}
          {spendTotal === 0 && <p className="mt-3 text-xs text-zinc-600 text-center">No spend recorded in the last {N} days.</p>}
        </div>
      </Card>

      {/* Cold start — today vs brain (B7: the continuity demo number) */}
      <div className="mt-8">
        <Card
          title="Cold start — today vs brain"
          meta={boot.boots > 0
            ? `${boot.boots} brain boots this month · ${bootSavedPct}% fewer tokens per session start`
            : 'no brain boots yet this month'}
          accent="emerald"
        >
          <div className="p-5">
            <p className="text-xs text-zinc-500 mb-5">
              Tokens-to-productive per session start. The legacy path re-reads the full state files every boot
              (CLAUDE.md, STATE.md, handoff, rules); the brain path serves a compiled <code className="text-zinc-400">context_boot</code> brief
              or <code className="text-zinc-400">brain_delta</code> diff instead.{' '}
              {legacyMeasured
                ? 'Legacy bar is measured from live file sizes at serve time.'
                : 'Legacy bar is the documented ~60k estimate until a measured baseline lands.'}
            </p>
            <div className="flex flex-col lg:flex-row lg:items-center gap-6">
              <div className="flex-1 space-y-4">
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-zinc-400">Today — legacy file-read boot</span>
                    <span className="font-mono text-zinc-300">
                      ~{fmtTokens(legacyAvg)}{legacyMeasured ? '' : ' est.'}
                    </span>
                  </div>
                  <div className="h-5 bg-zinc-950 rounded overflow-hidden">
                    <div className="h-full rounded bg-zinc-600" style={{ width: '100%' }} />
                  </div>
                </div>
                <div>
                  <div className="flex items-center justify-between text-xs mb-1">
                    <span className="text-zinc-400">Brain — context_boot / brain_delta</span>
                    <span className="font-mono text-emerald-400">
                      {brainAvg > 0 ? `~${fmtTokens(brainAvg)}` : '—'}
                    </span>
                  </div>
                  <div className="h-5 bg-zinc-950 rounded overflow-hidden">
                    <div className="h-full rounded bg-gradient-to-r from-teal-500/80 to-emerald-400/80" style={{ width: `${brainBarPct}%` }} />
                  </div>
                </div>
              </div>
              <div className="lg:w-48 text-center lg:text-right shrink-0">
                {bootMultiplier > 1 ? (
                  <>
                    <p className="text-4xl font-bold text-emerald-400">×{bootMultiplier}</p>
                    <p className="text-xs text-zinc-500 mt-1">cheaper per session start</p>
                    <p className="text-xs text-zinc-600 mt-2 font-mono">−{fmtTokens(legacyAvg - brainAvg)}/boot</p>
                  </>
                ) : (
                  <p className="text-xs text-zinc-600">The comparison fills in as agents boot via the gateway brain path.</p>
                )}
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Activation funnel — signup → continuity aha (product analytics) */}
      <div className="mt-8">
        <Card
          title="Activation funnel"
          meta={funnelHasData
            ? `${actSignups} signed up · ${actActivated} activated · ${activationRate}% activation rate`
            : 'no activation events yet'}
          accent="emerald"
        >
          <div className="p-5">
            <p className="text-xs text-zinc-500 mb-5">
              The onboarding funnel, first-touch per tenant: <code className="text-zinc-400">signup → init → first brain boot → first brain delta → continuity aha</code>.
              Privacy-respecting — no third-party tracker; every step is derived from data already flowing through the gateway.
              Bars show the share of signed-up tenants that reached each step.
            </p>
            {!funnelHasData ? (
              <p className="text-xs text-zinc-600 text-center py-6">
                The funnel fills in as tenants sign up and progress through onboarding.
              </p>
            ) : (
              <div className="space-y-3">
                {funnel.map((f, i) => (
                  <div key={f.step}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-zinc-300">{f.label}</span>
                      <span className="font-mono text-zinc-500">
                        {f.tenants} {f.tenants === 1 ? 'tenant' : 'tenants'} · {f.pctOfSignup}%
                        {i > 0 && <span className="text-zinc-600"> · {f.stepConversion}% step conv.</span>}
                      </span>
                    </div>
                    <div className="h-4 bg-zinc-950 rounded overflow-hidden">
                      <div
                        className={`h-full rounded ${i === funnel.length - 1 ? 'bg-gradient-to-r from-teal-500/80 to-emerald-400/80' : 'bg-teal-600/50'}`}
                        style={{ width: `${Math.max(f.pctOfSignup, f.tenants > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
                <div className="pt-3 mt-1 border-t border-zinc-800 flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Activation rate (reached continuity aha)</span>
                  <span className="text-2xl font-bold text-emerald-400">{activationRate}%</span>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Self-serve conversion — signup → first value → retained (sellable-product view) */}
      <div className="mt-8">
        <Card
          title="Self-serve conversion"
          meta={selfServeHasData
            ? `${ssSignups} signed up · ${ssRetained} retained · ${conversionRate}% conversion rate`
            : 'no conversion events yet'}
          accent="blue"
        >
          <div className="p-5">
            <p className="text-xs text-zinc-500 mb-5">
              The plain sellable-product question, distinct from the continuity-aha funnel above:
              <code className="text-zinc-400"> signup → init → first task shipped → retained (2nd task shipped)</code>.
              This is how self-serve onboarding conversion is tracked — did a signup get real product value, and did they come back for more?
            </p>
            {!selfServeHasData ? (
              <p className="text-xs text-zinc-600 text-center py-6">
                Fills in as signups connect a project and ship tasks.
              </p>
            ) : (
              <div className="space-y-3">
                {selfServeFunnel.map((f, i) => (
                  <div key={f.key}>
                    <div className="flex items-center justify-between text-xs mb-1">
                      <span className="text-zinc-300">{f.label}</span>
                      <span className="font-mono text-zinc-500">
                        {f.tenants} {f.tenants === 1 ? 'tenant' : 'tenants'} · {f.pctOfSignup}%
                        {i > 0 && <span className="text-zinc-600"> · {f.stepConversion}% step conv.</span>}
                      </span>
                    </div>
                    <div className="h-4 bg-zinc-950 rounded overflow-hidden">
                      <div
                        className={`h-full rounded ${i === selfServeFunnel.length - 1 ? 'bg-gradient-to-r from-teal-500/80 to-cyan-400/80' : 'bg-teal-600/50'}`}
                        style={{ width: `${Math.max(f.pctOfSignup, f.tenants > 0 ? 2 : 0)}%` }}
                      />
                    </div>
                  </div>
                ))}
                <div className="pt-3 mt-1 border-t border-zinc-800 flex items-center justify-between">
                  <span className="text-xs text-zinc-400">Conversion rate (retained ÷ signed up)</span>
                  <span className="text-2xl font-bold text-teal-400">{conversionRate}%</span>
                </div>
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Continuity meter — cold-start tokens saved */}
      <div className="mt-8">
        <Card title="Continuity — cold-start tokens saved" meta={`${fmtTokens(contMonth.tokens)} this month · ${contMonth.boots} boots · ~${fmtTokens(contAvg)}/boot`} accent="emerald">
          <div className="p-5">
            <p className="text-xs text-zinc-500 mb-4">
              Every <code className="text-zinc-400">context_boot</code> / <code className="text-zinc-400">memory_context</code> block the gateway serves is context an agent did not have to be re-taught by hand. Bars show tokens served per day ({N}d).
            </p>
            <div className="flex items-end gap-1 h-32">
              {contSeries.map((d) => {
                const h = (d.tokens / maxContTokens) * 100;
                const isToday = d._id === dates[dates.length - 1];
                return (
                  <div key={d._id} className="flex-1 flex flex-col items-center gap-1 group">
                    <span className="text-[10px] font-mono text-zinc-500 group-hover:text-zinc-300">{d.tokens > 0 ? fmtTokens(d.tokens) : ''}</span>
                    <div className="w-full flex items-end justify-center" style={{ height: '84px' }}>
                      <div
                        className={`w-full rounded-t ${isToday ? 'bg-emerald-400/70' : 'bg-emerald-600/40'} group-hover:bg-emerald-400/70 transition-colors`}
                        style={{ height: `${Math.max(h, d.tokens > 0 ? 4 : 0)}%` }}
                      />
                    </div>
                    <span className={`text-[9px] font-mono ${isToday ? 'text-emerald-400' : 'text-zinc-600'}`}>{d._id.slice(5)}</span>
                  </div>
                );
              })}
            </div>
            {contAll.tokens === 0 && <p className="mt-3 text-xs text-zinc-600 text-center">No context served yet — the meter fills as agents boot via the gateway.</p>}
          </div>
        </Card>
      </div>

      {/* Gateway performance — hot-path p95 latency + slow-query log (live, in-process) */}
      <div className="mt-8 grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card
          title="Gateway performance — hot-path latency"
          meta={perf ? `${perf.overall.count} calls · p95 ${perf.overall.p95Ms}ms · ${perf.overall.slow} slow` : 'gateway unreachable'}
          accent="blue"
        >
          <div className="p-5">
            <p className="text-xs text-zinc-500 mb-4">
              Every MCP tool call is timed at the gateway <code className="text-zinc-400">executeTool</code> chokepoint.
              Per-tool p95 / p99 over the recent sample window, slowest first. Resets on gateway restart.
            </p>
            {perfTools.length === 0 ? (
              <EmptyState>No calls metered yet — latency fills in as tools are invoked (needs a gateway rebuild to activate the meter).</EmptyState>
            ) : (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-zinc-600 pb-1 border-b border-zinc-800">
                  <span className="flex-1">Tool</span>
                  <span className="w-12 text-right">calls</span>
                  <span className="w-14 text-right">p95</span>
                  <span className="w-14 text-right">p99</span>
                  <span className="w-12 text-right">slow</span>
                </div>
                {perfTools.map((t) => (
                  <div key={t.tool} className="flex items-center gap-2 text-xs font-mono">
                    <span className="flex-1 truncate text-zinc-300">{t.tool}</span>
                    <span className="w-12 text-right text-zinc-500">{t.count}</span>
                    <span className={`w-14 text-right ${t.p95Ms >= slowThreshold ? 'text-amber-400' : 'text-zinc-300'}`}>{t.p95Ms}ms</span>
                    <span className="w-14 text-right text-zinc-500">{t.p99Ms}ms</span>
                    <span className={`w-12 text-right ${t.slow > 0 ? 'text-amber-400' : 'text-zinc-700'}`}>{t.slow}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <Card
          title="Slow-query log"
          meta={perf ? `≥ ${slowThreshold}ms · ${slowQueries.length} recent` : 'gateway unreachable'}
          accent="amber"
        >
          <div className="p-5">
            <p className="text-xs text-zinc-500 mb-4">
              The most recent tool calls at or over the slow threshold (<code className="text-zinc-400">MYAI_SLOW_QUERY_MS</code>, default 500ms), newest first.
            </p>
            {slowQueries.length === 0 ? (
              <EmptyState>No slow calls recorded — every metered call has been under {slowThreshold}ms.</EmptyState>
            ) : (
              <div className="space-y-1">
                {slowQueries.map((q, i) => (
                  <div key={`${q.tool}-${q.at}-${i}`} className="flex items-center gap-3 text-xs font-mono">
                    <span className={`w-14 text-right ${q.error ? 'text-red-400' : 'text-amber-400'}`}>{q.ms}ms</span>
                    <span className="flex-1 truncate text-zinc-300">{q.tool}{q.error && <span className="text-red-400"> ⚠</span>}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
