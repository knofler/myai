// Stripe Connect Express payout wiring for marketplace creators (ADR-019
// follow-up #4 — "Stripe Connect payout wiring... deferred per the ADR").
// SDK-free, same REST-over-fetch pattern as billing.ts (no new npm
// dependency — Docker-only-npm constraint) and reuses its `stripePost`/
// `stripeGet` helpers.
//
// DASHBOARD MIRROR of runtime/src/marketplace/connect-payout.ts (the pure
// state machine + payout gate) — same discipline as marketplace.ts mirroring
// listing-lifecycle.ts: the dashboard's Docker build context is ./dashboard,
// so it cannot import across the package boundary. Keep this byte-equivalent
// in behaviour; runtime/tests/unit/marketplace-connect-payout.test.ts is the
// source of truth for the state machine's correctness.
//
// Two Connect surfaces:
//   1. Onboarding — create an Express account for a creator tenant + a hosted
//      Account Link so they complete Stripe's KYC/bank-details flow, then read
//      the account back to sync `stripeConnectStatus` on the tenant row.
//   2. Payout (trigger only here — the ledger-reading payout RUN is the next
//      follow-up once the marketplace ledger has a real store) — `createTransfer`
//      moves funds from the platform's Stripe balance to a creator's connected
//      account once `decidePayoutWithConnect` (mirrored below) says eligible.
//
// Degrades like billing.ts: `isConnectConfigured()` false → routes return 503.
import { STRIPE_SECRET_KEY, stripePost, stripeGet, APP_BASE_URL } from './billing';

export function isConnectConfigured(): boolean {
  return Boolean(STRIPE_SECRET_KEY);
}

// ── Mirror: runtime/src/marketplace/connect-payout.ts state machine ───────

export type ConnectAccountStatus =
  | 'not_connected'
  | 'onboarding'
  | 'restricted'
  | 'enabled'
  | 'disconnected';

const CONNECT_TRANSITIONS: Record<ConnectAccountStatus, readonly ConnectAccountStatus[]> = {
  not_connected: ['onboarding'],
  onboarding: ['restricted', 'enabled', 'not_connected'],
  restricted: ['enabled', 'disconnected'],
  enabled: ['restricted', 'disconnected'],
  disconnected: ['onboarding'],
};

export interface ConnectTransitionResult {
  ok: boolean;
  reason?: string;
}

export function canTransitionConnectAccount(
  from: ConnectAccountStatus,
  to: ConnectAccountStatus,
): ConnectTransitionResult {
  const allowed = CONNECT_TRANSITIONS[from];
  if (!allowed) return { ok: false, reason: `unknown connect status: ${from}` };
  if (from === to) return { ok: false, reason: `connect account already ${to}` };
  if (!allowed.includes(to)) {
    return { ok: false, reason: `illegal connect transition: ${from} → ${to}` };
  }
  return { ok: true };
}

export function canReceivePayout(status: ConnectAccountStatus): boolean {
  return status === 'enabled';
}

export interface StripeAccountFlags {
  details_submitted?: boolean;
  payouts_enabled?: boolean;
  charges_enabled?: boolean;
  requirements?: { disabled_reason?: string | null } | null;
}

/** Map Stripe's raw Express account flags to our closed enum. Pure — the
 *  status-fetch route and the `account.updated` webhook both funnel through
 *  this one place so the mapping cannot drift between the two call sites. */
export function mapAccountToConnectStatus(account: StripeAccountFlags): ConnectAccountStatus {
  if (account.requirements?.disabled_reason) return 'restricted';
  if (account.payouts_enabled && account.charges_enabled) return 'enabled';
  if (account.details_submitted) return 'restricted';
  return 'onboarding';
}

// ── Stripe Connect REST wiring ─────────────────────────────

export interface StripeConnectAccount extends StripeAccountFlags {
  id: string;
  type?: string;
  email?: string;
}

/**
 * Create a new Stripe Connect Express account for a creator tenant. Express
 * (not Standard/Custom) — Stripe hosts the onboarding UI and the dashboard,
 * minimizing our compliance surface for a v1 creator payout flow. `tenantId`
 * goes in metadata so the `account.updated` webhook can map the account back
 * to the tenant without a separate lookup table.
 */
export async function createConnectAccount(opts: {
  tenantId: string;
  email?: string;
  country?: string; // ISO 3166-1 alpha-2; Stripe defaults from platform settings if omitted
}): Promise<StripeConnectAccount> {
  return stripePost<StripeConnectAccount>('/accounts', {
    type: 'express',
    country: opts.country,
    email: opts.email,
    capabilities: {
      card_payments: { requested: true },
      transfers: { requested: true },
    },
    metadata: { tenantId: opts.tenantId },
  });
}

export interface AccountLink {
  url: string;
  expires_at?: number;
}

/**
 * Create a hosted Account Link the creator opens to complete onboarding
 * (identity, bank details). `refresh_url` is where Stripe sends them back if
 * the link expires mid-flow (re-request a fresh one); `return_url` is where
 * they land after finishing (the dashboard re-checks status there, since
 * `account_onboarding` links don't themselves guarantee completion).
 */
export async function createAccountLink(opts: {
  accountId: string;
  refreshUrl?: string;
  returnUrl?: string;
}): Promise<AccountLink> {
  return stripePost<AccountLink>('/account_links', {
    account: opts.accountId,
    type: 'account_onboarding',
    refresh_url: opts.refreshUrl ?? `${APP_BASE_URL}/marketplace/payouts?status=refresh`,
    return_url: opts.returnUrl ?? `${APP_BASE_URL}/marketplace/payouts?status=return`,
  });
}

/** Fetch a Connect account's current flags — the status-sync read. */
export async function getConnectAccount(accountId: string): Promise<StripeConnectAccount> {
  return stripeGet<StripeConnectAccount>(`/accounts/${accountId}`);
}

export interface StripeTransfer {
  id: string;
  amount: number; // cents
  currency: string;
  destination: string;
}

/**
 * Move funds from the platform's Stripe balance to a creator's connected
 * account — the actual payout disbursement. `idempotencyKey` should be the
 * ledger `payoutBatchId` (ADR-019) so a retried payout run never double-pays;
 * Stripe dedupes on the `Idempotency-Key` header for 24h.
 *
 * Callers MUST have already run `decidePayoutWithConnect` (mirrored above)
 * and confirmed `eligible: true` before calling this — it performs no gating
 * of its own, only the transfer.
 */
export async function createTransfer(opts: {
  accountId: string;
  amountUsd: number;
  currency?: string;
  idempotencyKey: string;
  description?: string;
}): Promise<StripeTransfer> {
  const res = await fetch('https://api.stripe.com/v1/transfers', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': opts.idempotencyKey,
    },
    body: new URLSearchParams({
      amount: String(Math.round(opts.amountUsd * 100)),
      currency: (opts.currency ?? 'usd').toLowerCase(),
      destination: opts.accountId,
      ...(opts.description ? { description: opts.description } : {}),
    }).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } })?.error?.message || `stripe ${res.status}`;
    throw new Error(msg);
  }
  return json as StripeTransfer;
}
