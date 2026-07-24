// /projects — the multi-repo orchestration board (ADR-015, Phase 2 "agencies").
//
// One view spanning every repo a tenant owns: repos folded into projects (by
// RepoCard.group), a per-project rollup grid (repo count, worst-wins health,
// task counts), a unified cross-repo pending queue, and the bulk levers —
// fan-out dispatch + drag-to-reprioritize (client console). Reads the same
// tenant-scoped collections as /work and /apps; writes go through /api/projects.

import { connectDB, Task, RepoCard, Tenant } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { PageHeader } from '@/components/page-header';
import { Card, StatCard, EmptyState } from '@/components/ui/card';
import { LevelDot } from '@/components/ui/badge';
import AutoRefresh from '@/components/auto-refresh';
import {
  buildProjectRollups,
  type RepoTaskCounts,
  type ProjectMeta,
  type TaskStatus,
  type Priority,
} from '@/lib/projects';
import { ProjectsConsole, type ConsoleRepo, type PendingTask } from './projects-console';

export const dynamic = 'force-dynamic';

interface RepoCardDoc {
  repoName?: string;
  group?: string;
  lastStatusLevel?: 'ok' | 'warn' | 'error' | 'unknown';
}

export default async function ProjectsPage() {
  await connectDB();
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const [cards, statusAgg, pendingDocs, tenantDoc] = await Promise.all([
    RepoCard.find(tf).select('repoName group lastStatusLevel').lean() as unknown as Promise<RepoCardDoc[]>,
    Task.aggregate([
      { $match: tf },
      { $group: { _id: { repo: '$repo', status: '$status' }, count: { $sum: 1 } } },
    ]) as Promise<Array<{ _id: { repo: string; status: TaskStatus }; count: number }>>,
    Task.find({ ...tf, status: 'pending' }).select('taskId repo title priority').sort({ priority: 1, createdAt: 1 }).limit(120).lean() as unknown as Promise<Array<{ taskId: string; repo: string; title: string; priority: Priority }>>,
    Tenant.findOne({ tenantId }).select('metadata').lean() as Promise<{ metadata?: { projects?: Record<string, ProjectMeta> } } | null>,
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
  const totalOpen = projects.reduce((n, p) => n + p.open, 0);
  const totalBlocked = projects.reduce((n, p) => n + p.counts.blocked, 0);

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
      <PageHeader title="Projects" subtitle="Multi-repo orchestration — the view and the lever across every repo at once." />

      {projects.length === 0 ? (
        <Card title="No repos yet">
          <EmptyState>
            No repos registered. Repos appear here once they report an App Directory card
            (<code className="text-zinc-400">repo_card.sh</code>) or have queued tasks. Group them with
            <code className="text-zinc-400"> RepoCard.group</code> to form projects.
          </EmptyState>
        </Card>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard label="Projects" value={projects.length} />
            <StatCard label="Repos" value={totalRepos} />
            <StatCard label="Open tasks" value={totalOpen} sub="pending + working" accent={totalOpen > 0 ? 'blue' : 'gray'} />
            <StatCard label="Blocked" value={totalBlocked} accent={totalBlocked > 0 ? 'red' : 'gray'} />
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
                    <span className="text-xs font-normal text-zinc-500">· {p.repoCount} repo{p.repoCount === 1 ? '' : 's'}</span>
                  </span>
                }
                meta={`${p.open} open · ${p.counts.review} review · ${p.counts.blocked} blocked`}
              >
                <div className="p-4">
                  {p.description && <p className="text-xs text-zinc-500 mb-3">{p.description}</p>}
                  <table className="card-table w-full text-sm">
                    <thead>
                      <tr className="text-left text-[11px] text-zinc-500 border-b border-zinc-800 uppercase tracking-wider">
                        <th className="px-2 py-2 font-medium">Repo</th>
                        <th className="px-2 py-2 font-medium text-right">Pending</th>
                        <th className="px-2 py-2 font-medium text-right">Working</th>
                        <th className="px-2 py-2 font-medium text-right">Review</th>
                        <th className="px-2 py-2 font-medium text-right">Blocked</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800/50">
                      {p.repos.map((r) => (
                        <tr key={r.repo} className="hover:bg-zinc-800/30">
                          <td className="px-2 py-2">
                            <a href={`/work?repo=${encodeURIComponent(r.repo)}`} className="inline-flex items-center gap-2 text-zinc-200 hover:text-teal-300">
                              <LevelDot level={r.level} className="w-2 h-2" />
                              <span className="font-mono text-xs">{r.repo}</span>
                            </a>
                          </td>
                          <td className="px-2 py-2 text-right text-zinc-300 tabular-nums">{r.counts.pending || <span className="text-zinc-700">·</span>}</td>
                          <td className="px-2 py-2 text-right text-blue-400 tabular-nums">{r.counts.working || <span className="text-zinc-700">·</span>}</td>
                          <td className="px-2 py-2 text-right text-purple-400 tabular-nums">{r.counts.review || <span className="text-zinc-700">·</span>}</td>
                          <td className="px-2 py-2 text-right text-red-400 tabular-nums">{r.counts.blocked || <span className="text-zinc-700">·</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>

          {/* Bulk levers — fan-out + reprioritize */}
          <ProjectsConsole repos={consoleRepos} pendingTasks={pendingTasks} />
        </div>
      )}
    </div>
  );
}
