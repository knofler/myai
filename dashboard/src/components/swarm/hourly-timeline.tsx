// HourlyTimeline — "Today by the hour" inside the Swarm Control Room (dashboard
// redesign phase 2b; the operator asked for direction C's swim lanes as a
// segment of A). One row per lane on an hour grid: work spans as bars, merges
// as diamonds, mail and claims as dots, a now-line, and merges counted per
// hour underneath. All geometry comes from lib/swarm-control.ts
// hourlyTimeline(); this file only draws it.
//
// On a phone the grid scrolls sideways inside its own box (never the page). A
// visually hidden list repeats every mark in time order for screen readers.

import { cn } from '@/lib/utils';
import { sydneyTime, type HourlyTimeline as Timeline, type TimelineMark } from '@/lib/swarm-control';

const LANE_COL = 'grid grid-cols-[5rem_minmax(0,1fr)] items-center';

function Mark({ m }: { m: TimelineMark }) {
  const title = `${sydneyTime(m.t)} · ${m.label}`;
  if (m.kind === 'work' && m.width != null) {
    return (
      <span
        title={title}
        className="absolute top-2 h-5 rounded-sm border border-[rgb(var(--accent))] bg-[rgb(var(--accent))]/20"
        style={{ left: `${m.left}%`, width: `${m.width}%` }}
      />
    );
  }
  if (m.kind === 'merge') {
    return (
      <span
        title={title}
        className="absolute top-3 h-2.5 w-2.5 -translate-x-1/2 rotate-45 rounded-[2px] bg-[rgb(var(--warn))]"
        style={{ left: `${m.left}%` }}
      />
    );
  }
  return (
    <span
      title={title}
      className={cn(
        'absolute top-3.5 h-2 w-2 -translate-x-1/2 rounded-full',
        m.kind === 'work' && 'bg-[rgb(var(--accent))]',
        m.kind === 'mail' && 'bg-[rgb(var(--text-muted))]',
        m.kind === 'claim' && 'border border-[rgb(var(--accent))]',
      )}
      style={{ left: `${m.left}%` }}
    />
  );
}

export function HourlyTimeline({ timeline, merged, day }: { timeline: Timeline; merged: number; day: string }) {
  const marks = timeline.rows
    .flatMap((r) => r.marks.map((m) => ({ lane: r.lane, m })))
    .sort((a, b) => a.m.t.localeCompare(b.m.t));

  return (
    <section aria-labelledby="hours-h" className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 id="hours-h" className="text-body font-semibold text-[rgb(var(--text-primary))]">
          Today by the hour
        </h2>
        <span className="text-label text-[rgb(var(--text-muted))]">
          {day} · Sydney · {merged} merged
        </span>
      </div>

      <div className="overflow-x-auto rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))] p-4">
        <div className="min-w-[36rem]" aria-hidden="true">
          <div className={LANE_COL}>
            <span />
            <div className="relative h-4 font-mono text-label tabular-nums text-[rgb(var(--text-muted))]">
              {timeline.hours.map((h) => (
                <span key={h.left} className="absolute -translate-x-1/2" style={{ left: `${h.left}%` }}>
                  {h.label}
                </span>
              ))}
            </div>
          </div>

          {timeline.rows.map((row) => (
            <div key={row.lane} className={cn(LANE_COL, 'h-9 border-t border-[rgb(var(--border-subtle))]')}>
              <span className="truncate text-meta font-medium text-[rgb(var(--text-primary))]">{row.lane}</span>
              <div className="relative h-9">
                {timeline.hours.map((h) => (
                  <span key={h.left} className="absolute inset-y-0 w-px bg-[rgb(var(--border-subtle))]" style={{ left: `${h.left}%` }} />
                ))}
                {row.marks.map((m, i) => (
                  <Mark key={`${m.t}-${i}`} m={m} />
                ))}
                {timeline.now != null && (
                  <span className="absolute inset-y-0 w-0.5 bg-[rgb(var(--err))]" style={{ left: `${timeline.now}%` }} />
                )}
              </div>
            </div>
          ))}

          <div className={cn(LANE_COL, 'border-t border-[rgb(var(--border-subtle))] pt-2')}>
            <span className="text-label text-[rgb(var(--text-muted))]">merged</span>
            <div className="relative h-5 font-mono text-label tabular-nums">
              {timeline.perHour.map((h) => (
                <span
                  key={h.left}
                  className={cn(
                    'absolute -translate-x-1/2',
                    h.merges > 0 ? 'font-semibold text-[rgb(var(--text-primary))]' : 'text-[rgb(var(--text-muted))]',
                  )}
                  style={{ left: `${h.left}%` }}
                >
                  {h.merges}
                </span>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-label text-[rgb(var(--text-muted))]" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2.5 w-3.5 rounded-sm border border-[rgb(var(--accent))] bg-[rgb(var(--accent))]/20" /> lane working
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rotate-45 bg-[rgb(var(--warn))]" /> merge
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-full bg-[rgb(var(--text-muted))]" /> mail
          </span>
          {timeline.now != null && (
            <span className="inline-flex items-center gap-1.5">
              <span className="h-3 w-0.5 bg-[rgb(var(--err))]" /> now
            </span>
          )}
        </div>

        <ul className="sr-only">
          {marks.map(({ lane, m }, i) => (
            <li key={i}>
              {sydneyTime(m.t)}
              {m.width != null && m.kind === 'work' ? ' onwards' : ''}, {lane}: {m.label}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
