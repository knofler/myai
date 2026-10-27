// A real stage rail from task status — pending=Plan, working=Build, review=Test,
// done=Ship. No invented percentages or ETAs: the queue does not know them.
// Shared by Mission Control's "Currently running" card (task-3c5a06bc) and the
// task detail page (task-0a02236f, plan/design/mockups/03-task-detail.png).
export const STAGES = ['Plan', 'Build', 'Test', 'Ship'] as const;

export function stageIndex(status: string): number {
  return status === 'done' ? 3 : status === 'review' ? 2 : status === 'working' ? 1 : 0;
}

/** Stages fully complete out of STAGES.length — the only percentage this rail
 *  can honestly report, since the queue tracks status, not sub-task completion. */
export function stageProgressPercent(status: string): number {
  if (status === 'done') return 100;
  return Math.round((stageIndex(status) / STAGES.length) * 100);
}

export function StageRail({ status }: { status: string }) {
  const active = stageIndex(status);
  return (
    <ol className="flex items-center gap-1" aria-label="Progress">
      {STAGES.map((s, i) => {
        const done = i < active;
        const now = i === active;
        return (
          <li key={s} className="flex flex-1 items-center gap-1 last:flex-none">
            <span className="flex flex-col items-center gap-1">
              <span
                aria-hidden="true"
                className={`flex h-5 w-5 items-center justify-center rounded-full text-label leading-none ${
                  done
                    ? 'bg-[rgb(var(--ok))]/20 text-[rgb(var(--ok))]'
                    : now
                      ? 'bg-[rgb(var(--accent))] text-[rgb(var(--accent-fg))]'
                      : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-muted))]'
                }`}
              >
                {done ? '✓' : now ? '●' : ''}
              </span>
              <span className={`text-label ${now ? 'text-[rgb(var(--accent))]' : done ? 'text-[rgb(var(--text-secondary))]' : 'text-[rgb(var(--text-muted))]'}`}>
                {s}
                {now && <span className="sr-only"> (current)</span>}
              </span>
            </span>
            {i < STAGES.length - 1 && (
              <span aria-hidden="true" className={`mb-5 h-px flex-1 ${i < active ? 'bg-[rgb(var(--ok))]/50' : 'bg-[rgb(var(--border-strong))]'}`} />
            )}
          </li>
        );
      })}
    </ol>
  );
}
