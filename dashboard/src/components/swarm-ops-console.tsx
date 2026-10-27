'use client';

// SwarmOpsConsole — the live /swarm page (P3, Direction A "Ops console").
// Three panels: Swarms (each with its children tree + approve / stop), the
// swarm mailbox (with ack), and an activity feed. Polls /api/swarm every 10s
// while the tab is visible, through an IndexedDB stale-while-revalidate cache
// (@/lib/use-idb-cached-fetch, task-f0ee909e) — a reload paints the last
// snapshot at once instead of the loading skeleton, and a gateway outage
// keeps showing that snapshot with an "offline" badge instead of going blank.
// Every button is a real gateway call through the operator-gated /api/swarm
// routes; nothing is simulated. Below md the three panels collapse into tabs.
// Shaping rules live in @/lib/swarm-live (tested).

import { useCallback, useEffect, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { TONE, type Tone } from '@/components/ui/tone';
import { useToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { useIdbCachedFetch } from '@/lib/use-idb-cached-fetch';
import {
  activity,
  age,
  childDepths,
  childIndex,
  childTone,
  progress,
  swarmActions,
  swarmTone,
  tokens,
  waitingOn,
  type ChildDisplayStatus,
  type MailMessage,
  type SwarmChild,
  type SwarmSnapshot,
  type SwarmWithChildren,
} from '@/lib/swarm-live';

const POLL_MS = 10_000;

type Panel = 'swarms' | 'mail' | 'activity';

function Chip({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return (
    <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap', TONE[tone].box, TONE[tone].glyph)}>
      {children}
    </span>
  );
}

const BTN = 'inline-flex items-center justify-center rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.97]';
const BTN_PRIMARY = `${BTN} bg-teal-500/20 text-teal-200 border border-teal-500/40 hover:bg-teal-500/30`;
const BTN_DANGER = `${BTN} bg-red-500/15 text-red-300 border border-red-500/40 hover:bg-red-500/25`;
const BTN_QUIET = `${BTN} border border-[rgb(var(--border-subtle))] text-[rgb(var(--text-secondary))] hover:text-[rgb(var(--text-primary))]`;

export function SwarmOpsConsole() {
  const { toast } = useToast();
  const { data: snap, fetchedAt, offline, refresh } = useIdbCachedFetch<SwarmSnapshot & { error?: string }>('swarm-console', '/api/swarm', { pollMs: POLL_MS });
  const [busy, setBusy] = useState<string | null>(null);
  const [stopTarget, setStopTarget] = useState<SwarmWithChildren | null>(null);
  const [stopReason, setStopReason] = useState('');
  const [panel, setPanel] = useState<Panel>('swarms');
  const [now, setNow] = useState(() => Date.now());
  // The "updated Xs ago" label ticks forward on every successful poll (same
  // cadence the hand-rolled version used), not on a separate live clock.
  useEffect(() => {
    if (fetchedAt) setNow(Date.now());
  }, [fetchedAt]);

  // gatewayOk:false is an app-level degradation the /api/swarm route already
  // detected (HTTP 200, empty data) — distinct from `offline` (the hook's own
  // fetch/network failure). Both cases keep showing the last good snapshot.
  const loadError = snap && !snap.gatewayOk ? (snap.error ?? 'gateway unreachable') : null;

  const act = useCallback(
    async (key: string, url: string, body: unknown, okTitle: string) => {
      setBusy(key);
      try {
        const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
        toast({ title: okTitle, variant: 'ok' });
        await refresh();
      } catch (err) {
        toast({ title: 'Action failed', description: err instanceof Error ? err.message : String(err), variant: 'err' });
      } finally {
        setBusy(null);
      }
    },
    [refresh, toast],
  );

  const swarms = snap?.swarms ?? [];
  const mail = snap?.mail ?? [];
  const unread = mail.filter((m) => !m.acked).length;
  const awaiting = swarms.filter((s) => s.swarm.status === 'paused').length;
  const running = swarms.filter((s) => s.swarm.status === 'active').length;

  const panels: { id: Panel; label: string; count?: number }[] = [
    { id: 'swarms', label: 'Swarms', count: swarms.length },
    { id: 'mail', label: 'Mailbox', count: unread || undefined },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div className="space-y-4">
      {/* Status strip: the three numbers the operator acts on. */}
      <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
        <Chip tone={running ? 'accent' : 'muted'}>{running} running</Chip>
        <Chip tone={awaiting ? 'warn' : 'muted'}>{awaiting} awaiting approval</Chip>
        <Chip tone={unread ? 'warn' : 'muted'}>{unread} unread mail</Chip>
        <span className="ml-auto text-xs text-[rgb(var(--text-muted))]">
          {offline && snap ? (
            <span className="text-amber-400">Offline · showing cached data from {age(fetchedAt ?? snap.fetchedAt, now)}</span>
          ) : loadError ? (
            <span className="text-[rgb(var(--err))]">Gateway: {loadError}</span>
          ) : snap ? (
            <>
              <span className={cn('mr-2 rounded px-1.5 py-0.5', (snap as { source?: string }).source === 'atlas' ? 'bg-sky-500/15 text-sky-300' : 'bg-teal-500/15 text-teal-300')}>
                {(snap as { source?: string }).source === 'atlas' ? 'Cloud · Atlas' : 'Local gateway'}
              </span>
              <span>Live · updated {age(fetchedAt ?? snap.fetchedAt, now)} · every {POLL_MS / 1000}s</span>
            </>
          ) : (
            'Loading…'
          )}
        </span>
      </div>

      {/* Phone: one panel at a time. */}
      <div role="tablist" aria-label="Swarm panels" className="flex border-b border-[rgb(var(--border-subtle))] md:hidden">
        {panels.map((p) => (
          <button
            key={p.id}
            role="tab"
            aria-selected={panel === p.id}
            onClick={() => setPanel(p.id)}
            className={cn(
              'flex-1 px-2 py-2.5 text-sm border-b-2',
              panel === p.id ? 'border-teal-400 text-[rgb(var(--text-primary))] font-medium' : 'border-transparent text-[rgb(var(--text-muted))]',
            )}
          >
            {p.label}
            {p.count ? <span className="ml-1 text-xs text-[rgb(var(--text-muted))]">{p.count}</span> : null}
          </button>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <div className={cn('lg:col-span-2 min-w-0', panel !== 'swarms' && 'hidden md:block')}>
          <SwarmsPanel
            swarms={swarms}
            loaded={!!snap}
            now={now}
            busy={busy}
            onApprove={(s) => act(`approve:${s.swarm.swarmId}`, `/api/swarm/${s.swarm.swarmId}`, { action: 'approve' }, s.swarm.status === 'stopped' ? 'Swarm resumed' : 'Swarm approved')}
            onStop={(s) => {
              setStopReason('');
              setStopTarget(s);
            }}
          />
        </div>
        <div className="space-y-4 min-w-0">
          <div className={cn(panel !== 'mail' && 'hidden md:block')}>
            <MailPanel mail={mail} now={now} busy={busy} onAck={(m) => act(`ack:${m.messageId}`, `/api/swarm/mail/${m.messageId}`, {}, 'Marked read')} />
          </div>
          <div className={cn(panel !== 'activity' && 'hidden md:block')}>
            <ActivityPanel swarms={swarms} now={now} />
          </div>
        </div>
      </div>

      <Dialog
        open={!!stopTarget}
        onClose={() => setStopTarget(null)}
        title="Stop this swarm?"
        description="Open children go back to paused and no runner can claim them. A child that is mid-run finishes its current session. Everyone involved gets a mail. You can resume later."
        footer={
          <div className="flex justify-end gap-2">
            <button className={BTN_QUIET} onClick={() => setStopTarget(null)}>
              Cancel
            </button>
            <button
              className={BTN_DANGER}
              disabled={!!busy}
              onClick={async () => {
                const s = stopTarget;
                setStopTarget(null);
                if (s) await act(`stop:${s.swarm.swarmId}`, `/api/swarm/${s.swarm.swarmId}`, { action: 'stop', reason: stopReason }, 'Swarm stopped');
              }}
            >
              Stop swarm
            </button>
          </div>
        }
      >
        <p className="text-sm text-[rgb(var(--text-secondary))] mb-2">{stopTarget?.swarm.goal}</p>
        <label className="block text-xs text-[rgb(var(--text-muted))]" htmlFor="stop-reason">
          Reason (included in the mail, optional)
        </label>
        <input
          id="stop-reason"
          value={stopReason}
          onChange={(e) => setStopReason(e.target.value)}
          maxLength={500}
          className="mt-1 w-full rounded-md border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-page))] px-3 py-2 text-sm text-[rgb(var(--text-primary))]"
        />
      </Dialog>
    </div>
  );
}

function SwarmsPanel({
  swarms,
  loaded,
  now,
  busy,
  onApprove,
  onStop,
}: {
  swarms: SwarmWithChildren[];
  loaded: boolean;
  now: number;
  busy: string | null;
  onApprove: (s: SwarmWithChildren) => void;
  onStop: (s: SwarmWithChildren) => void;
}) {
  if (!loaded) {
    return (
      <Card title="Swarms">
        <div className="p-4 space-y-3" aria-busy="true">
          {[0, 1].map((i) => (
            <div key={i} className="h-20 rounded-lg bg-[rgb(var(--bg-hover))] animate-pulse" />
          ))}
        </div>
      </Card>
    );
  }
  if (!swarms.length) {
    return (
      <Card title="Swarms">
        <EmptyState
          title="No swarms yet"
          description={
            <>
              Plan one from any Claude Code session with the myAI MCP tools: <code className="text-xs">swarm_plan</code> with a repo, a goal
              and up to 5 children. It appears here paused, and nothing runs until you approve it.
            </>
          }
        />
      </Card>
    );
  }
  return (
    <Card title="Swarms" meta={`${swarms.length} most recent`}>
      <ul className="divide-y divide-[rgb(var(--border-subtle))]/70">
        {swarms.map((s) => (
          <SwarmItem key={s.swarm.swarmId} s={s} now={now} busy={busy} onApprove={onApprove} onStop={onStop} />
        ))}
      </ul>
    </Card>
  );
}

// ── live animation (real data only; motion-safe: honours reduced motion) ────
const NODE: Record<ChildDisplayStatus, string> = {
  paused: 'bg-amber-500/25 border-amber-400/70 text-amber-200',
  pending: 'bg-[rgb(var(--bg-hover))] border-[rgb(var(--border-subtle))] text-[rgb(var(--text-muted))]',
  running: 'bg-teal-500/30 border-teal-300 text-teal-50',
  done: 'bg-emerald-500/30 border-emerald-400 text-emerald-50',
  blocked: 'bg-red-500/25 border-red-400 text-red-100',
};

/** One node per child in plan order, connected; colours glide as children move paused → running → done. */
function PipelineStrip({ children, idx }: { children: SwarmChild[]; idx: Map<string, number> }) {
  return (
    <div className="mt-3 flex items-center gap-0 overflow-x-auto pb-1" aria-label="Swarm pipeline">
      {children.map((c, i) => (
        <div key={c.taskId} className="flex items-center">
          {i > 0 && (
            <span
              className={cn(
                'h-0.5 w-6 sm:w-10 transition-colors duration-700',
                children[i - 1].displayStatus === 'done' ? 'bg-emerald-400/70' : 'bg-[rgb(var(--border-subtle))]',
              )}
              aria-hidden="true"
            />
          )}
          <span className="relative inline-flex" title={`#${idx.get(c.taskId)} ${c.title} — ${c.displayStatus}`}>
            {c.displayStatus === 'running' && (
              <span className="absolute inset-0 rounded-full bg-teal-400/40 motion-safe:animate-ping" aria-hidden="true" />
            )}
            <span
              className={cn(
                'relative grid h-7 w-7 place-items-center rounded-full border text-xs font-semibold tabular-nums transition-colors duration-700',
                NODE[c.displayStatus],
              )}
            >
              {c.displayStatus === 'done' ? '✓' : idx.get(c.taskId)}
            </span>
          </span>
        </div>
      ))}
    </div>
  );
}

/** A thin bar whose width animates to `value` (0..1). */
function Bar({ value, tone, label, active }: { value: number; tone: 'ok' | 'accent' | 'warn' | 'err'; label: string; active?: boolean }) {
  const fill = { ok: 'bg-emerald-400', accent: 'bg-teal-400', warn: 'bg-amber-400', err: 'bg-red-400' }[tone];
  return (
    <div className="mt-2" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[rgb(var(--bg-hover))]">
        <div
          className={cn('h-full rounded-full transition-[width] duration-700 ease-out', fill, active && 'motion-safe:animate-pulse')}
          style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%` }}
        />
      </div>
    </div>
  );
}

/** True for ~2.5s after a child's status changes between polls — drives the row flash. */
function useJustChanged(children: SwarmChild[]): Set<string> {
  const prev = useRef<Map<string, string>>(new Map());
  const [changed, setChanged] = useState<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of children) {
      const before = prev.current.get(c.taskId);
      if (before && before !== c.displayStatus) next.add(c.taskId);
      prev.current.set(c.taskId, c.displayStatus);
    }
    if (next.size === 0) return;
    setChanged(next);
    const t = setTimeout(() => setChanged(new Set()), 2500);
    return () => clearTimeout(t);
  }, [children]);
  return changed;
}

function SwarmItem({
  s,
  now,
  busy,
  onApprove,
  onStop,
}: {
  s: SwarmWithChildren;
  now: number;
  busy: string | null;
  onApprove: (s: SwarmWithChildren) => void;
  onStop: (s: SwarmWithChildren) => void;
}) {
  const { swarm, children } = s;
  const live = swarm.status === 'active' || swarm.status === 'paused';
  const [open, setOpen] = useState(live);
  // Follow the swarm's state: expand when it goes live, collapse when it finishes.
  useEffect(() => setOpen(live), [live]);
  const actions = swarmActions(swarm.status);
  const p = progress(children);
  const depth = childDepths(children);
  const idx = childIndex(children);
  const justChanged = useJustChanged(children);
  const spent = swarm.tokenSpent ?? 0;
  const budget = swarm.tokenBudget ?? 0;

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="min-w-0 flex-1 text-left"
        >
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone={swarmTone(swarm.status)}>{swarm.status}</Chip>
            <span className="text-sm font-medium text-[rgb(var(--text-primary))] break-words">{swarm.goal}</span>
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-[rgb(var(--text-muted))]">
            <span>{swarm.repo}</span>
            {s.detail === 'error' ? (
              <span className="text-[rgb(var(--err))]">children failed to load</span>
            ) : s.detail === 'omitted' ? (
              <span>{swarm.childCount} children</span>
            ) : (
              <span>
                {p.done}/{p.total} done
              </span>
            )}
            <span>{tokens(swarm.tokenSpent, swarm.tokenBudget)}</span>
            <span>planned {age(swarm.createdAt, now)}</span>
            <span className="font-mono">{swarm.swarmId.slice(0, 14)}</span>
          </div>
        </button>
        <div className="flex gap-2">
          {actions.approve && (
            <button className={BTN_PRIMARY} disabled={!!busy} onClick={() => onApprove(s)}>
              {busy === `approve:${swarm.swarmId}` ? 'Working…' : actions.approveLabel}
            </button>
          )}
          {actions.stop && (
            <button className={BTN_DANGER} disabled={!!busy} onClick={() => onStop(s)}>
              {busy === `stop:${swarm.swarmId}` ? 'Stopping…' : 'Stop'}
            </button>
          )}
        </div>
      </div>

      {children.length > 0 && (
        <>
          <PipelineStrip children={children} idx={idx} />
          <Bar value={p.total ? p.done / p.total : 0} tone={swarm.status === 'stopped' ? 'err' : p.done === p.total ? 'ok' : 'accent'}
               label={`${p.done} of ${p.total} children done`} active={swarm.status === 'active'} />
        </>
      )}
      {budget > 0 && (
        <Bar value={spent / budget} tone={spent >= budget ? 'err' : spent / budget > 0.8 ? 'warn' : 'ok'}
             label={`${tokens(spent, budget)} of token budget`} />
      )}

      {open && children.length > 0 && (
        <ol className="mt-3 space-y-1.5">
          {children.map((c) => {
            const waits = c.displayStatus === 'pending' ? waitingOn(c, children) : [];
            return (
              <li
                key={c.taskId}
                style={{ marginLeft: `${Math.min(depth.get(c.taskId) ?? 0, 4) * 1.25}rem` }}
                className={cn(
                  'flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-[rgb(var(--bg-hover))]/60 px-3 py-2 text-sm transition-shadow duration-700',
                  c.displayStatus === 'running' && 'border-l-2 border-teal-400',
                  justChanged.has(c.taskId) && 'ring-2 ring-teal-300/70 motion-safe:animate-pulse',
                )}
              >
                <span className="text-xs text-[rgb(var(--text-muted))] tabular-nums">#{idx.get(c.taskId)}</span>
                <Chip tone={childTone(c.displayStatus)}>{c.displayStatus}</Chip>
                <span className="min-w-0 flex-1 break-words text-[rgb(var(--text-primary))]">{c.title}</span>
                <span className="text-xs text-[rgb(var(--text-muted))]">
                  {[c.assignedAgent, c.priority, c.claimedBy].filter(Boolean).join(' · ')}
                  {waits.length > 0 && <> · waits on {waits.map((w) => `#${idx.get(w) ?? '?'}`).join(', ')}</>}
                </span>
                {c.prUrl && (
                  <a href={c.prUrl} target="_blank" rel="noreferrer" className="text-xs text-teal-300 underline">
                    PR
                  </a>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </li>
  );
}

function MailPanel({ mail, now, busy, onAck }: { mail: MailMessage[]; now: number; busy: string | null; onAck: (m: MailMessage) => void }) {
  return (
    <Card title="Mailbox" meta={mail.length ? `${mail.filter((m) => !m.acked).length} unread` : undefined}>
      {mail.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[rgb(var(--text-muted))]">No mail for the people in these swarms.</p>
      ) : (
        <ul className="divide-y divide-[rgb(var(--border-subtle))]/70 max-h-[28rem] overflow-y-auto">
          {mail.map((m) => (
            <li key={m.messageId} className="px-4 py-3">
              <div className="flex items-start gap-2">
                <span
                  className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', m.acked ? 'bg-transparent' : 'bg-[rgb(var(--warn))]')}
                  aria-label={m.acked ? 'read' : 'unread'}
                />
                <div className="min-w-0 flex-1">
                  <p className={cn('text-sm break-words', m.acked ? 'text-[rgb(var(--text-secondary))]' : 'text-[rgb(var(--text-primary))] font-medium')}>{m.subject}</p>
                  <p className="mt-0.5 text-xs text-[rgb(var(--text-muted))] break-words">
                    {m.from} → {m.to} · {age(m.createdAt, now)}
                  </p>
                </div>
                {!m.acked && (
                  <button className={BTN_QUIET} disabled={!!busy} onClick={() => onAck(m)}>
                    {busy === `ack:${m.messageId}` ? '…' : 'Ack'}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ActivityPanel({ swarms, now }: { swarms: SwarmWithChildren[]; now: number }) {
  const feed = activity(swarms);
  return (
    <Card title="Activity">
      {feed.length === 0 ? (
        <p className="px-4 py-6 text-sm text-[rgb(var(--text-muted))]">Nothing has happened yet.</p>
      ) : (
        <ul className="max-h-[28rem] overflow-y-auto px-4 py-2">
          {feed.map((e, i) => (
            <li key={`${e.swarmId}-${e.at}-${i}`} className="flex items-start gap-2 py-1.5 text-sm">
              <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', TONE[e.tone].box.replace('/15', ''))} aria-hidden="true" />
              <span className="min-w-0 flex-1 break-words text-[rgb(var(--text-secondary))]">{e.text}</span>
              <span className="shrink-0 text-xs text-[rgb(var(--text-muted))]">{age(e.at, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
