// /work/[taskId] — task detail (plan/design/mockups/03-task-detail.png,
// task-0a02236f): stage rail, "agent is working" card, timestamped activity,
// Pause / View logs actions. Reads the same Task + Artifact collections every
// other /work surface already reads — no new data source, no invented fields
// (there is no live progress-percent on the Task document, so the progress
// bar reports stage completion out of 4, same honesty rule as StageRail).
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connectDB, Task, Artifact } from '@/lib/db';
import { getActiveTenant, tenantFilter } from '@/lib/tenant';
import { timeAgo } from '@/lib/format';
import { PriorityBadge, TaskStatusBadge } from '@/components/ui/badge';
import { Tag } from '@/components/ui/issue-list';
import { TaskArtifactsButton } from '@/components/task-artifacts-drawer';
import { STAGES, StageRail, stageIndex, stageProgressPercent } from '@/components/stage-rail';
import { PageHeader } from '@/components/page-header';
import { plural } from '@/lib/summary';

export const dynamic = 'force-dynamic';

interface TaskDetailDoc {
  taskId: string;
  repo: string;
  title: string;
  description?: string;
  priority: 'P0' | 'P1' | 'P2' | 'P3';
  status: 'pending' | 'working' | 'review' | 'done' | 'blocked' | 'paused' | 'dead_letter';
  assignedAgent?: string;
  recommendedModel?: string;
  prUrl?: string;
  notes?: string;
  startedAt?: Date;
  completedAt?: Date;
  retryCount?: number;
  maxRetries?: number;
  nextRetryAt?: Date;
  deadLetteredAt?: Date;
  lastError?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

interface ArtifactDoc {
  artifactId: string;
  kind: 'diff' | 'build-log' | 'test-report' | 'other';
  filename: string;
  createdAt?: Date;
}

interface ActivityItem {
  at: Date;
  label: string;
}

function buildActivity(task: TaskDetailDoc, artifacts: ArtifactDoc[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  if (task.createdAt) items.push({ at: task.createdAt, label: 'Task queued' });
  if (task.startedAt) items.push({ at: task.startedAt, label: `${task.assignedAgent ?? 'Agent'} started work` });
  for (const a of artifacts) {
    if (!a.createdAt) continue;
    items.push({ at: a.createdAt, label: `Captured ${a.kind.replace(/-/g, ' ')} — ${a.filename}` });
  }
  if (task.completedAt) items.push({ at: task.completedAt, label: 'Marked done' });
  if (task.deadLetteredAt) items.push({ at: task.deadLetteredAt, label: 'Retries exhausted — dead-lettered' });
  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/** The only status that gets the mockup's "Agent is working" card + progress bar. */
function WorkingCard({ task }: { task: TaskDetailDoc }) {
  const stage = STAGES[stageIndex(task.status)];
  const percent = stageProgressPercent(task.status);
  return (
    <div className="rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-4">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-[rgb(var(--accent))]" />
        <p className="text-body font-semibold text-[rgb(var(--text-primary))]">Agent is working</p>
      </div>
      <p className="mt-1 text-meta text-[rgb(var(--text-secondary))]">
        {task.notes?.trim() || `${task.assignedAgent ?? 'Your agent'} is on the ${stage} stage.`}
      </p>
      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-[rgb(var(--bg-hover))]">
        <div className="h-full rounded-full bg-[rgb(var(--accent))] transition-all" style={{ width: `${percent}%` }} />
      </div>
      <p className="mt-1.5 text-label text-[rgb(var(--text-muted))]">{percent}% · {stage} stage complete</p>
    </div>
  );
}

/** Every other status gets a quieter, honest one-liner instead of a fabricated progress bar. */
function StatusCard({ task }: { task: TaskDetailDoc }) {
  const line = (() => {
    switch (task.status) {
      case 'pending':
        return 'Queued — waiting for a free runner window.';
      case 'review':
        return 'Waiting on your review.';
      case 'blocked':
        return task.lastError ? `Blocked: ${task.lastError}` : 'Blocked — needs a decision.';
      case 'paused':
        return 'Paused.';
      case 'done':
        return `Shipped${task.completedAt ? ` · ${timeAgo(task.completedAt)}` : ''}.`;
      case 'dead_letter':
        return `Retries exhausted (${task.retryCount ?? '?'}/${task.maxRetries ?? '?'})${task.lastError ? ` — ${task.lastError}` : ''}.`;
      default:
        return '—';
    }
  })();
  return (
    <div className="rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-4">
      <p className="text-body text-[rgb(var(--text-secondary))]">{line}</p>
      {task.prUrl && (
        <a href={task.prUrl} target="_blank" rel="noreferrer" className="mt-2 inline-block text-meta text-[rgb(var(--accent))] hover:underline">
          View PR →
        </a>
      )}
    </div>
  );
}

/* ── The one-line answer (DESIGN_LANGUAGE §5.1) ─────────────── */

/**
 * This page is ONE task, so the header answer describes THAT task's state in
 * words ("Running now. api-specialist picked this up 12m ago.") rather than a
 * count of anything. Built only from fields already loaded above — no extra
 * query, and no number that isn't on the Task document.
 */
function taskSummary(task: TaskDetailDoc): string {
  const agent = task.assignedAgent;
  switch (task.status) {
    case 'working':
      return task.startedAt
        ? `Running now. ${agent ?? 'Your agent'} picked this up ${timeAgo(task.startedAt)}.`
        : `Running now${agent ? `, assigned to ${agent}` : ''}.`;
    case 'pending':
      return agent
        ? `Queued for ${agent}, waiting for a free runner window.`
        : 'Queued and waiting for a free runner window. Nothing is running on it yet.';
    case 'review':
      return task.prUrl
        ? 'Ready for your review. There is a pull request waiting on you.'
        : 'Ready for your review.';
    case 'blocked':
      return 'Blocked. It needs a decision from you before it can move.';
    case 'paused':
      return 'Paused. It will not move again until you resume it.';
    case 'done':
      return task.completedAt
        ? `Shipped ${timeAgo(task.completedAt)}. Nothing here needs you.`
        : 'Shipped. Nothing here needs you.';
    case 'dead_letter':
      return task.retryCount != null
        ? `Every retry failed after ${plural(task.retryCount, 'attempt')}. This one needs you.`
        : 'Every retry failed, so this stopped. It needs you.';
    default:
      return 'This task has not reported a state yet.';
  }
}

export default async function TaskDetailPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;

  await connectDB();
  const tenantId = await getActiveTenant();
  const tf = tenantFilter(tenantId);

  const task = await Task.findOne({ ...tf, taskId }).lean() as unknown as TaskDetailDoc | null;
  if (!task) notFound();

  const artifacts = await Artifact.find({ ...tf, taskId })
    .select('artifactId kind filename createdAt -_id')
    .sort({ createdAt: 1 })
    .lean() as unknown as ArtifactDoc[];

  const activity = buildActivity(task, artifacts).slice(0, 6);
  const canPause = task.status === 'working';

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex items-center justify-between">
        <Link href="/work" className="text-meta text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))]">
          ← Work
        </Link>
        <div className="flex items-center gap-2">
          <PriorityBadge priority={task.priority} />
          <TaskStatusBadge status={task.status} />
        </div>
      </div>

      <div>
        <PageHeader
          icon="work"
          title={task.title}
          summary={taskSummary(task)}
          subtitle={`${task.assignedAgent ?? 'Unassigned'} · ${timeAgo(task.startedAt ?? task.createdAt)}`}
        />
        {task.description && <p className="text-body text-[rgb(var(--text-secondary))]">{task.description}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Tag>{task.repo}</Tag>
          {task.recommendedModel && <Tag>{task.recommendedModel}</Tag>}
        </div>
      </div>

      <StageRail status={task.status} />

      {task.status === 'working' ? <WorkingCard task={task} /> : <StatusCard task={task} />}

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h2 className="text-body font-semibold text-[rgb(var(--text-primary))]">Latest activity</h2>
          <TaskArtifactsButton taskId={task.taskId} title={task.title} />
        </div>
        {activity.length === 0 ? (
          <p className="rounded-2xl bg-[rgb(var(--bg-surface))]/60 px-4 py-5 text-center text-meta text-[rgb(var(--text-muted))]">
            No activity recorded yet.
          </p>
        ) : (
          <ul className="divide-y divide-[rgb(var(--border-subtle))]/50 rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]">
            {activity.map((e, i) => (
              <li key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span className="w-16 shrink-0 text-label text-[rgb(var(--text-muted))]">{timeAgo(e.at)}</span>
                <span className="text-meta text-[rgb(var(--text-secondary))]">{e.label}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex gap-2 pb-4">
        <button
          type="button"
          disabled={!canPause}
          title={canPause ? "Pause isn't wired up yet" : 'Only a running task can be paused'}
          className="flex min-h-tap flex-1 items-center justify-center gap-1.5 rounded-xl bg-[rgb(var(--bg-hover))] text-meta font-medium text-[rgb(var(--text-secondary))] disabled:cursor-not-allowed disabled:opacity-40"
        >
          ‖ Pause
        </button>
        <Link
          href="/logs"
          className="flex min-h-tap flex-1 items-center justify-center rounded-xl bg-[rgb(var(--accent))] text-meta font-semibold text-[rgb(var(--accent-fg))] transition-opacity hover:opacity-90"
        >
          View logs
        </Link>
      </div>
    </div>
  );
}
