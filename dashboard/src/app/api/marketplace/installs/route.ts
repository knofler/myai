// /api/marketplace/installs — the commerce-axis install surface (ADR-019).
//
//   GET  → the calling tenant's installs (cookie-scoped, ADR-010)
//   POST { slug, version? } → new install, driven through the specced gates:
//          canInstall (listing published + version published) then the
//          free-tier gate (paid pricing models → 402 until Stripe wiring
//          lands). Free installs charge nothing and append no ledger rows —
//          ADR-019 §4: `free` short-circuits all commerce.
import { NextRequest, NextResponse } from 'next/server';
import { createInstall, listInstallsForTenant } from '@/lib/marketplace-store';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function tenantOf(req: NextRequest): string {
  return req.cookies.get(TENANT_COOKIE)?.value || DEFAULT_TENANT_ID;
}

export async function GET(req: NextRequest) {
  return NextResponse.json({ installs: listInstallsForTenant(tenantOf(req)) });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const { slug, version } = (body ?? {}) as { slug?: unknown; version?: unknown };
  if (typeof slug !== 'string' || !slug || (version !== undefined && typeof version !== 'string')) {
    return NextResponse.json({ error: 'body must be { slug: string, version?: string }' }, { status: 400 });
  }

  const result = createInstall({
    tenantId: tenantOf(req),
    userId: 'dashboard-operator',
    slug,
    version,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ install: result.value }, { status: 201 });
}
