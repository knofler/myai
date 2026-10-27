// GET /api/swarm — the /swarm ops console snapshot: recent swarms with their
// children plus the mailbox for every address those swarms involve.
//
// Two sources, same shape: the local gateway (swarm_list → swarm_get per swarm,
// mail_inbox) when it is reachable — the local Docker dashboard — else Atlas
// directly (lib/swarm-atlas.ts), which is what the Vercel deployment uses: the
// gateway runs on the operator's Mac, but its store is Atlas. `source` says
// which one answered.
//
// Speed: a per-tenant 3s server cache (lib/swarm-cache.ts, cleared by every
// action route) absorbs the 10s poll from several tabs/phones, the console's
// IndexedDB cache repaints instantly on reload, and the response carries a PRIVATE max-age +
// stale-while-revalidate so the browser re-renders instantly from its copy.
// Never a shared/CDN cache — this is operator-only data behind the session.
// Auth: not in OPERATOR_PUBLIC, so middleware.ts requires the operator session.
import { NextResponse } from 'next/server';
import { callGatewayAsTenant } from '@/lib/gateway';
import { getActiveTenant } from '@/lib/tenant';
import { snapshotAtlas } from '@/lib/swarm-atlas';
import { getCachedSnapshot, setCachedSnapshot } from '@/lib/swarm-cache';
import { mailAddresses, rowsToExpand, type MailMessage, type SwarmRow, type SwarmSnapshot, type SwarmWithChildren } from '@/lib/swarm-live';

export const dynamic = 'force-dynamic';

const SWARM_LIMIT = 20;
const MAIL_LIMIT = 40;
const HEADERS = { 'Cache-Control': 'private, max-age=3, stale-while-revalidate=30' };

type Snap = SwarmSnapshot & { source: 'gateway' | 'atlas'; error?: string };

async function fromGateway(): Promise<Snap | null> {
  const list = await callGatewayAsTenant<{ count: number; swarms: SwarmRow[] }>('swarm_list', null, { limit: SWARM_LIMIT });
  if (!list.ok || !list.data) return null;
  // Children for live swarms + the newest few finished ones only — one
  // swarm_get per expanded row, so this bounds the gateway calls per poll.
  const expand = rowsToExpand(list.data.swarms);
  const detailed = await Promise.all(
    list.data.swarms.map(async (row): Promise<SwarmWithChildren> => {
      if (!expand.has(row.swarmId)) return { swarm: row, children: [], detail: 'omitted' };
      const got = await callGatewayAsTenant<SwarmWithChildren>('swarm_get', null, { swarmId: row.swarmId });
      // swarm_get also marks an all-finished active swarm done, so prefer its row.
      // A failed read is flagged, never shown as a swarm with no children.
      return got.ok && got.data ? got.data : { swarm: row, children: [], detail: 'error' };
    }),
  );
  let mail: MailMessage[] = [];
  const to = mailAddresses(detailed);
  if (to.length) {
    const inbox = await callGatewayAsTenant<{ messages: MailMessage[] }>('mail_inbox', null, { to, includeAcked: true, limit: MAIL_LIMIT });
    if (inbox.ok && inbox.data) mail = inbox.data.messages;
  }
  const source = (list.data as { _source?: string })._source === 'atlas' ? 'atlas' : 'gateway';
  return { swarms: detailed, mail, gatewayOk: true, fetchedAt: new Date().toISOString(), source };
}

export async function GET(req: Request) {
  const tenantId = await getActiveTenant();
  const hit = new URL(req.url).searchParams.has('fresh') ? null : getCachedSnapshot<Snap>(tenantId);
  if (hit) return NextResponse.json(hit, { headers: HEADERS });

  let snap = await fromGateway();
  if (!snap) {
    try {
      snap = { ...(await snapshotAtlas(tenantId)), source: 'atlas' };
    } catch (err) {
      const empty: Snap = { swarms: [], mail: [], gatewayOk: false, fetchedAt: new Date().toISOString(), source: 'atlas',
        error: err instanceof Error ? err.message : 'no gateway and Atlas unreachable' };
      return NextResponse.json(empty, { headers: { 'Cache-Control': 'no-store' } });
    }
  }
  setCachedSnapshot(tenantId, snap);
  return NextResponse.json(snap, { headers: HEADERS });
}
