// /fleet — Fleet Morning Console.
// Renders the latest FleetRun (the morning "resume all" sweep) with live
// progress: an overall status pill, a summary strip, and a per-repo grid
// whose action dots tick over as the run advances. This page only reads
// type:'morning-resume-all' runs — /api/projects also writes type:'task-fanout'
// runs to the same collection (ADR-015 §3), explicitly excluded below so a
// batch dispatch never hijacks this console's "latest run".
//
// D5 / DESIGN_LANGUAGE §5 (plan day 6, 2026-09-18): this page now follows the
// homepage contract instead of the console it was — a one-line ANSWER in the
// header ("Swept 20 repos on office-mac 51d ago. 6 need your decision and 1
// shipped."), state tiles with tinted glyphs before any detail, sentence-case
// facts ("13 ahead · 8 uncommitted · 3 blocked") in place of UPPERCASE MONO
// key/value strips, and design tokens in place of hard-coded zinc greys. Same
// queries, same data, same 4-second live refresh.

import { connectDB, FleetRun, Tenant } from '@/lib/db';
import { getActiveTenant, tenantFilter, DEFAULT_TENANT_ID } from '@/lib/tenant';
import { hasTeamFleetConsole, type TenantPlan } from '@/lib/billing';
import { planLabel } from '@/lib/hosted-brain';
import { latestRunPerMachine, type FleetRunSummary } from '@/lib/team-fleet';
import { timeAgo, fmtSydney } from '@/lib/format';
import { plural, verb, joinClauses, cap } from '@/lib/summary';
import { StatCard, EmptyState, Card } from '@/components/ui/card';
import { SectionHead } from '@/components/ui/section-head';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import { RecommendationChip, ActionStatus } from '@/components/fleet-status-chips';
import { dbUnreachableHint } from '@/lib/db-hint';

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
      <span className="inline-flex min-h-tap items-center gap-1.5 rounded-full bg-[rgb(var(--ok))]/15 px-3 text-label font-medium text-[rgb(var(--ok))]">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--ok))]" />
        Completed
      </span>
    );
  }
  if (s === 'aborted') {
    return (
      <span className="inline-flex min-h-tap items-center gap-1.5 rounded-full bg-[rgb(var(--err))]/15 px-3 text-label font-medium text-[rgb(var(--err))]">
        <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[rgb(var(--err))]" />
        Aborted
      </span>
    );
  }
  return (
    <span className="inline-flex min-h-tap items-center gap-1.5 rounded-full bg-[rgb(var(--accent))]/15 px-3 text-label font-medium text-[rgb(var(--accent))]">
      <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-[rgb(var(--accent))]" />
      Running
    </span>
  );
}

/* ── The one-line answer (§5.1) ────────────────────────────── */

function fleetSummary(
  run: FleetRunDoc | null,
  counts: { total: number; needsAction: number; shipped: number; failed: number },
  dbError: boolean,
): string {
  if (dbError) return 'The fleet console cannot reach the database right now.';
  if (!run) return 'No morning sweep has run yet.';
  const machine = run.machine || 'an unknown machine';
  const status = (run.status ?? 'running').toLowerCase();
  // `timeAgo` yields '—' for a missing/invalid date, which would read
  // "started —." — so the clause is dropped entirely when there is no date.
  const when = run.startedAt ? timeAgo(run.startedAt) : '';
  const head =
    status === 'running'
      ? `Sweeping ${plural(counts.total, 'repo')} on ${machine}${when ? `, started ${when}` : ''}.`
      : `Swept ${plural(counts.total, 'repo')} on ${machine}${when ? ` ${when}` : ''}.`;
  // "Nothing needs your decision" is only true when nothing FAILED either:
  // needsAction comes from `recommendation`, failed from `actionStatus` — two
  // independent fields, so a run can have 0 of the first and 3 of the second.
  // Saying "nothing needs your decision" above a red "Failed 3" tile is a lie.
  const quiet = counts.needsAction === 0 && counts.failed === 0;
  const tail = joinClauses([
    counts.needsAction > 0
      ? `${plural(counts.needsAction, 'repo')} ${verb(counts.needsAction, 'needs', 'need')} your decision`
      : quiet ? 'nothing needs your decision' : '',
    counts.shipped > 0 && `${counts.shipped} shipped`,
    counts.failed > 0 && `${plural(counts.failed, 'repo')} failed and ${verb(counts.failed, 'needs', 'need')} you`,
  ]);
  const aborted = status === 'aborted' ? ' The run was aborted before it finished.' : '';
  return `${head} ${cap(tail)}.${aborted}`;
}

/** The qualifier under the answer — run identity and timing, dim and small. */
function fleetQualifier(run: FleetRunDoc): string {
  return [
    run.type ?? 'morning sweep',
    run.runId,
    run.agent,
    run.startedAt && `started ${fmtSydney(run.startedAt, 'full')}`,
    run.finishedAt && `finished ${fmtSydney(run.finishedAt, 'full')}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/* ── Sentence-case facts ("13 ahead · 8 uncommitted · 3 blocked") ── */

function Fact({ children, tone }: { children: React.ReactNode; tone?: 'warn' | 'err' }) {
  const color =
    tone === 'err' ? 'text-[rgb(var(--err))]' : tone === 'warn' ? 'text-[rgb(var(--warn))]' : 'text-[rgb(var(--text-secondary))]';
  return <span className={`${color} whitespace-nowrap`}>{children}</span>;
}

function FactList({ children }: { children: React.ReactNode[] }) {
  const items = children.filter(Boolean);
  if (items.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta">
      {items.map((item, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 && <span aria-hidden="true" className="text-[rgb(var(--text-muted))]">·</span>}
          {item}
        </span>
      ))}
    </p>
  );
}

function RepoFacts({ r }: { r: FleetRepo }) {
  return (
    <FactList>
      {r.branch ? <Fact>on <span className="font-mono">{r.branch}</span></Fact> : null}
      {(r.ahead ?? 0) > 0 ? <Fact tone="warn">{r.ahead} ahead</Fact> : null}
      {(r.uncommitted ?? 0) > 0 ? <Fact tone="warn">{r.uncommitted} uncommitted</Fact> : null}
      {(r.openPrs ?? 0) > 0 ? <Fact>{plural(r.openPrs ?? 0, 'open PR')}</Fact> : null}
      {(r.reviewTasks ?? 0) > 0 ? <Fact tone="warn">{r.reviewTasks} to review</Fact> : null}
      {(r.blockedTasks ?? 0) > 0 ? <Fact tone="err">{r.blockedTasks} blocked</Fact> : null}
    </FactList>
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
  const s = run.summary ?? {};
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[rgb(var(--border-subtle))]/60 px-4 py-3 last:border-b-0">
      <div className="flex min-w-0 items-center gap-3">
        <RunStatusPill status={run.status} />
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-[rgb(var(--text-primary))]">{run.machine || 'Unknown machine'}</p>
          <p className="text-meta text-[rgb(var(--text-secondary))]">
            {run.agent || 'agent unknown'} · {timeAgo(run.startedAt)}
          </p>
        </div>
      </div>
      <FactList>
        {s.total != null ? <Fact>{plural(s.total, 'repo')}</Fact> : null}
        {(s.needsAction ?? 0) > 0 ? <Fact tone="warn">{s.needsAction} need you</Fact> : null}
        {(s.failed ?? 0) > 0 ? <Fact tone="err">{s.failed} failed</Fact> : null}
      </FactList>
    </div>
  );
}

function TeamActivityUpsell({ plan }: { plan: TenantPlan }) {
  return (
    <Card>
      <div className="flex flex-col justify-between gap-3 p-4 sm:flex-row sm:items-center">
        <div>
          <p className="text-body text-[rgb(var(--text-primary))]">See every teammate&apos;s sweep, on every machine, live.</p>
          <p className="mt-1 text-meta text-[rgb(var(--text-secondary))]">
            Team Activity is a {planLabel('team')} feature — you&apos;re currently on {planLabel(plan)}.
          </p>
        </div>
        <a
          href="/pricing"
          className="gel-brand shrink-0 whitespace-nowrap rounded-xl px-3 py-2 text-center text-meta font-medium text-teal-100 transition hover:brightness-110"
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
    // Exclude fan-out batch runs (ADR-015 §3) — they're a per-batch tracker
    // for /projects, not a machine's morning sweep, and must never crowd out
    // real per-machine activity rows here.
    runs = JSON.parse(JSON.stringify(
      await FleetRun.find({ ...tf, type: { $ne: 'task-fanout' } }, { runId: 1, machine: 1, agent: 1, status: 1, startedAt: 1, finishedAt: 1, summary: 1 })
        .sort({ startedAt: -1 })
        .limit(20)
        .lean(),
    )) as FleetRunSummary[];
  } catch {
    runs = [];
  }

  const byMachine = latestRunPerMachine(runs);

  return (
    <section className="space-y-3">
      <SectionHead title="Team activity" count={byMachine.length} />
      <Card>
        {byMachine.length === 0 ? (
          <EmptyState>No fleet runs yet across your team&apos;s machines.</EmptyState>
        ) : (
          <div>
            {byMachine.map((r) => <TeamActivityRow key={r.runId} run={r} />)}
          </div>
        )}
      </Card>
    </section>
  );
}

/* ── Repo card ─────────────────────────────────────────────── */

function RepoCard({ r }: { r: FleetRepo }) {
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-4 transition-colors hover:border-[rgb(var(--border-strong))]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-body font-medium text-[rgb(var(--text-primary))]">{r.repo}</p>
          {r.group && <p className="mt-0.5 text-label text-[rgb(var(--text-muted))]">{r.group}</p>}
        </div>
        <RecommendationChip value={r.recommendation} />
      </div>

      <p className="min-h-[1rem] text-meta text-[rgb(var(--text-secondary))] line-clamp-3">{r.overnight || 'No overnight summary.'}</p>

      <div className="border-t border-[rgb(var(--border-subtle))]/70 pt-2">
        <RepoFacts r={r} />
      </div>

      <div className="flex items-center justify-between border-t border-[rgb(var(--border-subtle))]/70 pt-2">
        <ActionStatus status={r.actionStatus} />
        <div className="flex items-center gap-2">
          {r.action && <span className="text-label text-[rgb(var(--text-muted))]">{r.action}</span>}
          {r.prUrl && (
            <a
              href={r.prUrl}
              target="_blank"
              rel="noreferrer"
              className="text-label font-medium text-[rgb(var(--ok))] underline decoration-[rgb(var(--border-strong))] hover:brightness-110"
            >
              PR
            </a>
          )}
        </div>
      </div>

      {(r.detail || r.decision) && (
        <div className="space-y-1 border-t border-[rgb(var(--border-subtle))]/70 pt-2">
          {r.decision && (
            <p className="text-meta text-[rgb(var(--text-primary))]">
              <span className="text-[rgb(var(--text-muted))]">Decision </span>
              {r.decision}
            </p>
          )}
          {r.detail && <p className="text-meta text-[rgb(var(--text-secondary))] line-clamp-3">{r.detail}</p>}
        </div>
      )}
    </div>
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
    // type:'task-fanout' runs (ADR-015 §3, /api/projects handleFanout) are a
    // per-batch tracker for /projects — they must never become "the latest
    // run" here and silently replace the morning-resume-all sweep.
    run = JSON.parse(JSON.stringify(
      await FleetRun.findOne({ ...tf, type: { $ne: 'task-fanout' } }).sort({ startedAt: -1 }).limit(1).lean(),
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
  const counts = { total, needsAction, shipped, failed };

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={4} />
      <PageHeader
        icon="fleet"
        title="Fleet"
        summary={fleetSummary(run, counts, dbError)}
        subtitle={run ? fleetQualifier(run) : 'The morning sweep across every repo — overnight state, the recommended move, and live progress.'}
      >
        {run && <RunStatusPill status={run.status} />}
      </PageHeader>

      {dbError && (
        <div className="mb-6 rounded-2xl bg-[rgb(var(--err))]/10 p-4 text-meta text-[rgb(var(--err))]">
          {dbUnreachableHint('the fleet console')}
        </div>
      )}

      {!run && !dbError && (
        <Card>
          <EmptyState>
            No fleet run yet — kick one off with <code className="text-[rgb(var(--ok))]">agent mode -resume all</code>.
            The morning sweep populates this console live as it walks each repo.
          </EmptyState>
        </Card>
      )}

      {run && (
        <div className="space-y-6">
          {/* State before detail (§5.2) */}
          <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
            <StatCard label="Repos swept" value={total} icon="fleet" tone="muted" />
            <StatCard label="Need your decision" value={needsAction} icon="alert" tone={needsAction > 0 ? 'warn' : 'muted'} />
            <StatCard label="Shipped" value={shipped} icon="check" tone={shipped > 0 ? 'ok' : 'muted'} />
            <StatCard label="Failed" value={failed} icon="cross" tone={failed > 0 ? 'err' : 'muted'} />
          </div>

          {/* Team Activity */}
          <TeamActivity tenantId={tenantId} />

          {/* Repo grid */}
          <section className="space-y-3">
            <SectionHead title="Every repo" count={repos.length} />
            {repos.length === 0 ? (
              <Card>
                <EmptyState>This run has no repos yet — the sweep is still gathering state.</EmptyState>
              </Card>
            ) : (
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
                {repos.map((r) => <RepoCard key={r.repo} r={r} />)}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}
