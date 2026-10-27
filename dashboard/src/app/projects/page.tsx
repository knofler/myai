// /projects — the multi-repo orchestration board (ADR-015, Phase 2 "agencies").
//
// One view spanning every repo a tenant owns: repos folded into projects (by
// RepoCard.group), a per-project rollup grid (repo count, worst-wins health,
// task counts), a unified cross-repo pending queue, and the bulk levers —
// fan-out dispatch + drag-to-reprioritize (client console). Reads the same
// tenant-scoped collections as /work and /apps; writes go through /api/projects.
//
// Fleet Overview v0 (plan/MULTI_REPO_ORCHESTRATION_UI_SPEC.md) fields are
// layered onto the per-repo rows below: in-flight agent + elapsed, last-ship
// status/time/unshipped-commits, and a fleet-wide runner-liveness badge. That
// spec assumed this route was unbuilt (grep run against `main`, where neither
// this page nor its ADR-015 predecessor had landed yet) — on `test` the full
// ADR-015 board (commit c1e690e) already shipped three weeks earlier, so
// rather than a competing v0-only page, its remaining fields extend this one.

import { connectDB, Task, RepoCard, Tenant, FleetRun } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { getRunnerLiveness } from '@/lib/runner-health';
import { PageHeader } from '@/components/page-header';
import { Card, StatCard, EmptyState } from '@/components/ui/card';
import { LevelDot } from '@/components/ui/badge';
import { RecommendationChip, ActionStatus } from '@/components/fleet-status-chips';
import { timeAgo, formatDuration } from '@/lib/format';
import { plural, verb, joinClauses, cap } from '@/lib/summary';
import AutoRefresh from '@/components/auto-refresh';
import {
  buildProjectRollups,
  type RepoTaskCounts,
  type ProjectMeta,
  type TaskStatus,
  type Priority,
} from '@/lib/projects';
import {
  buildInFlightByRepo,
  buildLastShipByRepo,
  fleetSummary,
  type FleetTaskLike,
} from '@/lib/fleet-overview';
import { ProjectsConsole, type ConsoleRepo, type PendingTask } from './projects-console';

export const dynamic = 'force-dynamic';

interface RepoCardDoc {
  repoName?: string;
  group?: string;
  lastStatusLevel?: 'ok' | 'warn' | 'error' | 'unknown';
  lastStatus?: string;
  updatedAt?: string | Date;
  commitsAhead?: number;
}

// Fan-out batch runs (ADR-015 §3, plan/MULTI_REPO_ORCHESTRATION_PHASE3_SPEC.md
// §"Surface it on /projects"). handleFanout (api/projects/route.ts) writes one
// FleetRun per dispatch (type:'task-fanout', runId = batchId); task-store.ts
// keeps repos[].actionStatus live as the batch's tasks transition. This is a
// read-only rollup of the tenant's last 10 — /fleet's own queries explicitly
// exclude this type, so it never competes with the morning-resume-all console.
interface BatchRunDoc {
  runId: string;
  status?: 'running' | 'completed' | 'aborted';
  startedAt?: string | Date;
  repos: Array<{ repo: string; recommendation?: string; actionStatus?: string }>;
  summary?: { total?: number; needsAction?: number; shipped?: number; failed?: number };
}

/** Fleet-wide runner-liveness badge — green "alive Nm ago" / red "down". */
function RunnerBadge({ liveness }: { liveness: Awaited<ReturnType<typeof getRunnerLiveness>> }) {
  if (!liveness.alive) {
    return (
      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-red-500/15 border border-red-500/40 text-xs font-medium text-red-300">
        <span className="w-2 h-2 rounded-full bg-red-400" />
        Runner: down{liveness.lastMachine ? ` · last ${liveness.lastMachine} ${timeAgo(liveness.lastHeartbeatAt)}` : ''}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-emerald-500/15 border border-emerald-500/40 text-xs font-medium text-emerald-300">
      <span className="w-2 h-2 rounded-full bg-emerald-400" />
      Runner: alive {timeAgo(liveness.lastHeartbeatAt)}
    </span>
  );
}

/** The one-line answer (DESIGN_LANGUAGE §5.1) — how much you own, what is
 *  moving across it, and whether the runner is alive to move it. Built only
 *  from the rollups this page already computes. */
function projectsSummary(
  projectCount: number,
  repoCount: number,
  counts: { queueDepth: number; inFlight: number; needsAttention: number; review: number },
  runnerAlive: boolean,
): string {
  if (projectCount === 0) {
    return 'No repos registered yet. They appear here as soon as a repo reports a card or has a queued task.';
  }
  const head = `You have ${plural(repoCount, 'repo')} across ${plural(projectCount, 'project')}.`;
  const body =
    counts.queueDepth === 0 && counts.needsAttention === 0
      ? counts.review > 0
        ? `${plural(counts.review, 'task')} ${verb(counts.review, 'is', 'are')} ready for your review.`
        : 'Nothing is queued and nothing needs you.'
      : `${cap(
          joinClauses([
            counts.queueDepth > 0 &&
              `${plural(counts.queueDepth, 'task')} ${verb(counts.queueDepth, 'is', 'are')} queued or running`,
            counts.inFlight > 0 && `${counts.inFlight} in flight right now`,
            counts.needsAttention > 0 &&
              `${plural(counts.needsAttention, 'task')} ${verb(counts.needsAttention, 'needs', 'need')} attention`,
          ]),
        )}.`;
  const runner = runnerAlive ? '' : ' The runner is down, so nothing new will start.';
  return `${head} ${body}${runner}`;
}

export default async function ProjectsPage() {
  await connectDB();
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const [cards, statusAgg, pendingDocs, tenantDoc, rawTasks, liveness, recentBatches] = await Promise.all([
    RepoCard.find(tf).select('repoName group lastStatusLevel lastStatus updatedAt commitsAhead').lean() as unknown as Promise<RepoCardDoc[]>,
    Task.aggregate([
      { $match: tf },
      { $group: { _id: { repo: '$repo', status: '$status' }, count: { $sum: 1 } } },
    ]) as Promise<Array<{ _id: { repo: string; status: TaskStatus }; count: number }>>,
    Task.find({ ...tf, status: 'pending' }).select('taskId repo title priority').sort({ priority: 1, createdAt: 1 }).limit(120).lean() as unknown as Promise<Array<{ taskId: string; repo: string; title: string; priority: Priority }>>,
    Tenant.findOne({ tenantId }).select('metadata').lean() as Promise<{ metadata?: { projects?: Record<string, ProjectMeta> } } | null>,
    // Fleet Overview v0 — one unfiltered tasks_list-shape call (raised limit
    // per the spec's aggregation caveat), grouped client-side below instead of
    // a dedicated tasks_summary aggregation tool (not needed at Team's 15-repo
    // cap; see plan/MULTI_REPO_ORCHESTRATION_UI_SPEC.md §"Aggregation caveat").
    Task.find(tf).select('repo status assignedAgent startedAt').limit(500).lean() as unknown as Promise<FleetTaskLike[]>,
    getRunnerLiveness(),
    FleetRun.find({ ...tf, type: 'task-fanout' }).select('runId status startedAt repos summary').sort({ startedAt: -1 }).limit(10).lean() as unknown as Promise<BatchRunDoc[]>,
  ]);

  // Fold the (repo, status) aggregation into per-repo count maps.
  const taskCounts: Record<string, RepoTaskCounts> = {};
  for (const row of statusAgg) {
    const repo = row._id?.repo;
    if (!repo) continue;
    (taskCounts[repo] ??= {})[row._id.status] = row.count;
  }

  const projectMeta = tenantDoc?.metadata?.projects ?? {};
  const projects = buildProjectRollups(cards, taskCounts, projectMeta);

  const totalRepos = projects.reduce((n, p) => n + p.repoCount, 0);
  const inFlightByRepo = buildInFlightByRepo(rawTasks);
  const lastShipByRepo = buildLastShipByRepo(cards);
  const summary = fleetSummary(rawTasks, totalRepos);

  // Console inputs: every known repo (for the fan-out picker) + the pending queue.
  const consoleRepos: ConsoleRepo[] = projects
    .flatMap((p) => p.repos.map((r) => ({ repo: r.repo, group: p.label, open: r.open })))
    .sort((a, b) => a.group.localeCompare(b.group) || a.repo.localeCompare(b.repo));
  const pendingTasks: PendingTask[] = pendingDocs.map((t) => ({
    taskId: t.taskId,
    repo: t.repo,
    title: t.title,
    priority: t.priority,
  }));

  return (
    <div className="max-w-7xl mx-auto">
      <AutoRefresh seconds={20} />
      <PageHeader
        icon="projects"
        title="Projects"
        summary={projectsSummary(projects.length, totalRepos, summary, liveness.alive)}
        subtitle="Multi-repo orchestration — the view and the lever across every repo at once."
      >
        <RunnerBadge liveness={liveness} />
      </PageHeader>

      {projects.length === 0 ? (
        <Card title="No repos yet">
          <EmptyState>
            No repos registered. Repos appear here once they report an App Directory card
            (<code className="text-[rgb(var(--text-secondary))]">repo_card.sh</code>) or have queued tasks. Group them with
            <code className="text-[rgb(var(--text-secondary))]"> RepoCard.group</code> to form projects.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <StatCard label="Projects" value={projects.length} icon="projects" tone="muted" />
            <StatCard label="Repos" value={totalRepos} icon="fleet" tone="muted" href="/apps" />
            <StatCard label="Queue depth" value={summary.queueDepth} sub="pending + working" icon="queue" tone="muted" href="/work" />
            <StatCard label="In-flight" value={summary.inFlight} icon="runs" tone={summary.inFlight > 0 ? 'accent' : 'muted'} href="/work?tab=orchestration" />
            <StatCard label="Needs attention" value={summary.needsAttention} sub="blocked + dead-lettered" icon="alert" tone={summary.needsAttention > 0 ? 'err' : 'muted'} />
          </div>

          {/* Per-project rollup grid */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {projects.map((p) => (
              <Card
                key={p.group}
                title={
                  <span className="inline-flex items-center gap-2">
                    <LevelDot level={p.level} />
                    {p.label}
                    <span className="text-xs font-normal text-[rgb(var(--text-muted))]">· {p.repoCount} repo{p.repoCount === 1 ? '' : 's'}</span>
                  </span>
                }
                meta={`${p.open} open · ${p.counts.review} review · ${p.counts.blocked} blocked`}
              >
                <div className="p-4">
                  {p.description && <p className="text-xs text-[rgb(var(--text-muted))] mb-3">{p.description}</p>}
                  <table className="card-table w-full text-sm">
                    <thead>
                      <tr className="text-left text-label text-[rgb(var(--text-muted))] border-b border-[rgb(var(--border-subtle))] uppercase tracking-wider">
                        <th className="px-2 py-2 font-medium">Repo</th>
                        <th className="px-2 py-2 font-medium text-right">Pending</th>
                        <th className="px-2 py-2 font-medium text-right">Working</th>
                        <th className="px-2 py-2 font-medium text-right">Review</th>
                        <th className="px-2 py-2 font-medium text-right">Blocked</th>
                        <th className="px-2 py-2 font-medium">In-flight</th>
                        <th className="px-2 py-2 font-medium">Last ship</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[rgb(var(--border-subtle))]/50">
                      {p.repos.map((r) => {
                        const inFlight = inFlightByRepo[r.repo];
                        const lastShip = lastShipByRepo[r.repo];
                        return (
                          <tr key={r.repo} className="hover:bg-[rgb(var(--bg-hover))]/30">
                            <td className="px-2 py-2">
                              <a href={`/work?repo=${encodeURIComponent(r.repo)}`} className="inline-flex items-center gap-2 text-[rgb(var(--text-primary))] hover:text-teal-300">
                                <LevelDot level={r.level} className="w-2 h-2" />
                                <span className="font-mono text-xs">{r.repo}</span>
                              </a>
                            </td>
                            <td className="px-2 py-2 text-right text-[rgb(var(--text-primary))] tabular-nums">{r.counts.pending || <span className="text-zinc-700">·</span>}</td>
                            <td className="px-2 py-2 text-right text-blue-400 tabular-nums">{r.counts.working || <span className="text-zinc-700">·</span>}</td>
                            <td className="px-2 py-2 text-right text-purple-400 tabular-nums">{r.counts.review || <span className="text-zinc-700">·</span>}</td>
                            <td className="px-2 py-2 text-right text-red-400 tabular-nums">{r.counts.blocked || <span className="text-zinc-700">·</span>}</td>
                            <td className="px-2 py-2 text-xs text-[rgb(var(--text-secondary))] whitespace-nowrap">
                              {inFlight
                                ? <>{inFlight.assignedAgent ?? 'agent —'} <span className="text-zinc-600">· {formatDuration(inFlight.startedAt)}</span></>
                                : <span className="text-zinc-700">—</span>}
                            </td>
                            <td className="px-2 py-2 text-xs text-[rgb(var(--text-secondary))] whitespace-nowrap">
                              {lastShip
                                ? (
                                  <span className="inline-flex items-center gap-1.5">
                                    <span className="truncate max-w-[10rem]" title={lastShip.status}>{lastShip.status || '—'}</span>
                                    <span className="text-zinc-600">· {timeAgo(lastShip.at)}</span>
                                    {!!lastShip.commitsAhead && lastShip.commitsAhead > 0 && (
                                      <span className="px-1.5 py-0.5 rounded bg-amber-500/15 border border-amber-500/30 text-amber-300 text-label">
                                        {lastShip.commitsAhead} unshipped
                                      </span>
                                    )}
                                  </span>
                                )
                                : <span className="text-zinc-700">no card yet</span>}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>

          {/* Bulk levers — fan-out + reprioritize */}
          <ProjectsConsole repos={consoleRepos} pendingTasks={pendingTasks} />

          {/* Recent fan-out batches (ADR-015 §3) — "how is my batch doing"
              without opening a tab per repo. Empty until the composer above
              is used at least once. */}
          {recentBatches.length > 0 && (
            <Card title="Recent batches" meta={`last ${recentBatches.length}`}>
              <div className="p-4 space-y-4">
                {recentBatches.map((run) => (
                  <div key={run.runId} className="border border-[rgb(var(--border-subtle))] rounded-md p-3">
                    <div className="flex items-center justify-between gap-2 mb-2">
                      <span className="font-mono text-xs text-[rgb(var(--text-secondary))]">{run.runId}</span>
                      <span className="text-label text-[rgb(var(--text-muted))]">
                        {run.summary?.shipped ?? 0}/{run.summary?.total ?? run.repos.length} done
                        {!!run.summary?.failed && <span className="text-red-400"> · {run.summary.failed} failed</span>}
                        <span className="ml-2">· {timeAgo(run.startedAt)}</span>
                      </span>
                    </div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-1.5">
                      {run.repos.map((r) => (
                        <div key={r.repo} className="flex items-center justify-between gap-2 text-xs">
                          <a href={`/work?repo=${encodeURIComponent(r.repo)}`} className="font-mono text-[rgb(var(--text-primary))] hover:text-teal-300 truncate">{r.repo}</a>
                          <span className="flex items-center gap-2 shrink-0">
                            <RecommendationChip value={r.recommendation} />
                            <ActionStatus status={r.actionStatus} />
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}
