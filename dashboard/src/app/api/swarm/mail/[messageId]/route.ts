// POST /api/swarm/mail/[messageId] — ack one mailbox message from /swarm.
// Gateway mail_ack when reachable, else Atlas directly (the Vercel path).
// Operator-session only (middleware.ts).
import { NextResponse } from 'next/server';
import { callGatewayAsTenant } from '@/lib/gateway';
import { getActiveTenant } from '@/lib/tenant';
import { invalidateSwarmCache } from '@/lib/swarm-cache';
import { ackMailAtlas } from '@/lib/swarm-atlas';

export const dynamic = 'force-dynamic';

const BY = 'operator (dashboard /swarm)';

export async function POST(_req: Request, { params }: { params: Promise<{ messageId: string }> }) {
  invalidateSwarmCache(); // the console refreshes right after this — never serve it a pre-action snapshot
  const { messageId } = await params;
  if (!/^mail-[0-9a-f-]{8,}$/.test(messageId)) {
    return NextResponse.json({ error: 'invalid messageId' }, { status: 400 });
  }
  const result = await callGatewayAsTenant('mail_ack', null, { id: messageId, ackedBy: BY });
  if (result.ok) { invalidateSwarmCache(); return NextResponse.json(result.data); }
  if (result.error && !/HTTP 5\d\d|fetch failed|unreachable|ECONNREFUSED|ENOTFOUND|timeout|aborted/i.test(result.error)) {
    return NextResponse.json({ error: result.error }, { status: 502 });
  }
  try {
    const msg = await ackMailAtlas(await getActiveTenant(), messageId, `${BY} · cloud`);
    invalidateSwarmCache();
    return msg ? NextResponse.json({ acked: true, message: msg }) : NextResponse.json({ error: 'message not found' }, { status: 404 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'ack failed' }, { status: 502 });
  }
}
