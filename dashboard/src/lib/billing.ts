// Stripe billing for the Solo tier (ADR-010 M5 / §7.2 Day 7) — SDK-free.
//
// We talk to Stripe's REST API directly with `fetch` (form-encoded) so the
// dashboard needs NO new npm dependency (Docker-only-npm constraint) and the
// build stays lean. Three pieces:
//   1. createCheckoutSession  → POST /v1/checkout/sessions (Solo subscription)
//   2. verifyWebhookSignature → validate the `Stripe-Signature` header (HMAC)
//   3. isSubscriptionActive / isEntitled → the gate, mirroring the gateway's
//      runtime/src/core/billing.ts (kept in sync the same way tenant-keys.ts is).
//
// Everything degrades gracefully when Stripe env is unset (local dev / CI):
// `isStripeConfigured()` is false and the routes return 503 rather than crash.

import crypto from 'node:crypto';

// ── Env config ────────────────────────────────────────────────
export const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
export const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
/** Stripe Price id for the recurring Solo subscription (price_…). */
export const STRIPE_SOLO_PRICE_ID = process.env.STRIPE_SOLO_PRICE_ID || '';
/** Stripe Price id for the Team tier subscription (price_…). */
export const STRIPE_TEAM_PRICE_ID = process.env.STRIPE_TEAM_PRICE_ID || '';
/** Stripe Price id for the Scale tier subscription (price_…). */
export const STRIPE_SCALE_PRICE_ID = process.env.STRIPE_SCALE_PRICE_ID || '';
/** Public base URL the checkout success/cancel redirects return to. */
export const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3210';

// ── Billing interval (monthly default; annual is opt-in per-plan) ─────
// Annual price ids are read at call time (env-gated) so a deployment enables the
// annual option simply by setting the matching env var; without them, only the
// monthly cadence is offered and every annual code path is a no-op.
export type BillingInterval = 'month' | 'year';

/** Normalize an arbitrary interval string to a supported one (default month).
 *  Accepts month/monthly and year/yearly/annual/annually. */
export function asBillingInterval(value: string | undefined): BillingInterval {
  const v = (value || '').trim().toLowerCase();
  if (['year', 'yearly', 'annual', 'annually', 'y', 'a'].includes(v)) return 'year';
  return 'month';
}

const STRIPE_API = 'https://api.stripe.com/v1';

export function isStripeConfigured(): boolean {
  return Boolean(STRIPE_SECRET_KEY && STRIPE_SOLO_PRICE_ID);
}

// ── Gate (mirror of runtime/src/core/billing.ts) ──────────────
export type TenantPlan = 'free' | 'solo' | 'team' | 'scale';
export type SubscriptionStatus =
  | 'none' | 'trialing' | 'active' | 'past_due' | 'canceled' | 'incomplete';

export const PAID_PLANS: readonly TenantPlan[] = ['solo', 'team', 'scale'];
/** Only `active`/`trialing` entitle — `past_due` is a dunning grace, not a pass. */
export const ACTIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['active', 'trialing'];

export interface BillingState {
  plan: TenantPlan;
  subscriptionStatus?: SubscriptionStatus;
  /** True for the local single-operator default tenant (never billing-gated). */
  local?: boolean;
}

export function isSubscriptionActive(state: Pick<BillingState, 'subscriptionStatus'>): boolean {
  return ACTIVE_SUBSCRIPTION_STATUSES.includes(state.subscriptionStatus ?? 'none');
}

export function isPaidPlan(plan: TenantPlan): boolean {
  return PAID_PLANS.includes(plan);
}

/** May this tenant use paid/autonomous features? Local default → always; a real
 *  tenant needs a paid plan AND an active subscription. */
export function isEntitled(state: BillingState): boolean {
  if (state.local) return true;
  return isPaidPlan(state.plan) && isSubscriptionActive(state);
}

export function entitlementReason(state: BillingState): string | null {
  if (isEntitled(state)) return null;
  if (!isPaidPlan(state.plan)) return 'free plan — subscribe to Solo to enable autonomous work';
  return `subscription ${state.subscriptionStatus ?? 'none'} — renew your Solo subscription to continue`;
}

// ── Per-plan entitlement limits (mirror of runtime/src/core/billing.ts) ──
// Kept in lock-step with the gateway so checkout / webhook / gate / UI agree on
// what each tier unlocks. A limit of -1 means "unlimited".
export interface PlanLimits {
  brainMaxAtoms: number;   // max brain atoms (-1 = unlimited)
  teamSeats: number;       // max member seats (-1 = unlimited)
  hostedBrain: boolean;    // managed cross-machine brain remote available?
  requestsPerMin: number;  // per-tenant burst ceiling: gateway req/min (-1 = unlimited)
  monthlyRequests: number; // per-tenant monthly request quota (-1 = unlimited)
  includedSpendUsd: number; // $ of LLM spend included before the 80%/100% spend alert (-1 = unlimited)
  teamFleetConsole: boolean; // cross-machine "who's doing what" panel on /fleet (GO_LIVE_PLAN Team tier)
}

export const PLAN_LIMITS: Readonly<Record<TenantPlan, PlanLimits>> = {
  free: { brainMaxAtoms: 500, teamSeats: 1, hostedBrain: false, requestsPerMin: 60, monthlyRequests: 10_000, includedSpendUsd: 5, teamFleetConsole: false },
  solo: { brainMaxAtoms: 5_000, teamSeats: 1, hostedBrain: true, requestsPerMin: 300, monthlyRequests: 200_000, includedSpendUsd: 50, teamFleetConsole: false },
  team: { brainMaxAtoms: 50_000, teamSeats: 10, hostedBrain: true, requestsPerMin: 1_000, monthlyRequests: 2_000_000, includedSpendUsd: 250, teamFleetConsole: true },
  scale: { brainMaxAtoms: -1, teamSeats: -1, hostedBrain: true, requestsPerMin: -1, monthlyRequests: -1, includedSpendUsd: -1, teamFleetConsole: true },
} as const;

export function planLimits(plan: TenantPlan): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}
export function withinBrainLimit(plan: TenantPlan, count: number): boolean {
  const max = planLimits(plan).brainMaxAtoms;
  return max < 0 || count <= max;
}
export function canAddSeat(plan: TenantPlan, currentSeats: number): boolean {
  const max = planLimits(plan).teamSeats;
  return max < 0 || currentSeats < max;
}
export function hasHostedBrain(plan: TenantPlan): boolean {
  return planLimits(plan).hostedBrain;
}
/** Team tier gate for the /fleet "Team Activity" panel — the cross-machine
 *  view of every teammate's latest sweep on a shared tenant. Free/Solo are
 *  single-seat, so there is nothing to show; Team/Scale unlock it. */
export function hasTeamFleetConsole(plan: TenantPlan): boolean {
  return planLimits(plan).teamFleetConsole;
}

// ── Stripe price ↔ plan mapping (env-sourced, interval-aware) ─────────
// Read at call time so tests can toggle env and a deployment can add the annual
// cadence without a rebuild. Monthly is the baseline; annual price ids are
// separate env vars (…_PRICE_ID_ANNUAL) and only offered when set.
function monthlyPriceId(plan: TenantPlan): string {
  switch (plan) {
    case 'solo': return process.env.STRIPE_SOLO_PRICE_ID || '';
    case 'team': return process.env.STRIPE_TEAM_PRICE_ID || '';
    case 'scale': return process.env.STRIPE_SCALE_PRICE_ID || '';
    default: return '';
  }
}
function annualPriceId(plan: TenantPlan): string {
  switch (plan) {
    case 'solo': return process.env.STRIPE_SOLO_PRICE_ID_ANNUAL || '';
    case 'team': return process.env.STRIPE_TEAM_PRICE_ID_ANNUAL || '';
    case 'scale': return process.env.STRIPE_SCALE_PRICE_ID_ANNUAL || '';
    default: return '';
  }
}

/** Stripe Price id for a paid plan at the given interval (default monthly), from
 *  env. Empty string if that plan/interval is not configured. */
export function priceIdForPlan(plan: TenantPlan, interval: BillingInterval = 'month'): string {
  return interval === 'year' ? annualPriceId(plan) : monthlyPriceId(plan);
}

/** Is the annual cadence available (price configured) for this plan? */
export function annualAvailableForPlan(plan: TenantPlan): boolean {
  return Boolean(annualPriceId(plan));
}

/** Reverse map (configured price id → plan), for the webhook to resolve a
 *  subscription's price back to a tier. Includes BOTH cadences so a subscription
 *  bought annually still maps to its plan. Only includes configured prices. */
export function priceToPlanMap(): Record<string, TenantPlan> {
  const map: Record<string, TenantPlan> = {};
  for (const plan of PAID_PLANS) {
    for (const id of [monthlyPriceId(plan), annualPriceId(plan)]) {
      if (id) map[id] = plan;
    }
  }
  return map;
}

/** Reverse map (configured price id → interval), so the webhook/status can
 *  reflect which cadence a subscription's price represents. */
export function priceToIntervalMap(): Record<string, BillingInterval> {
  const map: Record<string, BillingInterval> = {};
  for (const plan of PAID_PLANS) {
    const m = monthlyPriceId(plan);
    const a = annualPriceId(plan);
    if (m) map[m] = 'month';
    if (a) map[a] = 'year';
  }
  return map;
}

/** Resolve a price id to its billing interval (default 'month' if unknown). */
export function intervalForPriceId(
  priceId: string | undefined,
  map: Record<string, BillingInterval> = priceToIntervalMap(),
): BillingInterval {
  return (priceId && map[priceId]) || 'month';
}

/** Which paid plans have a configured Stripe price (monthly) — i.e. purchasable? */
export function purchasablePlans(): TenantPlan[] {
  return PAID_PLANS.filter((p) => Boolean(monthlyPriceId(p)));
}

/** Normalize an arbitrary string to a known paid plan, or null if not one. */
export function asPaidPlan(value: string | undefined): TenantPlan | null {
  return value && (PAID_PLANS as readonly string[]).includes(value)
    ? (value as TenantPlan)
    : null;
}

/** Resolve a Stripe price id to a plan via a price→plan map (default map =
 *  the env-configured prices). Unknown/absent → `fallback` (default 'solo'). */
export function planForPriceId(
  priceId: string | undefined,
  priceToPlans: Record<string, TenantPlan> = priceToPlanMap(),
  fallback: TenantPlan = 'solo',
): TenantPlan {
  if (priceId && priceToPlans[priceId]) return priceToPlans[priceId];
  return fallback;
}

// ── Promo / coupon codes (env-gated) ──────────────────────────
// A deployment turns on discount redemption with STRIPE_PROMO_CODES_ENABLED.
// When on, checkout either (a) applies an operator-supplied coupon/promotion-code
// id directly, or (b) lets the customer type a promotion code in Stripe's hosted
// UI (`allow_promotion_codes`). Stripe forbids combining the two, so a supplied
// id wins. Off → no discount params are ever sent (codes are silently ignored).
function truthyEnv(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v || '').toLowerCase());
}

/** Master switch: is promo/coupon redemption enabled on this deployment? */
export function arePromoCodesEnabled(): boolean {
  return truthyEnv(process.env.STRIPE_PROMO_CODES_ENABLED);
}

export interface DiscountInput {
  /** Enabled gate (defaults to the env switch when omitted). */
  enabled?: boolean;
  /** A Stripe coupon id (coupon_…) to apply directly. */
  couponId?: string;
  /** A Stripe promotion code id (promo_…) to apply directly. */
  promotionCodeId?: string;
}

/**
 * Build the Stripe Checkout discount params from a discount input. Pure so it is
 * unit-testable without env. Precedence when enabled: a supplied coupon or
 * promotion-code id → `discounts:[…]`; otherwise `allow_promotion_codes:true`
 * (customer types a code at checkout). Disabled → `{}` (no discount surface).
 */
export function buildDiscountParams(input: DiscountInput = {}): Record<string, unknown> {
  const enabled = input.enabled ?? arePromoCodesEnabled();
  if (!enabled) return {};
  if (input.promotionCodeId) return { discounts: [{ promotion_code: input.promotionCodeId }] };
  if (input.couponId) return { discounts: [{ coupon: input.couponId }] };
  return { allow_promotion_codes: true };
}

// ── Stripe Tax — automatic sales-tax/VAT/GST at checkout (env-gated) ──
// A deployment turns on Stripe Tax with STRIPE_TAX_ENABLED. When on, Checkout
// collects the customer's billing address (Stripe determines their region from
// it) and computes tax automatically; `automatic_tax` carries over from the
// Checkout Session onto the resulting subscription, so every recurring invoice
// is computed — and shows a tax line — for that tenant's region too, with no
// per-invoice code on our side. `tax_id_collection` additionally lets a business
// customer enter a VAT/GST number for reverse-charge handling. Off (default) →
// no tax params are sent, matching today's behavior exactly.
export function isAutomaticTaxEnabled(): boolean {
  return truthyEnv(process.env.STRIPE_TAX_ENABLED);
}

export interface AutomaticTaxInput {
  /** Enabled gate (defaults to the env switch when omitted). */
  enabled?: boolean;
  /** True when reusing an existing Stripe customer id (vs. a bare email) —
   *  Stripe requires `customer_update.address:'auto'` so Checkout is allowed to
   *  refresh that customer's stored address before computing tax. */
  hasExistingCustomer?: boolean;
}

/**
 * Build the Stripe Checkout params that enable Stripe Tax. Pure so it is
 * unit-testable without env. Disabled → `{}` (no tax surface, current
 * behavior). Enabled → collect the billing address, turn on automatic tax
 * calculation, and offer VAT/GST id entry; when reusing an existing customer,
 * also allow Checkout to refresh that customer's stored address.
 */
export function buildAutomaticTaxParams(input: AutomaticTaxInput = {}): Record<string, unknown> {
  const enabled = input.enabled ?? isAutomaticTaxEnabled();
  if (!enabled) return {};
  const params: Record<string, unknown> = {
    automatic_tax: { enabled: true },
    billing_address_collection: 'required',
    tax_id_collection: { enabled: true },
  };
  if (input.hasExistingCustomer) {
    params.customer_update = { address: 'auto', name: 'auto' };
  }
  return params;
}

// ── Proration on tier change (upgrade / downgrade mid-cycle) ───
// Rank paid tiers so we can tell an upgrade from a downgrade. Free ranks 0.
const PLAN_RANK: Record<TenantPlan, number> = { free: 0, solo: 1, team: 2, scale: 3 };

/** Numeric rank of a plan (higher = more expensive tier). */
export function planRank(plan: TenantPlan): number {
  return PLAN_RANK[plan] ?? 0;
}
/** Is moving from → to an upgrade (to a higher-ranked tier)? */
export function isUpgrade(from: TenantPlan, to: TenantPlan): boolean {
  return planRank(to) > planRank(from);
}

export type ProrationBehavior = 'create_prorations' | 'none' | 'always_invoice';

/**
 * Decide the Stripe `proration_behavior` for a mid-cycle tier change.
 *  - Upgrade  → `always_invoice`: charge the prorated difference immediately so
 *    the higher tier is paid for now, not deferred to next cycle.
 *  - Downgrade → `create_prorations`: credit the unused time toward future
 *    invoices (no immediate refund), the standard SaaS downgrade behaviour.
 *  - Same tier (interval switch only) → `create_prorations`.
 */
export function prorationBehaviorForChange(from: TenantPlan, to: TenantPlan): ProrationBehavior {
  return isUpgrade(from, to) ? 'always_invoice' : 'create_prorations';
}

// ── Stripe REST helpers ───────────────────────────────────────

/** Flatten a (possibly nested) object into Stripe's form-encoded shape:
 *  { line_items: [{ price: 'x', quantity: 1 }] } → line_items[0][price]=x&… */
export function stripeForm(obj: Record<string, unknown>, prefix = ''): URLSearchParams {
  const params = new URLSearchParams();
  const add = (key: string, val: unknown) => {
    if (val === undefined || val === null) return;
    if (Array.isArray(val)) {
      val.forEach((v, i) => {
        if (v !== null && typeof v === 'object') {
          for (const [k, p] of stripeForm(v as Record<string, unknown>, `${key}[${i}]`)) params.append(k, p);
        } else {
          params.append(`${key}[${i}]`, String(v));
        }
      });
    } else if (typeof val === 'object') {
      for (const [k, p] of stripeForm(val as Record<string, unknown>, key)) params.append(k, p);
    } else {
      params.append(key, String(val));
    }
  };
  for (const [k, v] of Object.entries(obj)) add(prefix ? `${prefix}[${k}]` : k, v);
  return params;
}

/** POST to the Stripe API (form-encoded). Exported so other SDK-free Stripe
 *  wrappers (marketplace-connect.ts — Connect accounts/links/transfers) reuse
 *  the same auth + error-shape handling instead of duplicating a fetch client. */
export async function stripePost<T>(
  path: string,
  body: Record<string, unknown>,
  opts: { stripeAccount?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  };
  // On-behalf-of / acting-as a connected account (used for Connect reads that
  // must be scoped to the creator's own account rather than the platform's).
  if (opts.stripeAccount) headers['Stripe-Account'] = opts.stripeAccount;
  const res = await fetch(`${STRIPE_API}${path}`, {
    method: 'POST',
    headers,
    body: stripeForm(body).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message || `stripe ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

/** GET from the Stripe API. Exported for marketplace-connect.ts's account
 *  status fetch (mirrors the POST helper's auth + error handling). */
export async function stripeGet<T>(path: string): Promise<T> {
  const res = await fetch(`${STRIPE_API}${path}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message || `stripe ${res.status}`;
    throw new Error(msg);
  }
  return json as T;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

/**
 * Create a Stripe Checkout Session for a subscription to `plan` (defaults to
 * Solo). `tenantId` and the chosen `plan` are passed as both `client_reference_id`
 * / metadata AND subscription metadata so the webhook can map the resulting
 * subscription back to the tenant AND know which tier to grant. Reuses an
 * existing Stripe customer when known.
 *
 * Throws if the plan is not a purchasable paid plan (no configured price id).
 */
export async function createCheckoutSession(opts: {
  tenantId: string;
  plan?: TenantPlan;
  /** Billing cadence — 'month' (default) or 'year' (annual, if configured). */
  interval?: BillingInterval;
  ownerEmail?: string;
  stripeCustomerId?: string;
  /** Discount to apply (env-gated). A coupon/promotion-code id applies directly;
   *  otherwise, if promo codes are enabled, the customer may type one at checkout. */
  couponId?: string;
  promotionCodeId?: string;
}): Promise<CheckoutSession> {
  const plan: TenantPlan = opts.plan ?? 'solo';
  const interval: BillingInterval = opts.interval ?? 'month';
  const priceId = priceIdForPlan(plan, interval);
  if (!isPaidPlan(plan) || !priceId) {
    throw new Error(`plan "${plan}" (${interval}) is not available for checkout`);
  }
  const meta = { tenantId: opts.tenantId, plan, interval };
  const body: Record<string, unknown> = {
    mode: 'subscription',
    client_reference_id: opts.tenantId,
    success_url: `${APP_BASE_URL}/billing?status=success&session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${APP_BASE_URL}/billing?status=cancel`,
    line_items: [{ price: priceId, quantity: 1 }],
    subscription_data: { metadata: meta },
    metadata: meta,
    // Promo/coupon params only present when promo codes are enabled (env-gated).
    ...buildDiscountParams({ couponId: opts.couponId, promotionCodeId: opts.promotionCodeId }),
    // Stripe Tax params only present when tax is enabled (env-gated) — collects
    // the billing address and computes sales-tax/VAT/GST for the tenant's region.
    ...buildAutomaticTaxParams({ hasExistingCustomer: Boolean(opts.stripeCustomerId) }),
  };
  if (opts.stripeCustomerId) body.customer = opts.stripeCustomerId;
  else if (opts.ownerEmail) body.customer_email = opts.ownerEmail;
  return stripePost<CheckoutSession>('/checkout/sessions', body);
}

/**
 * Change an existing subscription's tier/interval in place with correct
 * proration (upgrade → charge the difference now; downgrade → credit forward).
 * Swaps the single subscription item to the new plan's price and applies the
 * computed `proration_behavior`. `currentPlan` decides upgrade vs downgrade;
 * pass it from the tenant row. Returns the updated subscription.
 *
 * Throws if the target plan/interval has no configured price. The caller resolves
 * the subscription's item id first (getSubscription → items.data[0].id).
 */
export async function changeSubscriptionPlan(opts: {
  subscriptionId: string;
  itemId: string;
  currentPlan: TenantPlan;
  plan: TenantPlan;
  interval?: BillingInterval;
}): Promise<StripeSubscription> {
  const interval: BillingInterval = opts.interval ?? 'month';
  const priceId = priceIdForPlan(opts.plan, interval);
  if (!isPaidPlan(opts.plan) || !priceId) {
    throw new Error(`plan "${opts.plan}" (${interval}) is not available for change`);
  }
  const meta = { plan: opts.plan, interval };
  return stripePost<StripeSubscription>(`/subscriptions/${opts.subscriptionId}`, {
    items: [{ id: opts.itemId, price: priceId }],
    proration_behavior: prorationBehaviorForChange(opts.currentPlan, opts.plan),
    // Keep the plan reflected on the subscription (the webhook's source of truth).
    metadata: meta,
  });
}

/** Back-compat alias — the original Solo-only entry point. */
export async function createSoloCheckoutSession(opts: {
  tenantId: string;
  ownerEmail?: string;
  stripeCustomerId?: string;
}): Promise<CheckoutSession> {
  return createCheckoutSession({ ...opts, plan: 'solo' });
}

export interface PortalSession {
  id: string;
  url: string;
}

/**
 * Create a Stripe Billing Portal session so a tenant can manage/cancel their
 * subscription and update payment details. Requires an existing Stripe customer
 * (set on the tenant by the webhook after the first checkout).
 */
export async function createBillingPortalSession(opts: {
  stripeCustomerId: string;
  returnUrl?: string;
}): Promise<PortalSession> {
  return stripePost<PortalSession>('/billing_portal/sessions', {
    customer: opts.stripeCustomerId,
    return_url: opts.returnUrl ?? `${APP_BASE_URL}/billing`,
  });
}

/** Fetch a subscription (used by the webhook to read status + period end). */
export async function getSubscription(subscriptionId: string): Promise<StripeSubscription> {
  const res = await fetch(`${STRIPE_API}/subscriptions/${subscriptionId}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((json as { error?: { message?: string } })?.error?.message || `stripe ${res.status}`);
  return json as StripeSubscription;
}

export interface StripeSubscription {
  id: string;
  status: string;
  customer: string;
  current_period_end?: number;
  metadata?: Record<string, string>;
  items?: { data?: Array<{ id?: string; price?: { id?: string; recurring?: { interval?: string } } }> };
  discount?: { coupon?: { id?: string; name?: string; percent_off?: number; amount_off?: number } } | null;
}

/** The subscription item id (first item) — needed to swap its price on a plan
 *  change. Returns undefined if the subscription has no items. */
export function firstItemId(sub: StripeSubscription): string | undefined {
  return sub.items?.data?.[0]?.id;
}

/** A compact, storable summary of a subscription's active discount, or null. */
export interface DiscountSummary {
  couponId?: string;
  name?: string;
  percentOff?: number;
  amountOff?: number;
}
export function discountSummary(sub: Pick<StripeSubscription, 'discount'>): DiscountSummary | null {
  const c = sub.discount?.coupon;
  if (!c) return null;
  return {
    couponId: c.id,
    name: c.name,
    percentOff: typeof c.percent_off === 'number' ? c.percent_off : undefined,
    amountOff: typeof c.amount_off === 'number' ? c.amount_off : undefined,
  };
}

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header, scheme
 * `t=<ts>,v1=<hmac>`). HMAC-SHA256 over `"<ts>.<rawBody>"` with the endpoint
 * secret, constant-time compared, with a replay-tolerance window. `nowSeconds`
 * is injectable for testing. Returns true only on a valid, in-window signature.
 */
export function verifyWebhookSignature(
  rawBody: string,
  sigHeader: string | null,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!sigHeader || !secret) return false;
  let timestamp = '';
  const signatures: string[] = [];
  for (const part of sigHeader.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') timestamp = v?.trim() ?? '';
    else if (k === 'v1' && v) signatures.push(v.trim());
  }
  if (!timestamp || signatures.length === 0) return false;

  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowSeconds - ts) > toleranceSeconds) return false;

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`, 'utf8')
    .digest('hex');
  const expectedBuf = Buffer.from(expected, 'hex');
  // Constant-time compare against each provided v1 signature.
  return signatures.some((sig) => {
    let sigBuf: Buffer;
    try {
      sigBuf = Buffer.from(sig, 'hex');
    } catch {
      return false;
    }
    return sigBuf.length === expectedBuf.length && crypto.timingSafeEqual(sigBuf, expectedBuf);
  });
}

/** Map a raw Stripe subscription.status string to our enum (unknown → 'none'). */
export function normalizeSubscriptionStatus(raw: string | undefined): SubscriptionStatus {
  const allowed: SubscriptionStatus[] = ['trialing', 'active', 'past_due', 'canceled', 'incomplete'];
  return allowed.includes(raw as SubscriptionStatus) ? (raw as SubscriptionStatus) : 'none';
}
