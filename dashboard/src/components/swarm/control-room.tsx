'use client';

// SwarmControlRoom — /swarm's default view (dashboard redesign phase 2,
// direction A). Who is coordinating, what each lane is doing, what the swarm is
// waiting on you for, and the mail between lanes — one screen, polled every
// 10s from GET /api/swarm/control (the gateway's swarm_live aggregate).
//
// Actions (phase 3) go through POST /api/swarm/action → the gateway's
// swarm_action: message a lane, mark mail read, release a stale claim, hand a
// coordinator off (confirm step + reason). Each needs an operator sign-in and
// is audited in the gateway. Merge stays a link to the PR on GitHub until it
// can go through the ship lock.

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { EmptyState } from '@/components/ui/card';
import { SectionHead } from '@/components/ui/section-head';
import { HourlyTimeline } from '@/components/swarm/hourly-timeline';
import { useSwarmAction, type ActionNotice } from '@/components/swarm/use-swarm-action';
import { TONE } from '@/components/ui/tone';
import { cn } from '@/lib/utils';
import {
  ageShort,
  allCoordinators,
  coordinatorKey,
  coordinatorLine,
  isCoordinatorLane,
  laneAddress,
  deriveNeeds,
  hourlyTimeline,
  orderLanes,
  sydneyTime,
  type CoordinatorLease,
  type LaneRow,
  type MailRow,
  type Need,
  type SwarmControlResponse,
  type SwarmActionRequest,
  type SwarmLive,
} from '@/lib/swarm-control';

const POLL_MS = 10_000;

const STATE_STYLE: Record<LaneRow['state'], { dot: string; label: string }> = {
  busy: { dot: 'bg-[rgb(var(--accent))]', label: 'Working' },
  idle: { dot: 'bg-[rgb(var(--text-muted))]', label: 'Idle' },
  unknown: { dot: 'border border-dashed border-[rgb(var(--text-muted))]', label: 'No heartbeat' },
};

const panel = 'rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-raised))]';
const btn =
  'inline-flex min-h-tap items-center justify-center rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] px-3 text-meta font-medium text-[rgb(var(--text-primary))] transition-colors hover:bg-[rgb(var(--bg-hover))]';

export function SwarmControlRoom() {
  const [data, setData] = useState<SwarmControlResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  const load = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(`/api/swarm/control${fresh ? '?fresh=1' : ''}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as SwarmControlResponse;
      if (mounted.current) {
        setData(body);
        setFailed(false);
      }
    } catch {
      if (mounted.current) setFailed(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    const t = setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [load]);

  const refresh = useCallback(() => void load(true), [load]);
  const action = useSwarmAction(refresh);

  if (!data) {
    return failed ? (
      <EmptyState>The dashboard couldn’t load swarm data. It retries every 10 seconds.</EmptyState>
    ) : (
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-busy="true" aria-label="Loading lanes">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={cn(panel, 'h-40 animate-pulse')} />
        ))}
      </div>
    );
  }

  if (!data.available) {
    return (
      <EmptyState>
        <span className="block font-medium text-[rgb(var(--text-primary))]">Live lanes aren’t available</span>
        <span className="mt-1 block">{data.reason}</span>
        <Link href="/swarm?tab=plans" className="mt-3 inline-block text-[rgb(var(--accent))] hover:underline">
          See planned swarms instead →
        </Link>
      </EmptyState>
    );
  }

  return (
    <ControlRoomView
      live={data.live}
      fetchedAt={data.fetchedAt}
      run={action.run}
      pending={action.pending}
      notice={action.notice}
      onDismiss={action.clearNotice}
    />
  );
}

type Run = (id: string, req: SwarmActionRequest) => Promise<boolean>;

function ControlRoomView({
  live,
  fetchedAt,
  run,
  pending,
  notice,
  onDismiss,
}: {
  live: SwarmLive;
  fetchedAt: string;
  run: Run;
  pending: string | null;
  notice: ActionNotice | null;
  onDismiss: () => void;
}) {
  const coordinators = allCoordinators(live);
  const lanes = orderLanes(live.lanes, coordinators);
  const needs = deriveNeeds(live);
  const activeClaims = live.claims.filter((c) => !c.stale).length;
  const events = [...live.events].reverse().slice(0, 12);
  const timeline = hourlyTimeline(live.events, lanes.map((l) => l.lane));
  const merged = live.events.filter((e) => e.kind === 'merge').length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-meta text-[rgb(var(--text-secondary))]">
        <span>
          {coordinators.length > 1 ? 'Coordinators' : 'Coordinator'}{' '}
          <strong className="font-semibold text-[rgb(var(--text-primary))]">{coordinatorLine(coordinators)}</strong>
        </span>
        <span>
          {lanes.length} lanes · {activeClaims} {activeClaims === 1 ? 'file' : 'files'} claimed · {live.mail.unread} unread mail
        </span>
        <span className="text-[rgb(var(--text-muted))]" aria-live="polite">
          Updated {sydneyTime(fetchedAt)} · every 10s
        </span>
      </div>

      {notice && <NoticeBar notice={notice} onDismiss={onDismiss} />}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(280px,340px)]">
        <div className="min-w-0 space-y-6">
          <section aria-labelledby="lanes-h" className="space-y-3">
            <h2 id="lanes-h" className="text-body font-semibold text-[rgb(var(--text-primary))]">
              Lanes
            </h2>
            {lanes.length === 0 ? (
              <EmptyState>No lane has reported in yet. Lanes appear here when their session starts its swarm tick.</EmptyState>
            ) : (
              <ul className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">
                {lanes.map((l) => (
                  <LaneCard
                    key={`${l.host}/${l.lane}`}
                    lane={l}
                    coordinator={coordinators.find((c) => isCoordinatorLane(l, [c]))}
                    run={run}
                    pending={pending}
                  />
                ))}
              </ul>
            )}
          </section>

          {timeline && <HourlyTimeline timeline={timeline} merged={merged} day={live.day} />}

          <section aria-labelledby="activity-h" className="space-y-3">
            <h2 id="activity-h" className="text-body font-semibold text-[rgb(var(--text-primary))]">
              Today’s activity
            </h2>
            {events.length === 0 ? (
              <EmptyState>Nothing yet today ({live.day}).</EmptyState>
            ) : (
              <ol className={cn(panel, 'divide-y divide-[rgb(var(--border-subtle))]')}>
                {events.map((e, i) => (
                  <li key={`${e.t}-${i}`} className="flex gap-3 px-4 py-2.5 text-meta">
                    <span className="w-12 shrink-0 font-mono tabular-nums text-[rgb(var(--text-muted))]">{sydneyTime(e.t)}</span>
                    <span className="w-20 shrink-0 font-medium text-[rgb(var(--accent))]">{e.lane}</span>
                    <span className="min-w-0 text-[rgb(var(--text-secondary))]">{e.label}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        {/* Below lg the rail stacks ABOVE the lanes: on a phone the first thing
            on screen is what's waiting on you, not four lane cards. */}
        <aside className="order-first min-w-0 space-y-6 lg:order-none">
          <section aria-labelledby="needs-h" className="space-y-3">
            <SectionHead title="Needs you" count={needs.length} tone="warn" />
            {needs.length === 0 ? (
              <EmptyState>Nothing is waiting on you.</EmptyState>
            ) : (
              <ul className="space-y-3">
                {needs.map((n) => (
                  <NeedCard key={n.id} need={n} busy={pending === n.id} onAct={(need) => need.act && void run(need.id, need.act)} />
                ))}
              </ul>
            )}
            {live.prsSource.kind === 'unavailable' && (
              <p className="text-label text-[rgb(var(--text-muted))]">
                Pull requests aren’t included: no PR snapshot on this Mac yet.
              </p>
            )}
            {live.prsSource.kind === 'snapshot' && live.prsSource.stale && live.prsSource.asOf && (
              <p className="text-label text-[rgb(var(--warn))]">Pull requests as of {sydneyTime(live.prsSource.asOf)} — snapshot is stale.</p>
            )}
          </section>

          <section aria-labelledby="mail-h" className="space-y-3">
            <SectionHead title="Mail" count={live.mail.unread} tone="accent" />
            {live.mail.recent.length === 0 ? (
              <EmptyState>No mail between lanes yet.</EmptyState>
            ) : (
              <ul className={cn(panel, 'divide-y divide-[rgb(var(--border-subtle))]')}>
                {live.mail.recent.slice(0, 8).map((m) => (
                  <MailItem
                    key={m.id}
                    mail={m}
                    busy={pending === m.id}
                    onAck={(id) => void run(id, { verb: 'ack', messageId: id })}
                  />
                ))}
              </ul>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function NoticeBar({ notice, onDismiss }: { notice: ActionNotice; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className={cn(
        panel,
        'flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-meta',
        notice.tone === 'ok' ? 'border-[rgb(var(--ok))]/50' : 'border-[rgb(var(--err))]/50',
      )}
    >
      <span className={cn('min-w-0 break-words', TONE[notice.tone].glyph)}>{notice.text}</span>
      {notice.signIn && (
        <Link href="/operator-login?next=/swarm" className="font-medium text-[rgb(var(--accent))] hover:underline">
          Sign in as operator →
        </Link>
      )}
      <button type="button" onClick={onDismiss} className="ml-auto text-label text-[rgb(var(--text-muted))] hover:underline">
        Dismiss
      </button>
    </div>
  );
}

function seenText(iso: string | null): string {
  if (!iso) return 'never';
  const age = ageShort(iso);
  return age === 'now' ? 'just now' : `${age} ago`;
}

const field =
  'w-full rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-base))] px-3 py-2 text-meta text-[rgb(var(--text-primary))] placeholder:text-[rgb(var(--text-muted))] focus:outline-none focus:ring-2 focus:ring-[rgb(var(--accent))]';
const dangerBtn =
  'inline-flex min-h-tap items-center justify-center rounded-[var(--radius)] bg-[rgb(var(--err))] px-3 text-meta font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50';

function LaneCard({
  lane,
  coordinator,
  run,
  pending,
}: {
  lane: LaneRow;
  coordinator?: CoordinatorLease;
  run: Run;
  pending: string | null;
}) {
  const s = STATE_STYLE[lane.state];
  const to = laneAddress(lane);
  const [mode, setMode] = useState<'none' | 'tell' | 'handoff'>('none');
  const [text, setText] = useState('');
  const tellId = `tell:${to}`;
  const handoffId = `handoff:${to}`;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const value = text.trim();
    if (!value) return;
    const ok =
      mode === 'tell'
        ? await run(tellId, { verb: 'tell', to, message: value })
        : coordinator
          ? await run(handoffId, { verb: 'handoff', key: coordinatorKey(coordinator), holder: coordinator.holder, reason: value, confirm: true })
          : false;
    if (ok) {
      setText('');
      setMode('none');
    }
  }

  const busy = pending === tellId || pending === handoffId;

  return (
    <li className={cn(panel, 'flex min-w-0 flex-col gap-3 p-4')}>
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className={cn('h-2.5 w-2.5 shrink-0 rounded-full', s.dot)} />
        <h3 className="text-body font-semibold text-[rgb(var(--text-primary))]">{lane.lane}</h3>
        <span
          className={cn(
            'ml-auto rounded-full px-2 py-0.5 text-label font-semibold',
            coordinator ? cn(TONE.warn.box, TONE.warn.glyph) : 'bg-[rgb(var(--bg-hover))] text-[rgb(var(--text-secondary))]',
          )}
        >
          {coordinator ? 'Coordinator' : s.label}
        </span>
      </div>
      <p className="text-meta text-[rgb(var(--text-secondary))]">
        {lane.currentTask ? (
          <>
            {lane.currentTask.title} <span className="text-[rgb(var(--text-muted))]">· {lane.currentTask.repo}</span>
          </>
        ) : lane.state === 'busy' ? (
          'Working on claimed files.'
        ) : lane.state === 'idle' ? (
          'Waiting for work.'
        ) : (
          'Not reporting — its session may be closed or on an older tick.'
        )}
      </p>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-label">
        <dt className="text-[rgb(var(--text-muted))]">Host</dt>
        <dd className="text-[rgb(var(--text-secondary))]">{lane.host}</dd>
        {lane.branch && (
          <>
            <dt className="text-[rgb(var(--text-muted))]">Branch</dt>
            <dd className="truncate font-mono text-[rgb(var(--text-secondary))]" title={lane.branch}>
              {lane.branch}
            </dd>
          </>
        )}
        <dt className="text-[rgb(var(--text-muted))]">Claims</dt>
        <dd className="text-[rgb(var(--text-secondary))]">{lane.claimCount === 0 ? 'none' : lane.claimCount}</dd>
        <dt className="text-[rgb(var(--text-muted))]">Seen</dt>
        <dd className="text-[rgb(var(--text-secondary))]">{seenText(lane.lastSeenAt)}</dd>
      </dl>

      {mode === 'none' ? (
        <div className="mt-auto flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => setMode('tell')}>
            Message
          </button>
          {coordinator && (
            <button type="button" className={btn} onClick={() => setMode('handoff')}>
              Hand off…
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={submit} className="mt-auto space-y-2">
          {mode === 'handoff' && (
            <p className="text-label text-[rgb(var(--warn))]">
              {lane.lane} stops coordinating {lane.host}. Merges wait until another session takes the lease. {lane.lane} is mailed your reason.
            </p>
          )}
          <label className="sr-only" htmlFor={`${mode}-${to}`}>
            {mode === 'tell' ? `Message to ${to}` : 'Reason for the hand-off'}
          </label>
          <textarea
            id={`${mode}-${to}`}
            rows={2}
            maxLength={2000}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={mode === 'tell' ? `Message ${to}…` : 'Why it’s stepping down (required)'}
            className={field}
            autoFocus
          />
          <div className="flex flex-wrap gap-2">
            <button type="submit" disabled={busy || !text.trim()} className={mode === 'handoff' ? dangerBtn : cn(btn, 'disabled:opacity-50')}>
              {busy ? 'Sending…' : mode === 'tell' ? 'Send' : 'Hand off'}
            </button>
            <button
              type="button"
              className={btn}
              onClick={() => {
                setMode('none');
                setText('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </li>
  );
}

const NEED_EDGE: Record<Need['tone'], string> = {
  ok: 'border-[rgb(var(--ok))]/50',
  err: 'border-[rgb(var(--err))]/50',
  warn: 'border-[rgb(var(--warn))]/50',
};

/**
 * One "Needs you" item — shared with Today's swarm decisions (phase 4). With
 * `onAct` an in-page action is a button; without it (Today) the action links
 * to /swarm, where it runs.
 */
export function NeedCard({ need, onAct, busy = false }: { need: Need; onAct?: (need: Need) => void; busy?: boolean }) {
  return (
    <li className={cn(panel, NEED_EDGE[need.tone], 'space-y-2 p-4')}>
      <p className={cn('text-label font-semibold', TONE[need.tone].glyph)}>{need.label}</p>
      <p className="text-meta font-semibold text-[rgb(var(--text-primary))]">{need.title}</p>
      <p className="text-meta text-[rgb(var(--text-secondary))]">{need.detail}</p>
      {need.act && onAct ? (
        <button type="button" disabled={busy} onClick={() => onAct(need)} className={cn(btn, 'disabled:opacity-60')}>
          {busy ? 'Working…' : need.action}
        </button>
      ) : need.act ? (
        <Link href="/swarm" className={btn}>
          {need.action} on Swarm →
        </Link>
      ) : need.href ? (
        <a href={need.href} target="_blank" rel="noreferrer" className={btn}>
          {need.action} ↗
        </a>
      ) : (
        <p className="text-label text-[rgb(var(--text-muted))]">{need.action}</p>
      )}
    </li>
  );
}

function MailItem({ mail, busy, onAck }: { mail: MailRow; busy: boolean; onAck: (id: string) => void }) {
  return (
    <li className="space-y-1 px-4 py-3">
      <p className="text-label text-[rgb(var(--text-muted))]">
        {mail.from} → {mail.to} · {sydneyTime(mail.createdAt)}
      </p>
      <p className={cn('text-meta', mail.acked ? 'text-[rgb(var(--text-secondary))]' : 'font-medium text-[rgb(var(--text-primary))]')}>
        {mail.subject}
      </p>
      {!mail.acked && (
        <button
          type="button"
          disabled={busy}
          onClick={() => onAck(mail.id)}
          className="inline-flex items-center rounded-[var(--radius)] border border-[rgb(var(--border-subtle))] px-2.5 py-1 text-label font-medium text-[rgb(var(--text-primary))] transition-colors hover:bg-[rgb(var(--bg-hover))] disabled:opacity-60"
        >
          {busy ? 'Marking read…' : 'Mark read'}
        </button>
      )}
    </li>
  );
}
