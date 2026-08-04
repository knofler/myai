// False-healthy empty-queue detector (pure, DOM-free) — the dashboard-side twin
// of scripts/false_healthy_queue.sh. Cross-references gateway task totals
// against each repo's last-commit timestamp to catch a blind spot the queue
// depth alone can't see: a repo showing 0 pending / 0 review / 0 blocked / 0
// working reads as "fully caught up" on /fleet — but that's indistinguishable
// from a runner that quietly stopped picking up work for that repo weeks ago.
// runner-repo-staleness (scripts/runner_repo_staleness.sh) already covers the
// OTHER half — a queue that HAS pending work but the runner-log hasn't moved.
// This module covers the empty-queue half: same signal shape, opposite trigger.

export interface QueueTaskLike {
  repo: string;
  status: string;
}

const QUEUE_STATUSES = new Set(['pending', 'review', 'blocked', 'working']);

export interface QueueCounts {
  pending: number;
  review: number;
  blocked: number;
  working: number;
}

function emptyCounts(): QueueCounts {
  return { pending: 0, review: 0, blocked: 0, working: 0 };
}

/** Per-repo pending/review/blocked/working counts from one unfiltered tasks_list call. */
export function buildQueueCountsByRepo(tasks: QueueTaskLike[]): Record<string, QueueCounts> {
  const out: Record<string, QueueCounts> = {};
  for (const t of tasks) {
    if (!t.repo || !QUEUE_STATUSES.has(t.status)) continue;
    const counts = (out[t.repo] ??= emptyCounts());
    counts[t.status as keyof QueueCounts] += 1;
  }
  return out;
}

export function isQueueEmpty(counts: QueueCounts | undefined): boolean {
  if (!counts) return true;
  return counts.pending + counts.review + counts.blocked + counts.working === 0;
}

export interface FalseHealthyRow {
  repo: string;
  counts: QueueCounts;
  queueEmpty: boolean;
  lastCommitAt: string | Date | null;
  ageDays: number | null;
  falseHealthy: boolean;
}

const DEFAULT_STALE_DAYS = 14;

/**
 * Flags repos where the queue LOOKS caught up (all four statuses at 0) but the
 * repo hasn't shipped a commit in `staleDays` (default 14) — or has never
 * committed at all, which is treated as maximally stale. `lastCommitByRepo`
 * is caller-supplied (git ground truth — a `false_healthy_queue.sh` sweep or
 * equivalent), since the gateway task store has no notion of a repo's commits.
 */
export function buildFalseHealthyRows(
  tasks: QueueTaskLike[],
  lastCommitByRepo: Record<string, string | Date | null | undefined>,
  opts: { staleDays?: number; now?: Date } = {},
): FalseHealthyRow[] {
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const now = opts.now ?? new Date();
  const countsByRepo = buildQueueCountsByRepo(tasks);

  // Union of repos we have a queue signal for AND repos we have a commit signal
  // for — a repo with zero tasks ever is still worth checking against its git age.
  const repos = new Set<string>([...Object.keys(countsByRepo), ...Object.keys(lastCommitByRepo)]);

  const rows: FalseHealthyRow[] = [];
  for (const repo of repos) {
    const counts = countsByRepo[repo] ?? emptyCounts();
    const queueEmpty = isQueueEmpty(counts);
    const lastCommitAt = lastCommitByRepo[repo] ?? null;

    let ageDays: number | null = null;
    let stale = true; // no commit info at all → treat as maximally stale
    if (lastCommitAt) {
      const lastTs = new Date(lastCommitAt).getTime();
      if (!Number.isNaN(lastTs)) {
        ageDays = Math.round(((now.getTime() - lastTs) / 86_400_000) * 10) / 10;
        stale = ageDays >= staleDays;
      }
    }

    rows.push({
      repo,
      counts,
      queueEmpty,
      lastCommitAt,
      ageDays,
      falseHealthy: queueEmpty && stale,
    });
  }

  rows.sort((a, b) => a.repo.localeCompare(b.repo));
  return rows;
}

/** Convenience: just the rows that ARE false-healthy, for a dashboard alert strip. */
export function buildFalseHealthyAlerts(
  tasks: QueueTaskLike[],
  lastCommitByRepo: Record<string, string | Date | null | undefined>,
  opts: { staleDays?: number; now?: Date } = {},
): FalseHealthyRow[] {
  return buildFalseHealthyRows(tasks, lastCommitByRepo, opts).filter((r) => r.falseHealthy);
}
