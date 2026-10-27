// Swarm Control Room — the data model behind /swarm's default view (dashboard
// redesign phase 2, operator GO 2026-10-21). Mirrors the gateway's `swarm_live`
// aggregate (runtime, phase 1): one read of the coordinator lease, every lane's
// presence, file claims, the mailbox, PR snapshots and today's events. Pure
// logic — no DOM, no fetch — so the derivations are unit-tested and the
// component stays a thin renderer. Distinct from lib/swarm-live.ts, which models
// the older swarm_plan console (now the Plans tab).

export type LaneState = 'busy' | 'idle' | 'unknown';

export interface CoordinatorLease {
  /** Lease key (swarm-coordinator:<host>); absent from gateways before phase 3. */
  key?: string;
  lane: string;
  host: string;
  holder: string;
  epoch: number;
  heartbeatAt: string | null;
  leaseExpiresAt: string | null;
  stale: boolean;
}

export interface LaneRow {
  lane: string;
  host: string;
  state: LaneState;
  lastSeenAt: string | null;
  claimCount: number;
  currentTask?: { id: string; title: string; repo: string };
  branch?: string;
}

export interface ClaimRow {
  /** Lease key (claim:<repo>:<path>); absent from gateways before phase 3. */
  key?: string;
  path: string;
  repo: string;
  holder: string;
  lane: string;
  host: string;
  expiresAt: string;
  heartbeatAt: string | null;
  note?: string;
  stale: boolean;
}

export interface MailRow {
  id: string;
  from: string;
  to: string;
  subject: string;
  kind: string;
  createdAt: string;
  acked: boolean;
}

export type ChecksState = 'pass' | 'fail' | 'pending';

export interface PrRow {
  repo: string;
  number: number;
  title: string;
  base: string;
  head: string;
  state: string;
  checks: ChecksState;
  mergeState: string;
  url: string;
  updatedAt: string;
}

export interface SwarmEvent {
  t: string;
  /** End of a span (a "work" claim held → released). Absent = a point in time. */
  until?: string;
  lane: string;
  kind: 'work' | 'merge' | 'mail' | 'claim';
  label: string;
  ref?: string;
}

export interface SwarmLive {
  generatedAt: string;
  /** YYYY-MM-DD in Australia/Sydney. */
  day: string;
  coordinator: CoordinatorLease | null;
  coordinators: CoordinatorLease[];
  lanes: LaneRow[];
  claims: ClaimRow[];
  mail: { unread: number; recent: MailRow[] };
  prs: PrRow[];
  prsSource: { kind: 'snapshot' | 'unavailable'; asOf: string | null; stale: boolean };
  events: SwarmEvent[];
}

/** What /api/swarm/control returns: the aggregate, or why there isn't one. */
export type SwarmControlResponse =
  | { available: true; live: SwarmLive; fetchedAt: string }
  | { available: false; reason: string; fetchedAt: string };

// ── Operator actions (phase 3) ───────────────────────────────────────────────
// POST /api/swarm/action → the gateway's swarm_action tool, operator-verified
// and audited there. Merge is not a verb: it links out until it can go through
// the ship lock.

export const SWARM_ACTION_VERBS = ['tell', 'ack', 'release_claim', 'handoff', 'stop_swarm'] as const;
export type SwarmActionVerb = (typeof SWARM_ACTION_VERBS)[number];

export type SwarmActionRequest =
  | { verb: 'tell'; to: string; message: string }
  | { verb: 'ack'; messageId: string }
  | { verb: 'release_claim'; key: string; holder: string; reason?: string }
  | { verb: 'handoff'; key: string; holder: string; reason: string; confirm: true }
  | { verb: 'stop_swarm'; swarmId: string; reason?: string; confirm: true };

export type SwarmActionResult =
  | { ok: true; verb: SwarmActionVerb; target: string; result: Record<string, unknown> }
  | { ok: false; code: string; error: string; verb?: string; target?: string };

/** A lane's mailbox: "<host>/<lane>", host lower-cased like every mail address. */
export function laneAddress(l: Pick<LaneRow, 'host' | 'lane'>): string {
  return `${l.host.toLowerCase()}/${l.lane}`;
}

export function claimKey(c: Pick<ClaimRow, 'key' | 'repo' | 'path'>): string {
  return c.key ?? `claim:${c.repo}:${c.path}`;
}

export function coordinatorKey(c: Pick<CoordinatorLease, 'key' | 'host'>): string {
  return c.key ?? `swarm-coordinator:${c.host.toLowerCase()}`;
}

const STATE_ORDER: Record<LaneState, number> = { busy: 0, idle: 1, unknown: 2 };

/**
 * Every Mac runs its own coordinator (active-active), so a lane is "the
 * coordinator" when ANY host's lease names it. `coordinator` alone is just the
 * freshest heartbeat across hosts — the gateway's `coordinators[]` is the list.
 */
export function allCoordinators(live: Pick<SwarmLive, 'coordinator' | 'coordinators'>): CoordinatorLease[] {
  if (live.coordinators?.length) return live.coordinators;
  return live.coordinator ? [live.coordinator] : [];
}

export function isCoordinatorLane(l: Pick<LaneRow, 'lane' | 'host'>, coordinators: CoordinatorLease[]): boolean {
  return coordinators.some((c) => c.lane === l.lane && c.host === l.host);
}

/** Coordinator lanes first, then busy → idle → unknown, then by name. */
export function orderLanes(lanes: LaneRow[], coordinators: CoordinatorLease[]): LaneRow[] {
  const isCoord = (l: LaneRow) => isCoordinatorLane(l, coordinators);
  return [...lanes].sort((a, b) => {
    if (isCoord(a) !== isCoord(b)) return isCoord(a) ? -1 : 1;
    if (STATE_ORDER[a.state] !== STATE_ORDER[b.state]) return STATE_ORDER[a.state] - STATE_ORDER[b.state];
    return a.lane.localeCompare(b.lane) || a.host.localeCompare(b.host);
  });
}

export type NeedKind = 'merge' | 'fix' | 'claim';

export interface Need {
  id: string;
  kind: NeedKind;
  /** ok = ready for you, err = broken, warn = attention. */
  tone: 'ok' | 'err' | 'warn';
  label: string;
  title: string;
  detail: string;
  /** A link-out (PRs — merge stays on GitHub until it goes through the ship lock). */
  href?: string;
  /** An audited in-page action, run through POST /api/swarm/action. */
  act?: SwarmActionRequest;
  action: string;
}

const MERGEABLE = new Set(['clean', 'CLEAN', 'has_hooks', 'HAS_HOOKS', 'unstable', 'UNSTABLE']);

/**
 * What the swarm is waiting on the operator for, most urgent first:
 *  - a PR into main with green checks (only the operator ships to main);
 *  - any open PR whose checks failed (someone has to fix it);
 *  - a file claim whose holder stopped renewing it (it blocks other lanes).
 * PRs into test are the coordinator's to merge and never land here.
 */
export function deriveNeeds(live: Pick<SwarmLive, 'prs' | 'claims'>): Need[] {
  const open = live.prs.filter((p) => p.state.toLowerCase() === 'open');
  const merges: Need[] = open
    .filter((p) => p.base === 'main' && p.checks === 'pass' && MERGEABLE.has(p.mergeState))
    .map((p) => ({
      id: `merge:${p.repo}#${p.number}`,
      kind: 'merge',
      tone: 'ok',
      label: `Merge · ${p.repo}`,
      title: `#${p.number} ${p.head} → ${p.base}`,
      detail: p.title,
      href: p.url,
      action: 'Open PR to merge',
    }));
  const fixes: Need[] = open
    .filter((p) => p.checks === 'fail')
    .map((p) => ({
      id: `fix:${p.repo}#${p.number}`,
      kind: 'fix',
      tone: 'err',
      label: `Checks failing · ${p.repo}`,
      title: `#${p.number} ${p.head} → ${p.base}`,
      detail: p.title,
      href: p.url,
      action: 'Open PR',
    }));
  const claims: Need[] = live.claims
    .filter((c) => c.stale)
    .map((c) => ({
      id: `claim:${c.repo}:${c.path}`,
      kind: 'claim',
      tone: 'warn',
      label: `Stale claim · ${c.repo}`,
      title: c.path,
      detail: `${c.lane} on ${c.host} stopped renewing it${c.note ? ` — ${c.note}` : ''}. Other lanes are warned off this file until it's released.`,
      act: { verb: 'release_claim', key: claimKey(c), holder: c.holder, reason: 'Stale claim released from the dashboard: the holder stopped renewing it.' },
      action: 'Release claim',
    }));
  return [...merges, ...fixes, ...claims];
}

/** "now", "4m", "3h", "2d" — compact age for dense rows. */
export function ageShort(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—';
  const s = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** HH:MM in Sydney — every operator-facing time is Sydney time. */
export function sydneyTime(iso: string): string {
  return new Intl.DateTimeFormat('en-AU', {
    timeZone: 'Australia/Sydney',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

// ── Today by the hour (phase 2b) ─────────────────────────────────────────────

export interface TimelineMark {
  kind: SwarmEvent['kind'];
  label: string;
  t: string;
  /** % from the left edge of the range. */
  left: number;
  /** % width — only for a work span with an `until`; otherwise a point mark. */
  width?: number;
}

export interface HourlyTimeline {
  hours: { label: string; left: number }[];
  /** Merges per hour, centred in each hour's column. */
  perHour: { label: string; left: number; merges: number }[];
  rows: { lane: string; marks: TimelineMark[] }[];
  /** % position of "now", or null when now is outside the range. */
  now: number | null;
}

const HOUR = 3_600_000;
const MIN_HOURS = 3;
/** Narrowest span drawn, in % of the range — a 2-minute claim stays visible. */
const MIN_SPAN_PCT = 0.6;
/** How long after the last event "now" still extends the range. */
const NOW_WINDOW = 12 * HOUR;

/**
 * Lay today's events out on an hour grid: one row per lane (in `laneOrder`,
 * then any lane only the events mention), work spans as bars, merges/mail/
 * claims as points, merges counted per hour. The range runs from the first
 * event's hour to the hour after the later of the last event and `now`, at
 * least MIN_HOURS wide. Hour boundaries are whole-hour epochs, which are also
 * whole hours in Sydney (UTC+10/+11), so the labels stay on the hour.
 */
export function hourlyTimeline(events: SwarmEvent[], laneOrder: string[], now: Date = new Date()): HourlyTimeline | null {
  if (events.length === 0) return null;
  const times = events.flatMap((e) => [Date.parse(e.t), ...(e.until ? [Date.parse(e.until)] : [])]);
  const first = Math.min(...times);
  const last = Math.max(...times);
  // "now" stretches the range only while it's near the events — a page left
  // open into tomorrow must not squash today into a sliver of a 30-hour axis.
  const nowMs = now.getTime();
  const useNow = nowMs >= first && nowMs - last <= NOW_WINDOW;
  const tail = useNow ? Math.max(last, nowMs) : last;
  const start = Math.floor(first / HOUR) * HOUR;
  let end = Math.ceil(tail / HOUR) * HOUR;
  if (end === tail) end += HOUR; // a boundary-exact last point still gets its hour
  end = Math.max(end, start + MIN_HOURS * HOUR);
  const span = end - start;
  const pct = (ms: number) => Math.round(((ms - start) / span) * 1000) / 10;

  const hourCount = Math.round(span / HOUR);
  const hours = Array.from({ length: hourCount + 1 }, (_, i) => ({
    label: hourLabel(start + i * HOUR),
    left: Math.round((i / hourCount) * 1000) / 10,
  }));
  const perHour = Array.from({ length: hourCount }, (_, i) => {
    const from = start + i * HOUR;
    return {
      label: hourLabel(from),
      left: Math.round(((i + 0.5) / hourCount) * 1000) / 10,
      merges: events.filter((e) => e.kind === 'merge' && Date.parse(e.t) >= from && Date.parse(e.t) < from + HOUR).length,
    };
  });

  const lanes = [...laneOrder, ...events.map((e) => e.lane).filter((l) => !laneOrder.includes(l))];
  const rows = [...new Set(lanes)].map((lane) => ({
    lane,
    marks: events
      .filter((e) => e.lane === lane)
      .map((e): TimelineMark => {
        const left = pct(Date.parse(e.t));
        if (e.kind === 'work' && e.until) {
          return { kind: e.kind, label: e.label, t: e.t, left, width: Math.max(MIN_SPAN_PCT, pct(Date.parse(e.until)) - left) };
        }
        return { kind: e.kind, label: e.label, t: e.t, left };
      }),
  }));

  return { hours, perHour, rows, now: useNow ? pct(nowMs) : null };
}

function hourLabel(ms: number): string {
  return new Intl.DateTimeFormat('en-AU', { timeZone: 'Australia/Sydney', hour: '2-digit', hour12: false }).format(new Date(ms));
}

/** The header line: "master on host-a · epoch 1", one entry per host. */
export function coordinatorLine(coordinators: CoordinatorLease[]): string {
  if (coordinators.length === 0) return 'No coordinator — lanes merge their own work';
  return [...coordinators]
    .sort((a, b) => a.host.localeCompare(b.host))
    .map((c) => `${c.lane} on ${c.host} · epoch ${c.epoch}${c.stale ? ' · lease stale' : ''}`)
    .join('  ·  ');
}
