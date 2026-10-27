'use client';

// Today's swarm pieces (dashboard redesign phase 4): what the swarm is waiting
// on you for, and a one-card summary of who's doing what. Both read the same
// swarm_live snapshot as /swarm's Control Room, with the same Needs-you rules
// (lib/swarm-control deriveNeeds), so a decision appears in the same words on
// both screens.
import Link from 'next/link';
import { SectionHead } from '@/components/ui/section-head';
import { NeedCard } from '@/components/swarm/control-room';
import { useSwarmControl } from '@/components/swarm/use-swarm-control';
import { allCoordinators, deriveNeeds, type SwarmLive } from '@/lib/swarm-control';

const quiet =
  'rounded-2xl bg-[rgb(var(--bg-surface))]/60 px-4 py-5 text-center text-meta text-[rgb(var(--text-muted))]';

export function TodaySwarmNeeds() {
  const data = useSwarmControl();
  const needs = data?.available ? deriveNeeds(data.live) : [];
  return (
    <section aria-labelledby="today-needs-h" className="space-y-3">
      <SectionHead title="Needs you · today" count={needs.length} href="/swarm" linkLabel="Open Swarm ›" tone="warn" />
      {data === null ? (
        <p className={quiet} aria-busy="true">Checking the swarm…</p>
      ) : !data.available ? (
        <p className={quiet}>Swarm decisions appear here once the gateway serves live swarm data.</p>
      ) : needs.length === 0 ? (
        <p className={quiet}>Nothing from the swarm is waiting on you.</p>
      ) : (
        <ul className="space-y-3">
          {needs.map((n) => (
            <NeedCard key={n.id} need={n} />
          ))}
        </ul>
      )}
    </section>
  );
}

function summary(live: SwarmLive) {
  const count = (s: string) => live.lanes.filter((l) => l.state === s).length;
  return {
    coordinators: allCoordinators(live),
    busy: count('busy'),
    idle: count('idle'),
    unknown: count('unknown'),
    claims: live.claims.filter((c) => !c.stale).length,
    unread: live.mail.unread,
  };
}

export function TodaySwarmSummary() {
  const data = useSwarmControl();
  if (!data?.available) return null;
  const s = summary(data.live);
  return (
    <section aria-labelledby="today-swarm-h" className="space-y-3">
      <h2 id="today-swarm-h" className="text-body font-semibold text-[rgb(var(--text-primary))]">
        Swarm
      </h2>
      <Link
        href="/swarm"
        className="tap-press block space-y-2 rounded-2xl border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))] p-4 transition-colors hover:border-[rgb(var(--border-strong))]"
      >
        <p className="text-meta text-[rgb(var(--text-primary))]">
          {s.coordinators.length === 0
            ? 'No coordinator'
            : s.coordinators.map((c) => `${c.lane} on ${c.host}`).join(' · ')}{' '}
          <span className="text-[rgb(var(--text-muted))]">coordinating</span>
        </p>
        <p className="text-meta text-[rgb(var(--text-secondary))]">
          {s.busy} working · {s.idle} idle{s.unknown > 0 ? ` · ${s.unknown} not reporting` : ''}
        </p>
        <p className="text-label text-[rgb(var(--text-muted))]">
          {s.claims} {s.claims === 1 ? 'file' : 'files'} claimed · {s.unread} unread mail
        </p>
        <span className="text-label font-medium text-[rgb(var(--accent))]">Open Swarm →</span>
      </Link>
    </section>
  );
}
