// GET /api/marketplace/connect/status — the creator's Connect onboarding
// state (ADR-019 follow-up #4). Re-fetches live from Stripe and syncs the
// tenant row on every call (cheap single GET) rather than trusting a possibly
// stale webhook delivery — this is the signal the payout run gate
// (decidePayoutWithConnect) ultimately depends on, so it must never be
// silently stale in the UI.
import { NextResponse } from 'next/server';
import { authenticateTenant, keyFromRequest } from '@/lib/tenant-auth';
import { connectDB, Tenant } from '@/lib/db';
import {
  isConnectConfigured,
  getConnectAccount,
  mapAccountToConnectStatus,
  canReceivePayout,
  canTransitionConnectAccount,
} from '@/lib/marketplace-connect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const auth = await authenticateTenant(keyFromRequest(req));
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const accountId = auth.tenant.stripeConnectAccountId;
  if (!accountId) {
    return NextResponse.json({
      connected: false,
      status: 'not_connected',
      payoutReady: false,
    });
  }

  if (!isConnectConfigured()) {
    // Account id exists but this deployment can't reach Stripe right now —
    // report the last-synced status rather than failing the whole route.
    const cached = auth.tenant.stripeConnectStatus ?? 'not_connected';
    return NextResponse.json({
      connected: true,
      status: cached,
      payoutReady: canReceivePayout(cached),
      stale: true,
    });
  }

  try {
    const account = await getConnectAccount(accountId);
    const status = mapAccountToConnectStatus(account);
    const previous = auth.tenant.stripeConnectStatus ?? 'not_connected';

    if (status !== previous) {
      const transition = canTransitionConnectAccount(previous, status);
      // Log-and-write even on an "illegal" transition per our own table (e.g.
      // Stripe reports the same status twice, or a status our map can't
      // reach from `previous` due to a missed webhook) — Stripe is the
      // source of truth for its own account, so we always converge to it;
      // the transition table is a sanity signal, not a hard gate, here.
      await connectDB();
      await Tenant.updateOne(
        { tenantId: auth.tenant.tenantId },
        { $set: { stripeConnectStatus: status } },
      ).exec();
      if (!transition.ok) {
        console.warn(
          `[marketplace-connect] tenant ${auth.tenant.tenantId} status ${previous} -> ${status} (${transition.reason})`,
        );
      }
    }

    return NextResponse.json({
      connected: true,
      status,
      payoutReady: canReceivePayout(status),
      detailsSubmitted: Boolean(account.details_submitted),
      chargesEnabled: Boolean(account.charges_enabled),
      payoutsEnabled: Boolean(account.payouts_enabled),
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'status fetch failed' },
      { status: 502 },
    );
  }
}
