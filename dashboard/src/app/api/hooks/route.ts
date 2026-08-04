// /api/hooks — hook enable/disable toggle (MYAI_DASHBOARD.md §3.2).
//
// PATCH { name, enabled } → forwarded to the gateway's PATCH /api/hooks,
// which owns the filesystem: it patches .claude/settings.json (moving the
// entry to/from the disabledHooks mirror key, preserving unrelated keys),
// flips the in-memory registration, and updates the Mongo mirror. The
// dashboard never writes settings.json itself — it has no authoritative
// checkout of the master repo.
import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { GATEWAY_HTTP_URL, gatewayHeaders } from '@/lib/gateway';
import { parseHookPatch } from '@/lib/hook-toggle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const patch = parseHookPatch(body);
  if (!patch) {
    return NextResponse.json({ error: 'body must be { name: string, enabled: boolean }' }, { status: 400 });
  }

  try {
    const res = await fetch(`${GATEWAY_HTTP_URL}/api/hooks`, {
      method: 'PATCH',
      headers: gatewayHeaders(),
      body: JSON.stringify(patch),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return NextResponse.json(
        { error: (data as { error?: string } | null)?.error ?? `gateway returned ${res.status}` },
        { status: res.status === 404 ? 404 : 502 },
      );
    }

    // The registry hooks tab serves from the Next data cache — bust it so the
    // flipped state shows on the next render instead of after the 60s TTL.
    revalidateTag('registry-hooks');

    return NextResponse.json(data ?? { ok: true, ...patch });
  } catch (err) {
    console.error('[api/hooks] PATCH failed:', err);
    return NextResponse.json({ error: 'gateway unreachable' }, { status: 502 });
  }
}
