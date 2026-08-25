// POST /api/marketplace/connect/webhook — Stripe Connect `account.updated`
// push sync (ADR-019 checklist #4 addendum). Creator account status today
// only syncs on-demand via GET /api/marketplace/connect/status (a live
// re-fetch on every call); this is the push half — Stripe notifies us the
// moment a connected account's requirements/capabilities change (KYC
// requirement added, account restricted, payouts enabled) so the tenant row
// converges without waiting for a page load.
//
// Same verification + idempotency discipline as the platform-subscription
// webhook (api/billing/webhook/route.ts): HMAC over the RAW body via
// `verifyWebhookSignature` (Stripe-Signature header, t=/v1= scheme shared
// with billing.ts — Connect uses its own signing secret,
// STRIPE_CONNECT_WEBHOOK_SECRET, since Stripe issues Connect webhook
// endpoints a distinct secret from the platform one), then
// checkWebhookIdempotency against the same `stripeevents` ledger (event ids
// are globally unique in Stripe, so sharing the collection with the billing
// webhook is safe).
//
// `account.updated`'s `data.object` IS the Stripe Account (not a wrapper), so
// unlike the billing webhook there's no per-type object shape to branch on —
// every event this route handles maps through the one
// `mapAccountToConnectStatus` function the status route also uses, so the
// mapping can't drift between the pull and push paths.
import { NextResponse } from 'next/server';
import { connectDB, Tenant } from '@/lib/db';
import { STRIPE_CONNECT_WEBHOOK_SECRET, verifyWebhookSignature } from '@/lib/billing';
import {
  isConnectConfigured,
  mapAccountToConnectStatus,
  canTransitionConnectAccount,
  type StripeAccountFlags,
} from '@/lib/marketplace-connect';
import {
  checkWebhookIdempotency,
  createMongoProcessedEventStore,
  resolveWebhookObjectId,
  type ProcessedEventStore,
} from '@/lib/webhook-idempotency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StripeAccountObj extends StripeAccountFlags {
  id?: string;
  metadata?: Record<string, string>;
}
interface StripeConnectEvent {
  id?: string;
  type: string;
  /** Unix seconds — when Stripe created this Event. */
  created?: number;
  data: { object: StripeAccountObj };
}

export async function POST(req: Request) {
  if (!isConnectConfigured() || !STRIPE_CONNECT_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'connect webhook not configured' }, { status: 503 });
  }

  const raw = await req.text();
  const sig = req.headers.get('stripe-signature');
  if (!verifyWebhookSignature(raw, sig, STRIPE_CONNECT_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: StripeConnectEvent;
  try {
    event = JSON.parse(raw) as StripeConnectEvent;
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  if (event.type !== 'account.updated') {
    return NextResponse.json({ received: true, ignored: event.type });
  }

  try {
    await connectDB();
    const obj = event.data?.object ?? {};

    const store: ProcessedEventStore = createMongoProcessedEventStore();
    let markApplied: () => Promise<void> = async () => {};
    if (event.id) {
      const eventId = event.id;
      markApplied = () => store.markApplied(eventId);
      const idem = await checkWebhookIdempotency(store, {
        id: eventId,
        type: event.type,
        objectId: resolveWebhookObjectId(obj),
        createdAt: event.created ?? Math.floor(Date.now() / 1000),
      });
      if (idem.action === 'duplicate') {
        console.warn('[connect/webhook] duplicate delivery, skipping', event.type, eventId);
        return NextResponse.json({ received: true, duplicate: true });
      }
      if (idem.action === 'stale') {
        console.warn('[connect/webhook] out-of-order event, skipping apply', event.type, eventId);
        return NextResponse.json({ received: true, stale: true });
      }
    }

    if (!obj.id) {
      return NextResponse.json({ received: true, matched: false });
    }

    const tenant = obj.metadata?.tenantId
      ? await Tenant.findOne({ tenantId: obj.metadata.tenantId }).exec()
      : await Tenant.findOne({ stripeConnectAccountId: obj.id }).exec();
    if (!tenant) {
      // Ack so Stripe stops retrying; no tenant row to converge yet (e.g. the
      // account was created out-of-band of our onboard route).
      console.warn('[connect/webhook] no tenant for connect account', obj.id);
      return NextResponse.json({ received: true, matched: false });
    }

    const status = mapAccountToConnectStatus(obj);
    const previous = tenant.stripeConnectStatus ?? 'not_connected';

    if (status !== previous) {
      // Log-and-write even on an "illegal" transition per our own table, same
      // rationale as the status route: Stripe is the source of truth for its
      // own account, so we always converge to it — the transition table is a
      // sanity signal here, not a hard gate.
      const transition = canTransitionConnectAccount(previous, status);
      if (!transition.ok) {
        console.warn(
          `[connect/webhook] tenant ${tenant.tenantId} status ${previous} -> ${status} (${transition.reason})`,
        );
      }
    }

    tenant.stripeConnectAccountId = obj.id;
    tenant.stripeConnectStatus = status;
    await tenant.save();
    await markApplied();

    return NextResponse.json({ received: true, tenantId: tenant.tenantId, status });
  } catch (err) {
    console.error('[connect/webhook] failed:', err);
    return NextResponse.json({ error: 'webhook handling failed' }, { status: 500 });
  }
}
