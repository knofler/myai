// PATCH /api/marketplace/installs/[id] { action } — drives the ADR-019
// install state machine: enable → active, disable → disabled, uninstall →
// uninstalled (terminal). Illegal transitions are 409 with the state
// machine's own reason; another tenant's install reads as 404 (ADR-010).
import { NextRequest, NextResponse } from 'next/server';
import { INSTALL_ACTIONS, isInstallAction } from '@/lib/marketplace';
import { transitionInstall } from '@/lib/marketplace-store';
import { DEFAULT_TENANT_ID, TENANT_COOKIE } from '@/lib/tenant-cookie';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }
  const { action } = (body ?? {}) as { action?: unknown };
  if (!isInstallAction(action)) {
    return NextResponse.json(
      { error: 'body must be { action: "enable" | "disable" | "uninstall" }' },
      { status: 400 },
    );
  }

  const result = transitionInstall({
    tenantId: req.cookies.get(TENANT_COOKIE)?.value || DEFAULT_TENANT_ID,
    installId: id,
    to: INSTALL_ACTIONS[action],
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ install: result.value });
}
