// /fleet — Fleet Morning Console.
// Renders the latest FleetRun (the morning "resume all" sweep) with live
// progress: an overall status pill, a summary strip, and a per-repo grid
// whose action dots tick over as the run advances. Read-only mirror of the
// gateway's FleetRun collection — the dashboard never writes it.

import { connectDB, FleetRun, Tenant } from '@/lib/db';
import { getActiveTenant, tenantFilter, DEFAULT_TENANT_ID } from '@/lib/tenant';
import { hasTeamFleetConsole, type TenantPlan } from '@/lib/billing';
import { planLabel } from '@/lib/hosted-brain';
import { latestRunPerMachine, type FleetRunSummary } from '@/lib/team-fleet';
import { timeAgo, fmtSydney } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { StatCard, EmptyState, Card } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';

export const dynamic = 'force-dynamic';

interface FleetRepo {
  repo: string;
  group?: string;
  overnight?: string;
  recommendation?: string;
  branch?: string;
  ahead?: number;
  uncommitted?: number;
  openPrs?: number;
  reviewTasks?: number;
  blockedTasks?: number;
  decision?: string;
  action?: string;
  actionStatus?: 'pending' | 'in-progress' | 'done' | 'failed' | 'skipped' | string;
  detail?: string;
  prUrl?: string;
  updatedAt?: string;
}

interface FleetSummary {
  total?: number;
  needsAction?: number;
  shipped?: number;
  failed?: number;
}

interface FleetRunDoc {
  runId: string;
  type?: string;
  status?: 'running' | 'completed' | 'aborted' | string;
  machine?: string;
  agent?: string;
  startedAt?: string;
  finishedAt?: string;
  repos?: FleetRepo[];
  summary?: FleetSummary;
  updatedAt?: string;
}

/* ── Status pill (overall run) ─────────────────────────────── */

function RunStatusPill({ status }: { status?: string }) {
  const s = (status ?? 'running').toLowerCase();
  if (s === 'completed') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-xs font-medium text-emerald-300">
        <span className="w-2 h-2 rounded-full bg-emerald-400" />
        completed
      </span>
    );
  }
  if (s === 'aborted') {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-500/15 border border-red-500/40 text-xs font-medium text-red-300">
        <span className="w-2 h-2 rounded-full bg-red-400" />
        aborted
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-amber-500/15 border border-amber-500/40 text-xs font-medium text-amber-300">
      <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
      running
    </span>
  );
}

/* ── Recommendation chip ───────────────────────────────────── */

const RECOMMENDATION: Record<string, string> = {
  ship: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  merge: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  review: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  fix: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  'wrap-up': 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  attention: 'bg-red-500/15 text-red-400 border-red-500/30',
  idle: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/30',
};

function RecommendationChip({ value }: { value?: string }) {
  if (!value) return <Badge className={RECOMMENDATION.idle}>idle</Badge>;
  return <Badge className={RECOMMENDATION[value] ?? RECOMMENDATION.idle}>{value}</Badge>;
}

/* ── Action status dot ─────────────────────────────────────── */

function ActionStatus({ status }: { status?: string }) {
  const s = (status ?? 'pending').toLowerCase();
  if (s === 'in-progress') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-blue-300">
        <span className="w-2.5 h-2.5 rounded-full bg-blue-400 animate-pulse" />
        in progress
      </span>
    );
  }
  if (s === 'done') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-emerald-400">
        <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 flex items-center justify-center text-[8px] text-zinc-950 font-bold leading-none">✓</span>
        done
      </span>
    );
  }
  if (s === 'failed') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-red-400">
        <span className="w-2.5 h-2.5 rounded-full bg-red-400 flex items-center justify-center text-[8px] text-zinc-950 font-bold leading-none">✕</span>
        failed
      </span>
    );
  }
  if (s === 'skipped') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-zinc-600">
        <span className="w-2.5 h-2.5 rounded-full bg-zinc-700" />
        skipped
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
      <span className="w-2.5 h-2.5 rounded-full bg-zinc-600" />
      pending
    </span>
  );
}

/* ── Small metadata badge ──────────────────────────────────── */

function MetaBadge({ label, value, accent }: { label: string; value?: number; accent?: 'red' | 'amber' }) {
  if (value === undefined || value === null) return null;
  const tone =
    value > 0 && accent === 'red' ? 'text-red-400' :
    value > 0 && accent === 'amber' ? 'text-amber-400' :
    value > 0 ? 'text-zinc-300' : 'text-zinc-600';
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-mono">
      <span className="text-zinc-600 uppercase tracking-wider">{label}</span>
      <span className={tone}>{value}</span>
    </span>
  );
}

/* ── Team Activity (Team-tier only) ────────────────────────── */
// The grid above only ever shows the single latest FleetRun — fine for a
// single-seat tenant, but a shared Team tenant can have several teammates on
// several machines sweeping at once. This panel is the thing that actually
// justifies the Team seat price: "who on my team is doing what, right now,
// across every machine on our shared tenant" (GO_LIVE_PLAN "team fleet
// console"). Gated behind the Team plan; local/self-hosted tenants are never
// billed so they always see it (ADR-010 — never paywall the local operator).

function TeamActivityRow({ run }: { run: FleetRunSummary }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2 px-3 border-b border-zinc-800/60 last:border-b-0">
      <div className="min-w-0 flex items-center gap-3">
        <RunStatusPill status={run.status} />
        <div className="min-w-0">
          <p className="text-sm font-mono text-zinc-200 truncate">{run.machine || 'unknown machine'}</p>
          <p className="text-[10px] text-zinc-600">{run.agent || 'agent unknown'} · {timeAgo(run.startedAt)}</p>
        </div>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <MetaBadge label="repos" value={run.summary?.total} />
        <MetaBadge label="needs" value={run.summary?.needsAction} accent="amber" />
        <MetaBadge label="failed" value={run.summary?.failed} accent="red" />
      </div>
    </div>
  );
}

function TeamActivityUpsell({ plan }: { plan: TenantPlan }) {
  return (
    <Card>
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <p className="text-sm text-zinc-200">See every teammate&apos;s sweep, on every machine, live.</p>
          <p className="text-xs text-zinc-500 mt-1">
            Team Activity is a {planLabel('team')} feature — you&apos;re currently on {planLabel(plan)}.
          </p>
        </div>
        <a
          href="/pricing"
          className="shrink-0 gel-brand px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition whitespace-nowrap text-center"
        >
          Upgrade to Team
        </a>
      </div>
    </Card>
  );
}

async function TeamActivity({ tenantId }: { tenantId: string }) {
  const isLocalTenant = tenantId === DEFAULT_TENANT_ID;

  let plan: TenantPlan = 'free';
  if (!isLocalTenant) {
    try {
      const tenant = await Tenant.findOne({ tenantId }, { plan: 1 }).lean<{ plan?: TenantPlan } | null>();
      plan = tenant?.plan ?? 'free';
    } catch {
      plan = 'free';
    }
  }

  // Local/self-hosted tenants are never billed — never paywall them (tenant.ts
  // standing requirement). Real hosted tenants need the Team plan (or above).
  if (!isLocalTenant && !hasTeamFleetConsole(plan)) {
    return <TeamActivityUpsell plan={plan} />;
  }

  let runs: FleetRunSummary[] = [];
  try {
    const tf = tenantFilter(tenantId);
    runs = JSON.parse(JSON.stringify(
      await FleetRun.find({ ...tf }, { runId: 1, machine: 1, agent: 1, status: 1, startedAt: 1, finishedAt: 1, summary: 1 })
        .sort({ startedAt: -1 })
        .limit(20)
        .lean(),
    )) as FleetRunSummary[];
  } catch {
    runs = [];
  }

  const byMachine = latestRunPerMachine(runs);

  return (
    <Card>
      {byMachine.length === 0 ? (
        <EmptyState>No fleet runs yet across your team&apos;s machines.</EmptyState>
      ) : (
        <div>
          {byMachine.map((r) => <TeamActivityRow key={r.runId} run={r} />)}
        </div>
      )}
    </Card>
  );
}

/* ── Page ───────────────────────────────────────────────────── */

export default async function FleetPage() {
  const tenantId = await getActiveTenant();
  let run: FleetRunDoc | null = null;
  let dbError = false;
  try {
    await connectDB();
    const tf = tenantFilter(tenantId);
    run = JSON.parse(JSON.stringify(
      await FleetRun.findOne({ ...tf }).sort({ startedAt: -1 }).limit(1).lean(),
    )) as FleetRunDoc | null;
  } catch {
    dbError = true;
  }

  const repos = run?.repos ?? [];

  // Prefer the gateway-computed summary; fall back to deriving from repos[].
  const total = run?.summary?.total ?? repos.length;
  const needsAction = run?.summary?.needsAction ??
    repos.filter((r) => ['ship', 'merge', 'fix', 'review', 'attention'].includes((r.recommendation ?? '').toLowerCase())).length;
  const shipped = run?.summary?.shipped ??
    repos.filter((r) => (r.actionStatus ?? '').toLowerCase() === 'done').length;
  const failed = run?.summary?.failed ??
    repos.filter((r) => (r.actionStatus ?? '').toLowerCase() === 'failed').length;

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={4} />
      <PageHeader
        title="Fleet Morning Console"
        subtitle="The morning sweep across every repo — overnight state, the recommended move, and live progress as you action each one."
      >
        {run && <RunStatusPill status={run.status} />}
      </PageHeader>

      {dbError && (
        <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-sm text-red-400 mb-6">
          Database not reachable — the fleet console needs the gateway Mongo at :27200.
        </div>
      )}

      {!run && !dbError && (
        <Card>
          <EmptyState>
            No fleet run yet — kick one off with <code className="text-emerald-400">agent mode -resume all</code>.
            The morning sweep populates this console live as it walks each repo.
          </EmptyState>
        </Card>
      )}

      {run && (
        <div className="space-y-6">
          {/* Run header */}
          <div className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 flex flex-wrap items-center gap-x-6 gap-y-2">
            <div>
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Run</p>
              <p className="text-sm font-mono text-zinc-100">{run.runId}</p>
            </div>
            <div>
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Started</p>
              <p className="text-sm text-zinc-200">
                {timeAgo(run.startedAt)}
                <span className="text-zinc-600 ml-2 text-xs">{fmtSydney(run.startedAt, 'full')}</span>
              </p>
            </div>
            {run.finishedAt && (
              <div>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Finished</p>
                <p className="text-sm text-zinc-200">
                  {timeAgo(run.finishedAt)}
                  <span className="text-zinc-600 ml-2 text-xs">{fmtSydney(run.finishedAt, 'full')}</span>
                </p>
              </div>
            )}
            <div>
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Machine</p>
              <p className="text-sm font-mono text-zinc-300">{run.machine || '—'}</p>
            </div>
            <div>
              <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Agent</p>
              <p className="text-sm text-zinc-300">{run.agent || '—'}</p>
            </div>
            {run.type && (
              <div>
                <p className="text-[10px] text-zinc-600 uppercase tracking-wider">Type</p>
                <p className="text-sm font-mono text-zinc-400">{run.type}</p>
              </div>
            )}
          </div>

          {/* Summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Repos" value={total} />
            <StatCard label="Needs action" value={needsAction} accent={needsAction > 0 ? 'yellow' : 'gray'} />
            <StatCard label="Shipped" value={shipped} accent={shipped > 0 ? 'green' : 'gray'} />
            <StatCard label="Failed" value={failed} accent={failed > 0 ? 'red' : 'gray'} />
          </div>

          {/* Team Activity */}
          <div>
            <h2 className="text-xs font-semibold text-zinc-500 mb-3 uppercase tracking-wider">Team Activity</h2>
            <TeamActivity tenantId={tenantId} />
          </div>

          {/* Repo grid */}
          {repos.length === 0 ? (
            <Card>
              <EmptyState>This run has no repos yet — the sweep is still gathering state.</EmptyState>
            </Card>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {repos.map((r) => (
                <div key={r.repo} className="gel-surface bg-zinc-900/70 border border-zinc-800 rounded-xl p-4 flex flex-col gap-3 hover:border-zinc-700 transition-colors">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-semibold text-sm text-zinc-100 font-mono truncate">{r.repo}</p>
                      {r.group && <p className="text-[10px] text-zinc-600 uppercase tracking-wider mt-0.5">{r.group}</p>}
                    </div>
                    <RecommendationChip value={r.recommendation} />
                  </div>

                  <p className="text-xs text-zinc-400 line-clamp-3 min-h-[1rem]">{r.overnight || 'No overnight summary.'}</p>

                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-zinc-800/70 pt-2">
                    {r.branch && (
                      <span className="inline-flex items-center gap-1 text-[10px] font-mono">
                        <span className="text-zinc-600 uppercase tracking-wider">branch</span>
                        <span className="text-zinc-300">{r.branch}</span>
                      </span>
                    )}
                    <MetaBadge label="ahead" value={r.ahead} accent="amber" />
                    <MetaBadge label="uncommit" value={r.uncommitted} accent="amber" />
                    <MetaBadge label="prs" value={r.openPrs} />
                    <MetaBadge label="review" value={r.reviewTasks} accent="amber" />
                    <MetaBadge label="blocked" value={r.blockedTasks} accent="red" />
                  </div>

                  <div className="flex items-center justify-between border-t border-zinc-800/70 pt-2">
                    <ActionStatus status={r.actionStatus} />
                    <div className="flex items-center gap-2">
                      {r.action && <span className="text-[10px] font-mono text-zinc-500 uppercase tracking-wider">{r.action}</span>}
                      {r.prUrl && (
                        <a href={r.prUrl} target="_blank" rel="noreferrer" className="text-[11px] text-emerald-400/90 hover:text-emerald-300 underline decoration-zinc-700">
                          PR
                        </a>
                      )}
                    </div>
                  </div>

                  {(r.detail || r.decision) && (
                    <div className="border-t border-zinc-800/70 pt-2 space-y-1">
                      {r.decision && (
                        <p className="text-[10px] text-zinc-500">
                          <span className="text-zinc-600 uppercase tracking-wider">decision</span>{' '}
                          <span className="text-zinc-300">{r.decision}</span>
                        </p>
                      )}
                      {r.detail && <p className="text-xs text-zinc-400 line-clamp-3">{r.detail}</p>}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
