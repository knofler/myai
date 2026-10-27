// live-aggregate.ts — `swarm_live`: one READ-ONLY snapshot of the running swarm
// for the dashboard "Control Room" (dashboard redesign phase 1).
//
// Every section reuses an existing tenant-scoped store — keyed leases
// (coordinator / claim / lane presence), the durable mailbox, the task store —
// so ADR-010 §3.4 scoping is inherited, never re-implemented. PRs are the one
// exception: the gateway is token-free and never calls GitHub, so they come
// from a host-written snapshot (scripts/swarm_prs_snapshot.sh →
// state/swarm/prs.json, read through the /app/AI mount). That file is the
// HOST operator's data, so it is served to the default tenant only.
//
// Lane presence is derived, never guessed:
//   busy    — the lane holds ≥1 non-stale claim lease
//   idle    — a fresh `lane:<host>:<lane>` presence lease (or the coordinator
//             lease), no claims
//   unknown — nothing fresh heartbeats that lane
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { listKeyedLeases, type KeyedLeaseView } from '../tasks/keyed-lease-store.js';
import { recentMail, type MailboxMessageView } from '../notifications/mailbox-store.js';
import { listTasks, type TaskView } from '../tasks/task-store.js';
import { getConfig } from '../shared/config.js';
import { parseLaneList } from './roles.js';

export const SWARM_LIVE_TIMEZONE = 'Australia/Sydney';
export const COORDINATOR_PREFIX = 'swarm-coordinator:';
export const CLAIM_PREFIX = 'claim:';
export const PRESENCE_PREFIX = 'lane:';
export const RECENT_MAIL_LIMIT = 20;
/** GET /api/swarm/live/stream pushes one frame this often. */
export const SWARM_LIVE_STREAM_INTERVAL_MS = 10_000;
/** A snapshot older than this is flagged `stale` (the writer runs ≤1/min). */
export const PR_SNAPSHOT_STALE_MS = 10 * 60_000;
/** Relative to the AI root; the gateway sees it at /app/AI/state/swarm/prs.json. */
export const PR_SNAPSHOT_RELPATH = 'state/swarm/prs.json';

export type LaneState = 'busy' | 'idle' | 'unknown';
export type PrChecks = 'pass' | 'fail' | 'pending';
export type SwarmEventKind = 'work' | 'merge' | 'mail' | 'claim';

export interface SwarmLiveCoordinator {
  /** The lease key — what swarm_action handoff takes. */
  key: string;
  lane: string;
  host: string;
  holder: string;
  epoch: number;
  heartbeatAt: string;
  leaseExpiresAt: string;
  stale: boolean;
}

export interface SwarmLiveLane {
  lane: string;
  host: string;
  state: LaneState;
  lastSeenAt: string | null;
  claimCount: number;
  currentTask?: { id: string; title: string; repo: string };
  branch?: string;
}

export interface SwarmLiveClaim {
  /** The lease key — what swarm_action release_claim takes. */
  key: string;
  path: string;
  repo: string;
  holder: string;
  lane: string;
  host: string;
  expiresAt: string;
  heartbeatAt: string;
  note: string;
  stale: boolean;
}

export interface SwarmLiveMail {
  id: string;
  from: string;
  to: string;
  subject: string;
  kind: string;
  createdAt: string;
  acked: boolean;
}

export interface SwarmLivePr {
  repo: string;
  number: number;
  title: string;
  base: string;
  head: string;
  state: string;
  checks: PrChecks;
  mergeState: string;
  url: string;
  updatedAt: string;
  mergedAt?: string;
}

export interface SwarmLiveEvent {
  t: string;
  /** Set only on `work` spans that have ended; absent = a point (or a span still open). Never invented. */
  until?: string;
  lane: string;
  kind: SwarmEventKind;
  label: string;
  ref: string;
}

/** The whole `swarm_live` payload — mirrored by the dashboard (dashboard/src/lib). */
export interface SwarmLive {
  generatedAt: string;
  day: string;
  coordinator: SwarmLiveCoordinator | null;
  coordinators: SwarmLiveCoordinator[];
  lanes: SwarmLiveLane[];
  claims: SwarmLiveClaim[];
  mail: { unread: number; recent: SwarmLiveMail[] };
  prs: SwarmLivePr[];
  prsSource: { kind: 'snapshot' | 'unavailable'; asOf: string | null; stale: boolean };
  events: SwarmLiveEvent[];
}

/** The stores swarm_live reads — injectable so tests need no Mongo. */
export interface SwarmLiveDeps {
  listLeases: (tenantId: string) => Promise<KeyedLeaseView[]>;
  recentMail: (tenantId: string, opts: { limit: number; since?: Date }) => Promise<{ messages: MailboxMessageView[]; unreadCount: number }>;
  listTasks: (tenantId: string, status: 'working' | 'done') => Promise<TaskView[]>;
  readPrSnapshot: () => PrSnapshot | null;
  defaultTenantId: () => string;
  now: () => Date;
}

export interface PrSnapshot {
  generatedAt: string;
  prs: SwarmLivePr[];
}

// ── small helpers ─────────────────────────────────────────────────────────

const iso = (d: Date | string | undefined | null): string | null =>
  d ? new Date(d).toISOString() : null;

/** YYYY-MM-DD of `d` in the swarm's timezone (en-CA formats as ISO date). */
export function sydneyDay(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SWARM_LIVE_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d);
}

const metaStr = (l: KeyedLeaseView, k: string): string | undefined => {
  const v = l.meta?.[k];
  return typeof v === 'string' && v ? v : undefined;
};

/** `host/lane/pid` holder → its parts (claims and coordinator leases use this form). */
function holderParts(holder: string): { host: string; lane: string } {
  const [host = '', lane = ''] = holder.split('/');
  return { host, lane };
}

function leaseLane(l: KeyedLeaseView): { host: string; lane: string } {
  const h = holderParts(l.holder);
  return { host: metaStr(l, 'host') ?? h.host, lane: metaStr(l, 'lane') ?? h.lane };
}

function toCoordinator(l: KeyedLeaseView): SwarmLiveCoordinator {
  const { host, lane } = leaseLane(l);
  return {
    key: l.key,
    lane,
    host: host || l.key.slice(COORDINATOR_PREFIX.length),
    holder: l.holder,
    epoch: l.epoch,
    heartbeatAt: iso(l.heartbeatAt)!,
    leaseExpiresAt: iso(l.leaseUntil)!,
    stale: l.stale,
  };
}

/** `claim:<repo-id>:<relpath>` → claim row (meta.path wins over the key's tail). */
function toClaim(l: KeyedLeaseView): SwarmLiveClaim {
  const rest = l.key.slice(CLAIM_PREFIX.length);
  const i = rest.indexOf(':');
  const { host, lane } = leaseLane(l);
  return {
    key: l.key,
    repo: i >= 0 ? rest.slice(0, i) : rest,
    path: metaStr(l, 'path') ?? (i >= 0 ? rest.slice(i + 1) : ''),
    holder: l.holder,
    lane,
    host,
    expiresAt: iso(l.leaseUntil)!,
    heartbeatAt: iso(l.heartbeatAt)!,
    note: metaStr(l, 'note') ?? '',
    stale: l.stale,
  };
}

function maxIso(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}

// ── PR snapshot (host-written file, mtime-cached) ─────────────────────────

let prCache: { path: string; mtimeMs: number; snap: PrSnapshot | null } | null = null;

/** Read state/swarm/prs.json under the AI root; null when absent or unparseable. */
export function readPrSnapshotFile(path = join(getConfig().aiRoot, PR_SNAPSHOT_RELPATH)): PrSnapshot | null {
  let mtimeMs: number;
  try {
    mtimeMs = statSync(path).mtimeMs;
  } catch {
    prCache = null;
    return null;
  }
  if (prCache && prCache.path === path && prCache.mtimeMs === mtimeMs) return prCache.snap;
  let snap: PrSnapshot | null = null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<PrSnapshot>;
    if (raw && typeof raw.generatedAt === 'string' && Array.isArray(raw.prs)) {
      snap = { generatedAt: raw.generatedAt, prs: raw.prs };
    }
  } catch {
    snap = null;
  }
  prCache = { path, mtimeMs, snap };
  return snap;
}

const defaultDeps: SwarmLiveDeps = {
  listLeases: async (tenantId) => (await listKeyedLeases(tenantId, { limit: 1000 })).leases,
  recentMail: (tenantId, opts) => recentMail(tenantId, opts),
  listTasks: (tenantId, status) => listTasks(tenantId, { status, limit: 200 }),
  readPrSnapshot: () => readPrSnapshotFile(),
  defaultTenantId: () => getConfig().tenancy.defaultTenantId,
  now: () => new Date(),
};

// ── the aggregate ─────────────────────────────────────────────────────────

export interface SwarmLiveOptions {
  /** Pick this host's coordinator lease as `coordinator` (default: newest fresh heartbeat). */
  host?: string;
  /** Lanes always listed, in this order (comma/space separated). Default:
   *  MYAI_SWARM_LANES. Lane names are the operator's data (v1 G6), so the
   *  shipped default is none: lanes come from the coordinator and other leases. */
  lanes?: string;
}

export async function buildSwarmLive(
  tenantId: string,
  opts: SwarmLiveOptions = {},
  deps: SwarmLiveDeps = defaultDeps,
): Promise<SwarmLive> {
  const now = deps.now();
  const day = sydneyDay(now);
  // 26h back always covers "today in Sydney" (UTC+10/+11); filtered by day below.
  const since = new Date(now.getTime() - 26 * 3600_000);

  const [leases, mailRecent, mailToday, working, done] = await Promise.all([
    deps.listLeases(tenantId),
    deps.recentMail(tenantId, { limit: RECENT_MAIL_LIMIT }),
    deps.recentMail(tenantId, { limit: 200, since }),
    deps.listTasks(tenantId, 'working'),
    deps.listTasks(tenantId, 'done'),
  ]);

  const coordinators = leases.filter(l => l.key.startsWith(COORDINATOR_PREFIX)).map(toCoordinator);
  const claims = leases.filter(l => l.key.startsWith(CLAIM_PREFIX)).map(toClaim);
  const presence = leases.filter(l => l.key.startsWith(PRESENCE_PREFIX));

  const fresh = coordinators.filter(c => !c.stale).sort((a, b) => (a.heartbeatAt < b.heartbeatAt ? 1 : -1));
  const coordinator = (opts.host ? coordinators.find(c => c.host === opts.host) : fresh[0]) ?? null;

  // ── lanes: configured lanes, then the coordinator's, then every lane seen in
  // a lease — crossed with every host seen in a lease ──
  const hosts = new Set<string>();
  const laneNames = parseLaneList('lanes' in opts ? opts.lanes : process.env.MYAI_SWARM_LANES);
  for (const c of fresh) if (c.lane && !laneNames.includes(c.lane)) laneNames.push(c.lane);
  for (const l of leases) {
    const { host, lane } = leaseLane(l);
    if (host) hosts.add(host);
    if (lane && !laneNames.includes(lane)) laneNames.push(lane);
  }
  const lanes: SwarmLiveLane[] = [];
  for (const host of [...hosts].sort()) {
    for (const lane of laneNames) {
      const mine = (l: KeyedLeaseView) => {
        const p = leaseLane(l);
        return p.host === host && p.lane === lane;
      };
      const laneLeases = leases.filter(mine);
      const liveClaims = claims.filter(c => c.host === host && c.lane === lane && !c.stale);
      const pres = presence.find(l => l.key === `${PRESENCE_PREFIX}${host}:${lane}`);
      const freshHeartbeat = laneLeases.some(l => !l.stale
        && (l.key.startsWith(PRESENCE_PREFIX) || l.key.startsWith(COORDINATOR_PREFIX)));
      const state: LaneState = liveClaims.length > 0 ? 'busy' : freshHeartbeat ? 'idle' : 'unknown';
      let lastSeenAt: string | null = null;
      for (const l of laneLeases) lastSeenAt = maxIso(lastSeenAt, iso(l.heartbeatAt));
      const task = working.find(t => typeof t.claimedBy === 'string' && t.claimedBy.startsWith(`${host}/${lane}/`));
      const branch = pres ? metaStr(pres, 'branch') : undefined;
      lanes.push({
        lane, host, state, lastSeenAt, claimCount: liveClaims.length,
        ...(task ? { currentTask: { id: task.taskId, title: task.title, repo: task.repo } } : {}),
        ...(branch ? { branch } : {}),
      });
    }
  }

  // ── PRs: host snapshot, default tenant only ──
  let prs: SwarmLivePr[] = [];
  let prsSource: SwarmLive['prsSource'] = { kind: 'unavailable', asOf: null, stale: false };
  if (tenantId === deps.defaultTenantId()) {
    const snap = deps.readPrSnapshot();
    if (snap) {
      prs = snap.prs;
      const age = now.getTime() - new Date(snap.generatedAt).getTime();
      prsSource = { kind: 'snapshot', asOf: iso(snap.generatedAt), stale: !(age <= PR_SNAPSHOT_STALE_MS) };
    }
  }

  // ── today's events (Sydney day) ──
  const today = (t: string | null): t is string => !!t && sydneyDay(new Date(t)) === day;
  const events: SwarmLiveEvent[] = [];
  for (const m of mailToday.messages) {
    const t = iso(m.createdAt);
    if (today(t)) events.push({ t, lane: holderParts(m.from).lane, kind: 'mail', label: m.subject, ref: m.messageId });
  }
  for (const l of leases.filter(x => x.key.startsWith(CLAIM_PREFIX))) {
    const t = iso(l.acquiredAt);
    if (today(t)) {
      const c = toClaim(l);
      events.push({ t, lane: c.lane, kind: 'claim', label: `${c.repo}:${c.path}`, ref: l.key });
    }
  }
  // One `work` span per task: startedAt → completedAt (`until`), kept when it
  // touches today. A task still running has no `until` (open, not invented).
  for (const task of [...working, ...done]) {
    const lane = typeof task.claimedBy === 'string' ? holderParts(task.claimedBy).lane : '';
    const started = iso(task.startedAt);
    const finished = iso(task.completedAt);
    if (!today(started) && !today(finished)) continue;
    const t = started ?? finished!;
    events.push({
      t, lane, kind: 'work', label: task.title, ref: task.taskId,
      ...(started && finished ? { until: finished } : {}),
    });
  }
  for (const pr of prs) {
    const t = iso(pr.mergedAt);
    if (today(t)) events.push({ t, lane: 'coordinator', kind: 'merge', label: `${pr.repo}#${pr.number} ${pr.title}`, ref: pr.url });
  }
  events.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));

  return {
    generatedAt: now.toISOString(),
    day,
    coordinator,
    coordinators,
    lanes,
    claims,
    mail: {
      unread: mailRecent.unreadCount,
      recent: mailRecent.messages.map(m => ({
        id: m.messageId, from: m.from, to: m.to, subject: m.subject, kind: m.kind,
        createdAt: iso(m.createdAt)!, acked: m.acked,
      })),
    },
    prs,
    prsSource,
    events,
  };
}
