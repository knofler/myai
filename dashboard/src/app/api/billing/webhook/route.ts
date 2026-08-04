// POST /api/billing/webhook — Stripe subscription lifecycle (ADR-010 M5).
// The ONLY writer of a tenant's plan/subscriptionStatus from billing. Verifies
// the Stripe-Signature header against STRIPE_WEBHOOK_SECRET over the RAW body
// (no JSON re-encode), then maps the event to the tenant and updates it:
//   checkout.session.completed                 → link customer/subscription, activate
//   customer.subscription.created|updated      → sync status + period end + plan
//   customer.subscription.deleted              → mark canceled, drop to free
//   invoice.payment_failed                     → dunning: past_due + retry email; auto-downgrade on final
//   invoice.payment_succeeded                  → recovery: clear the dunning failure count
//
// Tenant resolution order: client_reference_id / metadata.tenantId (set at
// checkout) → existing stripeCustomerId. Idempotent: re-delivered events
// converge to the same row state.
import { NextResponse } from 'next/server';
import { connectDB, Tenant } from '@/lib/db';
import {
  STRIPE_WEBHOOK_SECRET,
  isStripeConfigured,
  verifyWebhookSignature,
  normalizeSubscriptionStatus,
  isSubscriptionActive,
  asPaidPlan,
  asBillingInterval,
  planForPriceId,
  priceToPlanMap,
  intervalForPriceId,
  discountSummary,
  type SubscriptionStatus,
  type TenantPlan,
  type BillingInterval,
} from '@/lib/billing';
import {
  isDunningEnabled,
  dunningMaxAttempts,
  decideDunning,
  renderDunningEmail,
  sendDunningEmail,
} from '@/lib/dunning';
import {
  checkWebhookIdempotency,
  createMongoProcessedEventStore,
  resolveWebhookObjectId,
  type ProcessedEventStore,
} from '@/lib/webhook-idempotency';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface StripeObj {
  id?: string;
  object?: string;
  customer?: string;
  subscription?: string;
  status?: string;
  client_reference_id?: string;
  current_period_end?: number;
  metadata?: Record<string, string>;
  // Present on subscription objects — the purchased price(s).
  items?: { data?: Array<{ price?: { id?: string } }> };
  // Present on invoice objects — the failed-attempt counter (dunning).
  attempt_count?: number;
  // Present on subscription objects — the active coupon/discount, if any.
  discount?: { coupon?: { id?: string; name?: string; percent_off?: number; amount_off?: number } } | null;
}
interface StripeEvent {
  id?: string;
  type: string;
  /** Unix seconds — when Stripe created this Event (not the object it wraps). */
  created?: number;
  data: { object: StripeObj };
}

async function findTenant(obj: StripeObj) {
  const tenantId = obj.client_reference_id || obj.metadata?.tenantId;
  if (tenantId) {
    const t = await Tenant.findOne({ tenantId }).exec();
    if (t) return t;
  }
  if (obj.customer) return Tenant.findOne({ stripeCustomerId: obj.customer }).exec();
  return null;
}

/** Which paid tier did this event buy? metadata.plan (set at checkout) wins;
 *  otherwise resolve the subscription's price id; default Solo. */
function resolvePlan(obj: StripeObj): TenantPlan {
  const fromMeta = asPaidPlan(obj.metadata?.plan);
  if (fromMeta) return fromMeta;
  const priceId = obj.items?.data?.[0]?.price?.id;
  return planForPriceId(priceId, priceToPlanMap());
}

/** Which cadence did this event buy? metadata.interval (set at checkout) wins;
 *  otherwise resolve from the subscription's price id; default monthly. */
function resolveInterval(obj: StripeObj): BillingInterval {
  if (obj.metadata?.interval) return asBillingInterval(obj.metadata.interval);
  return intervalForPriceId(obj.items?.data?.[0]?.price?.id);
}

export async function POST(req: Request) {
  if (!isStripeConfigured() || !STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'billing not configured' }, { status: 503 });
  }

  const raw = await req.text();
  const sig = req.headers.get('stripe-signature');
  if (!verifyWebhookSignature(raw, sig, STRIPE_WEBHOOK_SECRET)) {
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  let event: StripeEvent;
  try {
    event = JSON.parse(raw) as StripeEvent;
  } catch {
    return NextResponse.json({ error: 'invalid payload' }, { status: 400 });
  }

  try {
    await connectDB();
    const obj = event.data?.object ?? {};

    // Idempotency (event.id) + out-of-order (event.created vs the subscription's
    // last APPLIED event) guard — Stripe retries deliveries and doesn't guarantee
    // order, so a redelivered/late event must never re-apply a plan change,
    // re-stamp overage, or double-issue an SLA credit. Malformed events without
    // an id (shouldn't happen from real Stripe) skip the guard rather than block.
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
        console.warn('[billing/webhook] duplicate delivery, skipping', event.type, eventId);
        return NextResponse.json({ received: true, duplicate: true });
      }
      if (idem.action === 'stale') {
        console.warn('[billing/webhook] out-of-order event, skipping apply', event.type, eventId);
        return NextResponse.json({ received: true, stale: true });
      }
    }

    const tenant = await findTenant(obj);
    if (!tenant) {
      // Ack so Stripe stops retrying; nothing to do for an unmapped event.
      console.warn('[billing/webhook] no tenant for event', event.type, obj.customer);
      return NextResponse.json({ received: true, matched: false });
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        if (obj.customer) tenant.stripeCustomerId = obj.customer;
        if (obj.subscription) tenant.stripeSubscriptionId = obj.subscription;
        // Checkout completed → entitle on the purchased tier. subscription.updated refines.
        tenant.plan = resolvePlan(obj);
        tenant.billingInterval = resolveInterval(obj);
        tenant.subscriptionStatus = 'active';
        tenant.paymentFailureCount = 0; // fresh subscription clears any prior dunning state
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const status: SubscriptionStatus = normalizeSubscriptionStatus(obj.status);
        if (obj.customer) tenant.stripeCustomerId = obj.customer;
        if (obj.id) tenant.stripeSubscriptionId = obj.id;
        tenant.subscriptionStatus = status;
        if (typeof obj.current_period_end === 'number') {
          tenant.currentPeriodEnd = new Date(obj.current_period_end * 1000);
        }
        // Keep them on the purchased tier while the subscription entitles; drop on lapse.
        const entitling = isSubscriptionActive({ subscriptionStatus: status });
        tenant.plan = entitling ? resolvePlan(obj) : 'free';
        // Reflect the active cadence + discount (mid-cycle plan/interval changes
        // and coupon applications land here via customer.subscription.updated).
        if (entitling) {
          tenant.billingInterval = resolveInterval(obj);
          tenant.discount = discountSummary(obj) ?? undefined;
          // Recovery: a subscription back to active/trialing clears the dunning counter.
          tenant.paymentFailureCount = 0;
        }
        break;
      }
      case 'customer.subscription.deleted': {
        tenant.subscriptionStatus = 'canceled';
        tenant.plan = 'free';
        break;
      }
      case 'invoice.payment_failed': {
        // Stripe fires this once per retry attempt. Record the failure, mark the
        // tenant past_due (pauses paid features via the gate), and — when the
        // dunning switch is on — send the retry-cadence email + auto-downgrade
        // to Free on the final attempt.
        const attempt =
          typeof obj.attempt_count === 'number' && obj.attempt_count > 0
            ? obj.attempt_count
            : (tenant.paymentFailureCount ?? 0) + 1;
        tenant.paymentFailureCount = attempt;
        tenant.lastPaymentFailedAt = new Date();

        if (isDunningEnabled()) {
          const decision = decideDunning({ attempt, currentPlan: tenant.plan as TenantPlan });
          tenant.subscriptionStatus = decision.subscriptionStatus;
          tenant.plan = decision.plan;
          if (tenant.ownerEmail) {
            const email = renderDunningEmail(decision, {
              ownerEmail: tenant.ownerEmail,
              tenantName: tenant.name,
            });
            if (email) await sendDunningEmail(email); // best-effort; never throws
          }
          await tenant.save();
          await markApplied();
          return NextResponse.json({
            received: true,
            tenantId: tenant.tenantId,
            plan: tenant.plan,
            dunning: { attempt, max: dunningMaxAttempts(), downgraded: decision.downgraded },
          });
        }

        // Switch off → still record past_due so the gate/banner are accurate.
        tenant.subscriptionStatus = 'past_due';
        await tenant.save();
        await markApplied();
        return NextResponse.json({
          received: true,
          tenantId: tenant.tenantId,
          plan: tenant.plan,
          dunning: { attempt, recorded: true },
        });
      }
      case 'invoice.payment_succeeded': {
        // Recovery: a successful charge clears the dunning state. The paired
        // subscription.updated re-activates the plan; here we just reset counters.
        tenant.paymentFailureCount = 0;
        tenant.lastPaymentFailedAt = undefined;
        await tenant.save();
        await markApplied();
        return NextResponse.json({ received: true, tenantId: tenant.tenantId, recovered: true });
      }
      default:
        return NextResponse.json({ received: true, ignored: event.type });
    }

    await tenant.save();
    await markApplied();
    return NextResponse.json({ received: true, tenantId: tenant.tenantId, plan: tenant.plan });
  } catch (err) {
    console.error('[billing/webhook] failed:', err);
    return NextResponse.json({ error: 'webhook handling failed' }, { status: 500 });
  }
}
