// POST /api/marketplace/payouts/run — the Stripe Connect payout-run endpoint
// (ADR-019 §4 / checklist item #4's still-open half: "the actual payout-RUN
// endpoint that reads a real ledger store"). Operator-only (no tenant runs
// its own payout) — same `requireOperator` posture as the review queue
// (api/marketplace/review/route.ts).
//
// Per invocation:
//   1. Clear any `pending` ledger row whose hold window has elapsed to
//      `available` (marketplace-ledger-store.ts's clearElapsedPendingEntries)
//      so this run's balance reads see money that cleared since the last run.
//   2. For every creator tenant with any ledger activity: roll its rows into
//      a balance (computeCreatorBalance), gate on the minimum threshold AND
//      Connect payout-readiness (decidePayoutWithConnect), and — if
//      eligible — move funds via Stripe Connect (createTransfer) and append
//      the resulting `payout` ledger row (idempotent on the transfer id).
// A failure for one creator (Stripe error, data inconsistency) is caught and
// reported per-entry — it never aborts the rest of the run.
import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';
import { requireOperator } from '@/lib/require-operator';
import { connectDB, Tenant } from '@/lib/db';
import { computeCreatorBalance } from '@/lib/marketplace-billing';
import {
  isConnectConfigured,
  createTransfer,
  decidePayoutWithConnect,
  type ConnectAccountStatus,
} from '@/lib/marketplace-connect';
import {
  listCreatorTenantIds,
  listLedgerForCreator,
  clearElapsedPendingEntries,
  appendLedgerEntry,
} from '@/lib/marketplace-ledger-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Payout rows aren't tied to a single listing (they pay out a creator's
 *  whole cleared balance across listings) — `listingId` is otherwise
 *  required on every ledger row, so this sentinel marks "not listing-scoped"
 *  rather than leaving it empty. */
const PAYOUT_LEDGER_SENTINEL_LISTING_ID = 'payout-run';

interface PayoutRunEntryResult {
  creatorTenantId: string;
  eligible: boolean;
  amountUsd: number;
  reason?: string;
  transferId?: string;
  error?: string;
}

export async function POST(req: Request) {
  const denied = requireOperator(req);
  if (denied) return denied;

  if (!isConnectConfigured()) {
    return NextResponse.json({ error: 'marketplace payouts not configured' }, { status: 503 });
  }

  await connectDB();
  const now = new Date();
  const batchId = `payoutrun_${now.getTime()}_${randomUUID().slice(0, 8)}`;

  const cleared = await clearElapsedPendingEntries(now);
  const creatorTenantIds = await listCreatorTenantIds();

  const results: PayoutRunEntryResult[] = [];
  for (const creatorTenantId of creatorTenantIds) {
    try {
      const entries = await listLedgerForCreator(creatorTenantId);
      const balance = computeCreatorBalance(entries);
      const tenant = await Tenant.findOne({ tenantId: creatorTenantId }).lean<{
        stripeConnectAccountId?: string;
        stripeConnectStatus?: ConnectAccountStatus;
      } | null>();
      const connectStatus: ConnectAccountStatus = tenant?.stripeConnectStatus ?? 'not_connected';
      const decision = decidePayoutWithConnect(balance, connectStatus);

      if (!decision.eligible) {
        results.push({ creatorTenantId, eligible: false, amountUsd: 0, reason: decision.reason });
        continue;
      }

      const accountId = tenant?.stripeConnectAccountId;
      if (!accountId) {
        results.push({
          creatorTenantId,
          eligible: false,
          amountUsd: 0,
          reason: 'connect account missing despite payout-ready status (data inconsistency)',
        });
        continue;
      }

      const transfer = await createTransfer({
        accountId,
        amountUsd: decision.amountUsd,
        currency: 'usd',
        idempotencyKey: `${batchId}:${creatorTenantId}`,
        description: `Marketplace payout ${batchId} for ${creatorTenantId}`,
      });

      await appendLedgerEntry({
        creatorTenantId,
        entryId: transfer.id,
        listingId: PAYOUT_LEDGER_SENTINEL_LISTING_ID,
        type: 'payout',
        status: 'paid',
        grossUsd: -decision.amountUsd,
        platformFeeUsd: 0,
        creatorNetUsd: -decision.amountUsd,
        currency: 'USD',
        occurredAt: now.toISOString(),
        payoutBatchId: batchId,
      });

      results.push({ creatorTenantId, eligible: true, amountUsd: decision.amountUsd, transferId: transfer.id });
    } catch (err) {
      results.push({
        creatorTenantId,
        eligible: false,
        amountUsd: 0,
        error: err instanceof Error ? err.message : 'payout failed',
      });
    }
  }

  const paid = results.filter((r) => r.eligible);
  return NextResponse.json({
    batchId,
    ranAt: now.toISOString(),
    clearedPendingEntries: cleared,
    processed: results.length,
    paidCount: paid.length,
    totalPaidUsd: paid.reduce((sum, r) => sum + r.amountUsd, 0),
    results,
  });
}
