// POST /api/marketplace/connect/onboard — start (or resume) Stripe Connect
// Express onboarding for a creator tenant (ADR-019 follow-up #4). Creates the
// Connect account on first call (persisted on the tenant row), reuses it on
// subsequent calls, and always returns a fresh hosted Account Link — Account
// Links expire quickly, so "onboard" is safe to call repeatedly (e.g. the
// creator's payout link expired and they clicked "continue setup" again).
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import { connectDB, Tenant } from '@/lib/db';
import {
  isConnectConfigured,
  createConnectAccount,
  createAccountLink,
} from '@/lib/marketplace-connect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!isConnectConfigured()) {
    return NextResponse.json({ error: 'marketplace payouts not configured' }, { status: 503 });
  }

  const auth = await authenticateTenant(keyFromRequest(req));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  try {
    await connectDB();
    let accountId = auth.tenant.stripeConnectAccountId;

    if (!accountId) {
      const account = await createConnectAccount({
        tenantId: auth.tenant.tenantId,
        email: auth.tenant.ownerEmail,
      });
      accountId = account.id;
      await Tenant.updateOne(
        { tenantId: auth.tenant.tenantId },
        { $set: { stripeConnectAccountId: accountId, stripeConnectStatus: 'onboarding' } },
      ).exec();
    }

    const link = await createAccountLink({ accountId });
    return NextResponse.json({ accountId, url: link.url, expiresAt: link.expires_at ?? null });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'onboarding failed' },
      { status: 502 },
    );
  }
}
