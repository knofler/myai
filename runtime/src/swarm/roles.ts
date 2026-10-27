// Swarm ROLES resolver (v1 G6, phase P1; design: state/reports/v1-g6-lane-rename.md).
//
// Shipped code must never spell an operator's lane names (their profile names):
// lanes are user data, derived from profile directory names on the host
// (scripts/lib/swarm_master_config.sh smc_lane_for). The gateway cannot read
// the host's ~/.myai/swarm/master.<host>, so it answers "which lane is the
// master/director?" in the order the master ruled (mail-7b4ab62f):
//
//   1. lease   — every live `swarm-coordinator:<host|fleet>` keyed lease; the
//                lane is meta.lane, else the holder's middle segment
//                (holder = `<host>/<lane>/<pid>`, scripts/swarm_master.sh).
//   2. env     — MYAI_DIRECTOR_LANES (comma/space separated), ONLY when no
//                live lease exists (fresh boot, no swarm).
//   3. default — the `default` lane (a single-profile install's ~/.claude).
//
// P1 adds the resolver only; call sites (delegate-store's isDirectorAddress,
// live-aggregate's lane list) move onto it in P2/P5.

import { listKeyedLeases, type KeyedLeaseView } from '../tasks/keyed-lease-store.js';

export const COORDINATOR_LEASE_PREFIX = 'swarm-coordinator:';
export const DEFAULT_LANE = 'default';
/** The role name a director address may always use, independent of lanes. */
export const DIRECTOR_ROLE = 'director';

const LANE_RE = /^[a-z0-9][a-z0-9_.-]*$/;

function normLane(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return LANE_RE.test(s) ? s : null;
}

/** A comma/space separated lane list (an env value) → valid lanes, first-seen order, no repeats. */
export function parseLaneList(value: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (value ?? '').split(/[\s,]+/)) {
    const lane = normLane(part);
    if (lane && !out.includes(lane)) out.push(lane);
  }
  return out;
}

/** The lane a coordinator lease belongs to: meta.lane, else `<host>/<lane>/<pid>`'s middle part. */
export function laneOfCoordinatorLease(lease: Pick<KeyedLeaseView, 'holder' | 'meta'>): string | null {
  const fromMeta = normLane(lease.meta?.lane);
  if (fromMeta) return fromMeta;
  const parts = lease.holder.split('/');
  return parts.length >= 3 ? normLane(parts[1]) : null;
}

/**
 * Pure decision: lease → env → default. `leases` may contain any keyed
 * leases; only live (non-stale) `swarm-coordinator:` ones count.
 */
export function directorLanesFrom(
  leases: ReadonlyArray<Pick<KeyedLeaseView, 'key' | 'holder' | 'meta' | 'stale'>>,
  envValue: string | undefined,
): { lanes: string[]; source: 'lease' | 'env' | 'default' } {
  const fromLeases = new Set<string>();
  for (const l of leases) {
    if (l.stale || !l.key.startsWith(COORDINATOR_LEASE_PREFIX)) continue;
    const lane = laneOfCoordinatorLease(l);
    if (lane) fromLeases.add(lane);
  }
  if (fromLeases.size > 0) return { lanes: [...fromLeases].sort(), source: 'lease' };

  const fromEnv = parseLaneList(envValue);
  if (fromEnv.length > 0) return { lanes: fromEnv.sort(), source: 'env' };

  return { lanes: [DEFAULT_LANE], source: 'default' };
}

/** Lists the tenant's coordinator leases; injectable for tests. */
export type CoordinatorLeaseLister = (tenantId: string) => Promise<KeyedLeaseView[]>;

const defaultLister: CoordinatorLeaseLister = async (tenantId) =>
  (await listKeyedLeases(tenantId, { prefix: COORDINATOR_LEASE_PREFIX })).leases;

/**
 * Resolve the director lane(s) for a tenant. A lease-store failure is treated
 * as "no lease" (falls through to env → default) — the director check must
 * never throw a request.
 */
export async function resolveDirectorLanes(
  tenantId: string,
  opts: { lister?: CoordinatorLeaseLister; env?: string | undefined } = {},
): Promise<{ lanes: string[]; source: 'lease' | 'env' | 'default' }> {
  let leases: KeyedLeaseView[] = [];
  try {
    leases = await (opts.lister ?? defaultLister)(tenantId);
  } catch {
    leases = [];
  }
  const env = 'env' in opts ? opts.env : process.env.MYAI_DIRECTOR_LANES;
  return directorLanesFrom(leases, env);
}

/**
 * Is `address` a director address for these lanes? Matches the bare lane or
 * role (`<lane>`, `director`), the lane's Claude profile name
 * (`claude-<lane>`, the ~/.claude-<lane> convention), and the host-scoped
 * form (`<host>/<lane>`, `<host>/director`). Lower-cases like the mailbox does.
 */
export function isDirectorAddressFor(address: string, directorLanes: readonly string[]): boolean {
  const a = address.trim().toLowerCase();
  const names = new Set([...directorLanes.map((l) => l.toLowerCase()), DIRECTOR_ROLE]);
  if (names.has(a)) return true;
  if (a.startsWith('claude-') && names.has(a.slice('claude-'.length))) return true;
  const last = a.includes('/') ? a.slice(a.lastIndexOf('/') + 1) : null;
  return last !== null && names.has(last);
}
