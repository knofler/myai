// /work — everything that will run, is running, or just ran.
// Merges the old /tasks, /schedule, /plan and /orchestration pages into one
// tabbed destination: Up Next · Needs Review · Scheduled Runs · 10-Day Plans ·
// Orchestration. The active tab lives in ?tab= so old URLs redirect cleanly.

import { connectDB, Task, Schedule, PlanDay, BudgetUsage } from '@/lib/db';
import { fetchRoutingConfig, type RoutingConfig } from '@/lib/gateway';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { timeAgo, timeUntil, fmtSydney, fmtUtc, fmtUsd, formatDuration } from '@/lib/format';
import { PriorityBadge, ModelBadge, TaskStatusBadge, RunStatusBadge, PlanStatusBadge, OnDot } from '@/components/ui/badge';
import { Card, StatCard, EmptyState } from '@/components/ui/card';
import { DataTable, type DataRow } from '@/components/ui/data-table';
import { TabBar, resolveTab } from '@/components/ui/tabs';
import { RepoChips, type RepoChip } from '@/components/ui/repo-chips';
import { PageHeader } from '@/components/page-header';
import AutoRefresh from '@/components/auto-refresh';
import { BillingBanner } from '@/components/billing-banner';
import { SpendAlertBanner } from '@/components/spend-alert-banner';
import { TaskArtifactsButton } from '@/components/task-artifacts-drawer';
import { readSchedulePolicy } from '@/lib/schedule-policy';
import { readUserBlockers } from '@/lib/user-blockers';

export const dynamic = 'force-dynamic';

interface TaskDoc {
  taskId: string;
  repo: string;
  title: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  status: 'pending' | 'working' | 'review' | 'done' | 'blocked' | 'paused' | 'dead_letter';
  assignedAgent?: string;
  recommendedModel?: string;
  prUrl?: string;
  notes?: string;
  startedAt?: Date;
  completedAt?: Date;
  updatedAt?: Date;
  createdAt?: Date;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: Date;
  deadLetteredAt?: Date;
  lastError?: string;
}

interface ScheduleDoc {
  scheduleId: string;
  name: string;
  repo?: string;
  cronExpr: string;
  kind: string;
  target: string;
  enabled: boolean;
  lastRun?: Date;
  lastStatus: string;
  nextRun?: Date;
  runCount?: number;
  errorCount?: number;
}

interface PlanDoc {
  repo: string;
  day: number;
  fireAt?: Date;
  focus: string;
  status: 'enabled' | 'disabled' | 'done' | 'blocked';
}

const PRIORITY_ORDER: Record<string, number> = { P0: 0, P1: 1, P2: 2, P3: 3 };

/** Repo dimension (ADR-015 slice 1): fold ?repo= into a query filter, or {} for all repos. */
function repoFilter(repo?: string): { repo?: string } {
  return repo ? { repo } : {};
}

function effectiveModel(task: TaskDoc, routing: RoutingConfig | null): { model: string; via: string } {
  if (routing?.fableWindow?.active) return { model: routing.fableWindow.model, via: 'free window' };
  if (task.recommendedModel) return { model: task.recommendedModel, via: 'task' };
  const tier = task.assignedAgent ? routing?.agentMap?.[task.assignedAgent] : undefined;
  const model = tier ? routing?.tiers?.[tier]?.model : routing?.tiers?.standard?.model;
  return { model: model ?? 'claude-sonnet-4-6', via: tier ? `tier:${tier}` : 'default' };
}

/* ── Tab content builders ───────────────────────────────────── */

async function QueueTab({ routing, repo }: { routing: RoutingConfig | null; repo?: string }) {
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);
  const tasks = await Task.find({ ...tf, ...repoFilter(repo), status: 'pending' }).sort({ priority: 1, createdAt: 1 }).limit(200).lean() as unknown as TaskDoc[];
  const rows: DataRow[] = tasks.map((t) => {
    const m = effectiveModel(t, routing);
    const quickWin = (t.notes ?? '').includes('quick win');
    return {
      id: t.taskId,
      search: `${t.title} ${t.repo} ${t.assignedAgent ?? ''} ${m.model} ${t.priority}`.toLowerCase(),
      sort: {
        priority: PRIORITY_ORDER[t.priority] ?? 9,
        created: t.createdAt ? new Date(t.createdAt).getTime() : 0,
      },
      cells: [
        <span key="p"><PriorityBadge priority={t.priority} />{quickWin && <span className="ml-1.5 text-xs text-emerald-500" title="quick win">⚡</span>}</span>,
        <span key="t" className="text-zinc-200 block max-w-sm truncate">{t.title}</span>,
        <span key="r" className="text-zinc-500 font-mono text-xs">{t.repo}</span>,
        <span key="a" className="text-zinc-400 text-xs">{t.assignedAgent ?? 'auto-select'}</span>,
        <span key="m"><ModelBadge model={m.model} /> <span className="text-zinc-600 text-xs ml-1">{m.via}</span></span>,
        <span key="c" className="text-zinc-600 text-xs">{timeAgo(t.createdAt)}</span>,
      ],
    };
  });
  return (
    <DataTable
      title="Up next — pending queue"
      columns={[
        { label: 'Priority', sortKey: 'priority', mobile: 'badge' },
        { label: 'Task', mobile: 'title' },
        { label: 'Repo', mobile: 'meta' },
        { label: 'Planned agent', mobile: 'detail' },
        { label: 'Planned model', mobile: 'detail' },
        { label: 'Created', sortKey: 'created', mobile: 'meta' },
      ]}
      rows={rows}
      defaultSort="priority"
      searchPlaceholder="Search task, repo, agent, model, P0…"
      emptyText="Queue empty."
    />
  );
}

async function ReviewTab({ repo }: { repo?: string }) {
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);
  const tasks = await Task.find({ ...tf, ...repoFilter(repo), status: 'review' }).sort({ updatedAt: -1 }).limit(100).lean() as unknown as TaskDoc[];
  const rows: DataRow[] = tasks.map((t) => ({
    id: t.taskId,
    search: `${t.title} ${t.repo} ${t.assignedAgent ?? ''} ${t.notes ?? ''}`.toLowerCase(),
    sort: { finished: t.updatedAt ? new Date(t.updatedAt).getTime() : 0 },
    cells: [
      <span key="r" className="text-zinc-500 font-mono text-xs">{t.repo}</span>,
      <span key="t" className="text-zinc-200 block max-w-xs truncate">
        {t.prUrl ? <a href={t.prUrl} target="_blank" rel="noreferrer" className="hover:text-emerald-400 underline decoration-zinc-700">{t.title}</a> : t.title}
      </span>,
      <span key="a" className="text-zinc-400 text-xs">{t.assignedAgent ?? '—'}</span>,
      <span key="n" className="text-zinc-400 text-xs block max-w-md truncate" title={t.notes}>{t.notes?.replace(/^RESULT: /, '') ?? '—'}</span>,
      <span key="f" className="text-zinc-600 text-xs">{timeAgo(t.updatedAt)}</span>,
      <TaskArtifactsButton key="art" taskId={t.taskId} title={t.title} />,
    ],
  }));
  return (
    <DataTable
      title="Needs review — done by agents, waiting on you"
      columns={[
        { label: 'Repo', mobile: 'meta' },
        { label: 'Task', mobile: 'title' },
        { label: 'Agent', mobile: 'detail' },
        { label: 'Result', mobile: 'detail' },
        { label: 'Finished', sortKey: 'finished', mobile: 'meta' },
        { label: 'Artifacts', mobile: 'detail' },
      ]}
      rows={rows}
      defaultSort="finished"
      defaultDesc
      searchPlaceholder="Search task, repo, agent, result…"
      emptyText="Nothing awaiting review. ✨"
    />
  );
}

/** Read-only panel: which repos are core-product-priority vs consent-gated for the autonomous queue. */
function SchedulePolicyPanel({ priorityRepos, ignoreRepos }: { priorityRepos: string[]; ignoreRepos: string[] }) {
  return (
    <Card
      title="Autonomous scheduling policy"
      meta={<span title="config/schedule_priority.txt + config/schedule_ignore.txt">read-only</span>}
    >
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 text-sm">
        <div>
          <p
            className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2"
            title="Tasks for these repos keep their assigned priority (P0/P1/P2). Every other repo's pending tasks are capped at P3, so the runner always drains the core product first."
          >
            Core product · always P0–P2
          </p>
          <div className="flex flex-wrap gap-1.5">
            {priorityRepos.length === 0 && <span className="text-zinc-600 text-xs">config/schedule_priority.txt empty</span>}
            {priorityRepos.map((r) => (
              <span key={r} className="font-mono text-xs px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">{r}</span>
            ))}
          </div>
          <p className="text-xs text-zinc-600 mt-2">Every other repo&apos;s pending tasks are capped at P3.</p>
        </div>
        <div>
          <p
            className="text-[11px] text-zinc-500 uppercase tracking-wider mb-2"
            title="These repos get NO autonomous runner work without the user's explicit consent. A manual, consented run (--force / --task / SCHEDULE_CONSENT=1) still works."
          >
            Consent-gated · no autonomous work
          </p>
          <div className="flex flex-wrap gap-1.5">
            {ignoreRepos.length === 0 && <span className="text-zinc-600 text-xs">config/schedule_ignore.txt empty</span>}
            {ignoreRepos.map((r) => (
              <span key={r} className="font-mono text-xs px-2 py-0.5 rounded bg-amber-500/10 text-amber-300 border border-amber-500/30">{r}</span>
            ))}
          </div>
          <p className="text-xs text-zinc-600 mt-2">Runner skips these on autonomous picks until the user consents.</p>
        </div>
      </div>
    </Card>
  );
}

async function SchedulesTab({ tenantId, repo }: { tenantId: string; repo?: string }) {
  const [schedules, policy] = await Promise.all([
    Schedule.find({ ...tenantFilter(tenantId), ...repoFilter(repo) }).sort({ enabled: -1, nextRun: 1 }).lean() as unknown as Promise<ScheduleDoc[]>,
    readSchedulePolicy(),
  ]);
  const rows: DataRow[] = schedules.map((s) => ({
    id: s.scheduleId,
    search: `${s.name} ${s.repo ?? ''} ${s.kind} ${s.target} ${s.lastStatus}`.toLowerCase(),
    sort: { next: s.nextRun ? new Date(s.nextRun).getTime() : Number.MAX_SAFE_INTEGER, runs: s.runCount ?? 0 },
    cells: [
      <span key="n" className="text-zinc-200">{s.name}</span>,
      <span key="r" className="text-zinc-400 text-xs font-mono">{s.repo || '—'}</span>,
      <span key="t" className="text-zinc-400 text-xs font-mono">{s.kind}:{s.target}</span>,
      <span key="c" className="text-zinc-500 font-mono text-xs">{s.cronExpr}</span>,
      <span key="x" className="text-xs">
        <span className="text-zinc-300">{timeUntil(s.nextRun)}</span>
        {s.nextRun && <span className="text-zinc-600 ml-2">{fmtSydney(s.nextRun)}</span>}
      </span>,
      <span key="l" className="text-xs"><RunStatusBadge status={s.lastStatus} /><span className="text-zinc-600 ml-2">{timeAgo(s.lastRun)}</span></span>,
      <span key="ct" className="text-zinc-500 text-xs">{s.runCount ?? 0}{(s.errorCount ?? 0) > 0 && <span className="text-red-400"> ({s.errorCount} err)</span>}</span>,
      <OnDot key="o" on={s.enabled} />,
    ],
  }));
  return (
    <div className="space-y-4">
      <SchedulePolicyPanel priorityRepos={policy.priorityRepos} ignoreRepos={policy.ignoreRepos} />
      <DataTable
        title="Scheduled runs"
        meta={`${schedules.filter((s) => s.enabled).length} enabled of ${schedules.length}`}
        columns={[
          { label: 'Schedule', mobile: 'title' },
          { label: 'Repo', mobile: 'meta' },
          { label: 'Target', mobile: 'detail' },
          { label: 'Cron (UTC)', mobile: 'detail' },
          { label: 'Next run (Sydney)', sortKey: 'next', mobile: 'meta' },
          { label: 'Last', mobile: 'meta' },
          { label: 'Runs', sortKey: 'runs', mobile: 'detail' },
          { label: 'On', mobile: 'badge' },
        ]}
        rows={rows}
        defaultSort="next"
        searchPlaceholder="Search schedule, repo, target…"
        emptyText={
          <>
            No recurring schedules yet — seed one with <code className="text-emerald-400">./scripts/seed_schedules.sh</code>.{' '}
            New here? <a href="/welcome/start" className="text-emerald-400 hover:underline">Connect a repo and queue a first task</a>{' '}
            to see the runner in action on the Orchestration tab.
          </>
        }
      />
    </div>
  );
}

/** Read-only fleet-wide tracker for credentials/decisions the operator owes (config/user_blockers.md). */
async function BlockersTab() {
  const blockers = await readUserBlockers();
  const openCount = blockers.filter((b) => b.status === 'open').length;
  const rows: DataRow[] = blockers.map((b) => ({
    id: b.id,
    search: `${b.repo} ${b.blocker} ${b.notes}`.toLowerCase(),
    sort: { open: b.status === 'open' ? 0 : 1, requested: b.requested },
    cells: [
      <span key="r" className="text-zinc-500 font-mono text-xs">{b.repo}</span>,
      <span key="b" className="text-zinc-200 block max-w-md truncate" title={b.blocker}>{b.blocker}</span>,
      <span key="q" className="text-zinc-600 text-xs">{b.requested || '—'}</span>,
      <span
        key="s"
        className={`text-xs px-2 py-0.5 rounded-full border ${
          b.status === 'open'
            ? 'bg-amber-500/10 text-amber-300 border-amber-500/30'
            : 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
        }`}
      >
        {b.status}
      </span>,
      <span key="n" className="text-zinc-500 text-xs block max-w-sm truncate" title={b.notes}>{b.notes || '—'}</span>,
    ],
  }));
  return (
    <DataTable
      title="User-owed blockers"
      meta={`${openCount} open of ${blockers.length} · config/user_blockers.md`}
      columns={[
        { label: 'Repo', mobile: 'meta' },
        { label: 'Blocker', mobile: 'title' },
        { label: 'Requested', sortKey: 'requested', mobile: 'meta' },
        { label: 'Status', sortKey: 'open', mobile: 'badge' },
        { label: 'Notes', mobile: 'detail' },
      ]}
      rows={rows}
      defaultSort="open"
      searchPlaceholder="Search repo, blocker, notes…"
      emptyText={
        <>
          No blockers tracked. Add one via{' '}
          <code className="text-emerald-400">./scripts/user_blockers.sh add &lt;repo&gt; &quot;&lt;blocker&gt;&quot;</code>.
        </>
      }
    />
  );
}

/** Dead-letter queue (bounded retry-with-backoff exhausted) — operator triage. */
async function DeadLetterTab({ repo }: { repo?: string }) {
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);
  const tasks = await Task.find({ ...tf, ...repoFilter(repo), status: 'dead_letter' }).sort({ deadLetteredAt: -1 }).limit(200).lean() as unknown as TaskDoc[];
  const rows: DataRow[] = tasks.map((t) => ({
    id: t.taskId,
    search: `${t.title} ${t.repo} ${t.assignedAgent ?? ''} ${t.lastError ?? ''}`.toLowerCase(),
    sort: { dead: t.deadLetteredAt ? new Date(t.deadLetteredAt).getTime() : 0 },
    cells: [
      <span key="r" className="text-zinc-500 font-mono text-xs">{t.repo}</span>,
      <span key="t" className="text-zinc-200 block max-w-xs truncate">{t.title}</span>,
      <span key="a" className="text-zinc-400 text-xs">{t.assignedAgent ?? '—'}</span>,
      <span key="rc" className="text-xs font-mono text-red-400">{t.retryCount ?? '?'}/{t.maxRetries ?? '?'}</span>,
      <span key="e" className="text-zinc-400 text-xs block max-w-md truncate" title={t.lastError}>{t.lastError ?? '—'}</span>,
      <span key="d" className="text-zinc-600 text-xs">{timeAgo(t.deadLetteredAt)}</span>,
    ],
  }));
  return (
    <DataTable
      title="Dead letter — retries exhausted, needs operator triage"
      meta={`${tasks.length} dead-lettered · requeue with tasks_update {status:"pending"} (clears the retry ledger)`}
      columns={[
        { label: 'Repo', mobile: 'meta' },
        { label: 'Task', mobile: 'title' },
        { label: 'Agent', mobile: 'detail' },
        { label: 'Retries', mobile: 'badge' },
        { label: 'Last error', mobile: 'detail' },
        { label: 'Dead-lettered', sortKey: 'dead', mobile: 'meta' },
      ]}
      rows={rows}
      defaultSort="dead"
      defaultDesc
      searchPlaceholder="Search task, repo, agent, error…"
      emptyText="No dead-lettered tasks. Failed tasks retry with backoff before landing here. ✨"
    />
  );
}

async function PlansTab({ tenantId, repo }: { tenantId: string; repo?: string }) {
  const plan = await PlanDay.find({ ...tenantFilter(tenantId), ...repoFilter(repo) }).sort({ repo: 1, day: 1 }).lean() as unknown as PlanDoc[];
  const byRepo: Record<string, PlanDoc[]> = {};
  for (const p of plan) (byRepo[p.repo] ??= []).push(p);
  const repos = Object.keys(byRepo).sort();
  const doneCount = plan.filter((p) => p.status === 'done').length;

  if (repos.length === 0) {
    return (
      <Card title="10-day plans">
        <EmptyState>
          <p>
            No plans yet. A repo&apos;s planning session sets its 10-day plan via <code className="text-zinc-400">plan_set</code> (keyword <code className="text-zinc-400">schedule plan</code>).
          </p>
          <p className="mt-2">
            Haven&apos;t connected a repo yet? <a href="/welcome/start" className="text-emerald-400 hover:underline">Start the guided first run</a>.
          </p>
        </EmptyState>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <StatCard label="Repos planned" value={repos.length} />
        <StatCard label="Plan days" value={plan.length} />
        <StatCard label="Days done" value={doneCount} accent={doneCount > 0 ? 'green' : 'gray'} />
      </div>
      {repos.map((repo) => (
        <Card key={repo} title={<span className="font-mono">{repo}</span>} meta={`${byRepo[repo].filter((p) => p.status === 'done').length}/${byRepo[repo].length} done`}>
          <table className="card-table w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                <th className="px-4 py-2.5 w-12 font-medium">Day</th>
                <th className="px-4 py-2.5 font-medium">Fires (UTC → Sydney)</th>
                <th className="px-4 py-2.5 font-medium">Focus</th>
                <th className="px-4 py-2.5 w-32 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {byRepo[repo].map((p) => (
                <tr key={p.day} className="hover:bg-zinc-800/30">
                  <td data-label="Day" className="px-4 py-2.5 text-zinc-200 font-mono">Day {p.day}</td>
                  <td data-label="Fires" className="m-hide px-4 py-2.5 text-xs">
                    <span className="text-zinc-400 font-mono">{fmtUtc(p.fireAt)} UTC</span>
                    <span className="text-zinc-600"> → </span>
                    <span className="text-zinc-300">{fmtSydney(p.fireAt, 'full')}</span>
                  </td>
                  <td data-label="Focus" className="m-title px-4 py-2.5 text-zinc-200">{p.focus}</td>
                  <td data-label="Status" className="px-4 py-2.5"><PlanStatusBadge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}
    </div>
  );
}

async function OrchestrationTab({ routing, repo }: { routing: RoutingConfig | null; repo?: string }) {
  const now = new Date();
  const startOfDayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tenantId = await getActiveTenant();
  const baseTf = tenantFilter(tenantId);
  const tf = { ...baseTf, ...repoFilter(repo) };
  // BudgetUsage is NOT repo-keyed (metered per API call, not per repo), so daily
  // spend stays tenant-wide even when a repo chip is active. Task rollups honor it.

  const [working, recentDone, todaySpend, todayTasks, doneCount, blockedCount, deadLetterCount] = await Promise.all([
    Task.find({ ...tf, status: 'working' }).sort({ startedAt: -1 }).lean() as unknown as Promise<TaskDoc[]>,
    Task.find({ ...tf, status: 'done' }).sort({ completedAt: -1 }).limit(25).lean() as unknown as Promise<TaskDoc[]>,
    BudgetUsage.aggregate([
      { $match: { ...baseTf, createdAt: { $gte: startOfDayUTC } } },
      { $group: { _id: null, total: { $sum: '$costUsd' }, count: { $sum: 1 } } },
    ]) as Promise<Array<{ total: number; count: number }>>,
    Task.countDocuments({ ...tf, updatedAt: { $gte: startOfDayUTC }, status: { $in: ['done', 'working', 'review'] } }) as Promise<number>,
    Task.countDocuments({ ...tf, status: 'done' }) as Promise<number>,
    Task.countDocuments({ ...tf, status: 'blocked' }) as Promise<number>,
    Task.countDocuments({ ...tf, status: 'dead_letter' }) as Promise<number>,
  ]);

  // Dead-lettered tasks are a resolved-failed outcome, same as blocked (retries
  // exhausted vs. never retried) — both count against success rate.
  const resolved = doneCount + blockedCount + deadLetterCount;
  const successRate = resolved > 0 ? Math.round((doneCount / resolved) * 100) : 100;
  const spend = todaySpend[0];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Active workers" value={working.length} accent={working.length > 0 ? 'blue' : 'gray'} />
        <StatCard label="Tasks today" value={todayTasks} sub={`since ${startOfDayUTC.toISOString().slice(0, 10)} UTC`} />
        <StatCard label="Success rate" value={`${successRate}%`} sub={`${doneCount} done · ${blockedCount} blocked · ${deadLetterCount} dead-letter`} accent={successRate >= 90 ? 'green' : 'yellow'} />
        <StatCard label="Daily spend" value={fmtUsd(spend?.total ?? 0)} sub={`${spend?.count ?? 0} API calls`} />
      </div>

      <Card accent="blue" title="Running now — agent × task × model" meta={`${working.length} working`}>
        {working.length === 0 ? (
          <EmptyState>No agents working right now. The dispatch worker runs daily at 06:05 UTC, or trigger <code className="text-emerald-400">dispatch_cycle</code> manually.</EmptyState>
        ) : (
          <table className="card-table w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">Task</th>
                <th className="px-4 py-2.5 font-medium">Repo</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Priority</th>
                <th className="px-4 py-2.5 font-medium">Started</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {working.map((t) => {
                const m = effectiveModel(t, routing);
                return (
                  <tr key={t.taskId} className="hover:bg-zinc-800/30">
                    <td data-label="Agent" className="px-4 py-2.5 text-zinc-200 text-xs font-medium">
                      <span className="inline-block w-2 h-2 rounded-full bg-blue-400 animate-pulse mr-2" />
                      {t.assignedAgent ?? 'unassigned'}
                    </td>
                    <td data-label="Task" className="m-title px-4 py-2.5 text-zinc-300 max-w-sm truncate">{t.title}</td>
                    <td data-label="Repo" className="px-4 py-2.5 text-zinc-500 font-mono text-xs">{t.repo}</td>
                    <td data-label="Model" className="px-4 py-2.5"><ModelBadge model={m.model} /> <span className="text-zinc-600 text-xs ml-1">{m.via}</span></td>
                    <td data-label="Priority" className="px-4 py-2.5"><PriorityBadge priority={t.priority} /></td>
                    <td data-label="Started" className="m-hide px-4 py-2.5 text-zinc-600 text-xs">{timeAgo(t.startedAt)}</td>
                    <td data-label="Duration" className="px-4 py-2.5 text-zinc-600 text-xs font-mono">{formatDuration(t.startedAt)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      <Card title="Recent dispatches" meta={`last ${recentDone.length} completed`}>
        {recentDone.length === 0 ? (
          <EmptyState>No completed tasks yet.</EmptyState>
        ) : (
          <table className="card-table w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                <th className="px-4 py-2.5 font-medium">Repo</th>
                <th className="px-4 py-2.5 font-medium">Task</th>
                <th className="px-4 py-2.5 font-medium">Agent</th>
                <th className="px-4 py-2.5 font-medium">Duration</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Completed</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/50">
              {recentDone.map((t) => (
                <tr key={t.taskId} className="hover:bg-zinc-800/30">
                  <td data-label="Repo" className="px-4 py-2.5 text-zinc-400 font-mono text-xs">{t.repo}</td>
                  <td data-label="Task" className="m-title px-4 py-2.5 text-zinc-200 max-w-xs truncate">
                    {t.prUrl ? <a href={t.prUrl} target="_blank" rel="noreferrer" className="hover:text-emerald-400 underline decoration-zinc-700">{t.title}</a> : t.title}
                  </td>
                  <td data-label="Agent" className="m-hide px-4 py-2.5 text-zinc-500 text-xs">{t.assignedAgent ?? '—'}</td>
                  <td data-label="Duration" className="m-hide px-4 py-2.5 text-zinc-600 text-xs font-mono">{formatDuration(t.startedAt, t.completedAt)}</td>
                  <td data-label="Status" className="px-4 py-2.5"><TaskStatusBadge status={t.status} /></td>
                  <td data-label="Completed" className="px-4 py-2.5 text-zinc-600 text-xs">{timeAgo(t.completedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

/* ── Page ───────────────────────────────────────────────────── */

export default async function WorkPage({ searchParams }: { searchParams: Promise<{ tab?: string; repo?: string }> }) {
  const { tab: requested, repo: requestedRepo } = await searchParams;

  await connectDB();
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  // Per-repo "queue" (pending) counts — sourced from the existing Task collection,
  // no new collection (ADR-015 slice 1). Drives the filter chips + validates ?repo=.
  const repoCounts = await Task.aggregate([
    { $match: { ...tf, status: 'pending' } },
    { $group: { _id: '$repo', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
  ]) as Array<{ _id: string; count: number }>;
  const repoChips: RepoChip[] = repoCounts
    .filter((r) => r._id)
    .map((r) => ({ repo: r._id, count: r.count }));
  // Only honor ?repo= when it matches a known repo, so a stale link can't blank the board.
  const repo = repoChips.some((r) => r.repo === requestedRepo) ? requestedRepo : undefined;
  const rf = repoFilter(repo);

  const [pendingCount, reviewCount, workingCount, scheduleCount, planCount, deadLetterCount, routing, blockers] = await Promise.all([
    Task.countDocuments({ ...tf, ...rf, status: 'pending' }) as Promise<number>,
    Task.countDocuments({ ...tf, ...rf, status: 'review' }) as Promise<number>,
    Task.countDocuments({ ...tf, ...rf, status: 'working' }) as Promise<number>,
    Schedule.countDocuments({ ...tf, ...rf, enabled: true }) as Promise<number>,
    PlanDay.countDocuments({ ...tf, ...rf }) as Promise<number>,
    Task.countDocuments({ ...tf, ...rf, status: 'dead_letter' }) as Promise<number>,
    fetchRoutingConfig(),
    readUserBlockers(),
  ]);
  const openBlockerCount = blockers.filter((b) => b.status === 'open').length;

  const tabs = [
    { id: 'queue', label: 'Up Next', count: pendingCount },
    { id: 'review', label: 'Needs Review', count: reviewCount },
    { id: 'schedules', label: 'Scheduled Runs', count: scheduleCount },
    { id: 'plans', label: '10-Day Plans', count: planCount },
    { id: 'orchestration', label: 'Orchestration', count: workingCount },
    { id: 'deadletter', label: 'Dead Letter', count: deadLetterCount },
    { id: 'blockers', label: 'Blockers', count: openBlockerCount },
  ];
  const tab = resolveTab(tabs, requested);
  const fable = routing?.fableWindow;

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={15} />
      <PageHeader title="Work" subtitle="The plan and the queue — everything that will run, is running, or just ran.">
        {fable?.active && (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-purple-500/15 border border-purple-500/40 text-xs font-medium text-purple-300">
            FABLE FREE — all work routes to {fable.model}
          </span>
        )}
      </PageHeader>

      <BillingBanner />
      <SpendAlertBanner />

      <TabBar base="/work" tabs={tabs} active={tab} params={{ repo }} />

      <RepoChips repos={repoChips} active={repo} tab={tab} />

      <div className="mt-6">
        {tab === 'queue' && <QueueTab routing={routing} repo={repo} />}
        {tab === 'review' && <ReviewTab repo={repo} />}
        {tab === 'schedules' && <SchedulesTab tenantId={tenantId} repo={repo} />}
        {tab === 'plans' && <PlansTab tenantId={tenantId} repo={repo} />}
        {tab === 'orchestration' && <OrchestrationTab routing={routing} repo={repo} />}
        {tab === 'deadletter' && <DeadLetterTab repo={repo} />}
        {tab === 'blockers' && <BlockersTab />}
      </div>
    </div>
  );
}
