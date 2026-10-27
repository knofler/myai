// Swarm ops console — pure data helpers (no fetch, no React) behind /swarm.
// The shapes mirror the gateway's swarm_list / swarm_get / mail_inbox MCP
// tools (runtime/src/tasks/swarm-store.ts, mailbox store). The /api/swarm
// route does the gateway calls; this module only shapes what came back, so
// every rule here is unit-tested without a gateway.

export type SwarmStatus = 'planning' | 'paused' | 'active' | 'stopped' | 'done';
export type ChildDisplayStatus = 'paused' | 'pending' | 'running' | 'done' | 'blocked';

export interface SwarmRow {
  swarmId: string;
  repo: string;
  goal: string;
  status: SwarmStatus;
  childCap: number;
  childCount: number;
  createdBy: string;
  tokenBudget?: number;
  tokenSpent?: number;
  notes?: string;
  approvedAt?: string;
  approvedBy?: string;
  stoppedAt?: string;
  stoppedBy?: string;
  completedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmChild {
  taskId: string;
  title: string;
  status: string;
  displayStatus: ChildDisplayStatus;
  assignedAgent?: string;
  priority?: string;
  dependsOn?: string[];
  claimedBy?: string;
  prUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SwarmWithChildren {
  swarm: SwarmRow;
  children: SwarmChild[];
  /** Set by /api/swarm when children were not fetched: 'omitted' (older finished swarm, to bound gateway load) or 'error' (swarm_get failed). */
  detail?: 'omitted' | 'error';
}

/** Live swarms always get children; only the newest few finished ones do (bounds gateway calls per poll). */
export const FINISHED_DETAIL_LIMIT = 5;

export function isLive(status: SwarmStatus): boolean {
  return status === 'planning' || status === 'paused' || status === 'active';
}

/** Which swarm rows /api/swarm should expand with swarm_get (rows arrive newest first). */
export function rowsToExpand(rows: SwarmRow[]): Set<string> {
  const out = new Set<string>();
  let finished = 0;
  for (const r of rows) {
    if (isLive(r.status)) out.add(r.swarmId);
    else if (finished < FINISHED_DETAIL_LIMIT) {
      out.add(r.swarmId);
      finished++;
    }
  }
  return out;
}

export interface MailMessage {
  messageId: string;
  to: string;
  from: string;
  kind?: string;
  subject: string;
  body?: string;
  swarmId?: string;
  acked: boolean;
  createdAt: string;
}

export interface SwarmSnapshot {
  swarms: SwarmWithChildren[];
  mail: MailMessage[];
  /** False when the gateway could not be reached — the page says so instead of showing "no swarms". */
  gatewayOk: boolean;
  fetchedAt: string;
}

/** Status chip tone, in the shared tone vocabulary (ui/tone.ts). */
export function swarmTone(status: SwarmStatus): 'ok' | 'accent' | 'warn' | 'err' | 'muted' {
  switch (status) {
    case 'active': return 'accent';
    case 'paused': return 'warn';
    case 'done': return 'ok';
    case 'stopped': return 'err';
    default: return 'muted';
  }
}

export function childTone(status: ChildDisplayStatus): 'ok' | 'accent' | 'warn' | 'err' | 'muted' {
  switch (status) {
    case 'running': return 'accent';
    case 'paused': return 'warn';
    case 'done': return 'ok';
    case 'blocked': return 'err';
    default: return 'muted';
  }
}

/** Which actions the operator may take on a swarm right now (matches swarm-store's rules). */
export function swarmActions(status: SwarmStatus): { approve: boolean; stop: boolean; approveLabel: string } {
  return {
    approve: status === 'paused' || status === 'stopped',
    stop: status === 'active' || status === 'paused',
    approveLabel: status === 'stopped' ? 'Resume' : 'Approve',
  };
}

/**
 * Indent depth per child = length of its longest dependsOn chain back to a
 * root, so a downstream child renders nested under what it waits on. Children
 * come in plan order and may only depend on EARLIER children (swarm_plan
 * refuses forward edges), so one forward pass is exact. An edge to a taskId
 * outside this swarm counts as depth 0.
 */
export function childDepths(children: SwarmChild[]): Map<string, number> {
  const depth = new Map<string, number>();
  for (const c of children) {
    let d = 0;
    for (const up of c.dependsOn ?? []) {
      const ud = depth.get(up);
      if (ud !== undefined) d = Math.max(d, ud + 1);
    }
    depth.set(c.taskId, d);
  }
  return depth;
}

/** Plan-order index (1-based) of each child, so "waits on #1" reads naturally. */
export function childIndex(children: SwarmChild[]): Map<string, number> {
  return new Map(children.map((c, i) => [c.taskId, i + 1]));
}

/** Children whose upstreams are not all finished — "waiting" is shown on a pending child. */
export function waitingOn(child: SwarmChild, children: SwarmChild[]): string[] {
  const byId = new Map(children.map((c) => [c.taskId, c]));
  return (child.dependsOn ?? []).filter((up) => byId.get(up)?.displayStatus !== 'done');
}

export function progress(children: SwarmChild[]): { done: number; total: number } {
  return { done: children.filter((c) => c.displayStatus === 'done').length, total: children.length };
}

/** Addresses whose mail belongs on /swarm: every swarm's creator and each child's agent. */
export function mailAddresses(swarms: SwarmWithChildren[]): string[] {
  const set = new Set<string>();
  for (const s of swarms) {
    if (s.swarm.createdBy) set.add(s.swarm.createdBy);
    for (const c of s.children) if (c.assignedAgent) set.add(c.assignedAgent);
  }
  return [...set].sort();
}

export interface ActivityEvent {
  at: string;
  swarmId: string;
  text: string;
  tone: 'ok' | 'accent' | 'warn' | 'err' | 'muted';
}

/**
 * The activity feed, derived from timestamps the swarm + child rows already
 * carry (no extra gateway call): planned / approved / stopped / completed per
 * swarm, plus each child's latest state change. Newest first.
 */
export function activity(swarms: SwarmWithChildren[], limit = 30): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  for (const { swarm, children } of swarms) {
    const name = shortGoal(swarm.goal);
    out.push({ at: swarm.createdAt, swarmId: swarm.swarmId, text: `Planned "${name}" · ${swarm.childCount} children`, tone: 'muted' });
    if (swarm.approvedAt) out.push({ at: swarm.approvedAt, swarmId: swarm.swarmId, text: `Approved "${name}"${swarm.approvedBy ? ` by ${swarm.approvedBy}` : ''}`, tone: 'accent' });
    if (swarm.stoppedAt) out.push({ at: swarm.stoppedAt, swarmId: swarm.swarmId, text: `Stopped "${name}"${swarm.stoppedBy ? ` by ${swarm.stoppedBy}` : ''}`, tone: 'err' });
    if (swarm.completedAt) out.push({ at: swarm.completedAt, swarmId: swarm.swarmId, text: `Finished "${name}"`, tone: 'ok' });
    const idx = childIndex(children);
    for (const c of children) {
      if (c.updatedAt === c.createdAt) continue;
      const who = c.claimedBy ? ` on ${c.claimedBy}` : '';
      out.push({ at: c.updatedAt, swarmId: swarm.swarmId, text: `#${idx.get(c.taskId)} ${c.title} → ${c.displayStatus}${who}`, tone: childTone(c.displayStatus) });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

export function shortGoal(goal: string, max = 60): string {
  return goal.length > max ? `${goal.slice(0, max - 1)}…` : goal;
}

/** "12s ago" / "4m ago" / "3h ago" / "2d ago" — relative to `now`. */
export function age(iso: string, now: number = Date.now()): string {
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function tokens(spent = 0, budget = 0): string {
  const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
  return budget ? `${k(spent)} / ${k(budget)} tok` : `${k(spent)} tok`;
}
