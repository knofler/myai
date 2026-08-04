/**
 * Stripe Connect payout wiring — the pure model layer (ADR-019 follow-up #4,
 * "Stripe Connect payout wiring... deferred per the ADR").
 *
 * ADR-019 fixed the ledger + revenue-share math (revenue-share.ts) and the
 * catalog/install state machines (listing-lifecycle.ts) but explicitly left
 * "actual charging/paying" for a follow-up. This module is that follow-up's
 * pure core: the creator's Connect account onboarding state machine, plus the
 * combined payout gate that a payout run must check before it may disburse —
 * a creator can accrue ledger balance long before they finish onboarding, but
 * a payout must never be attempted against an account that can't receive
 * funds (Stripe would reject the Transfer, or worse, funds would strand).
 *
 * No Stripe SDK, no I/O — the real Stripe Connect REST calls live in
 * dashboard/src/lib/marketplace-connect.ts (mirrors billing.ts's SDK-free
 * pattern) and call `mapAccountToConnectStatus` here to turn Stripe's account
 * flags into this closed enum before storing it on the tenant row.
 */
import type { CreatorBalance, PayoutDecision } from './revenue-share.js';
import { decidePayout, DEFAULT_MIN_PAYOUT_USD } from './revenue-share.js';

/**
 * A creator tenant's Stripe Connect Express account state.
 *
 *   not_connected ──► onboarding ──► enabled ◄──► restricted
 *                         │                            │
 *                         ▼                            ▼
 *                   not_connected               disconnected
 *                   (abandoned)                  (creator disconnects)
 *
 * `restricted` covers both "submitted but Stripe hasn't cleared payouts yet"
 * and "previously enabled, now restricted for compliance" — both states block
 * payout the same way (canReceivePayout), so the model doesn't need to
 * distinguish them; Stripe's own dashboard is the detail view for that.
 */
export type ConnectAccountStatus =
  | 'not_connected'
  | 'onboarding'
  | 'restricted'
  | 'enabled'
  | 'disconnected';

const CONNECT_TRANSITIONS: Record<ConnectAccountStatus, readonly ConnectAccountStatus[]> = {
  not_connected: ['onboarding'],
  onboarding: ['restricted', 'enabled', 'not_connected'], // abandoned onboarding link
  restricted: ['enabled', 'disconnected'],
  enabled: ['restricted', 'disconnected'],
  disconnected: ['onboarding'], // reconnecting starts a fresh onboarding
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

/** Only an `enabled` account may receive a payout (Stripe's `payouts_enabled`). */
export function canReceivePayout(status: ConnectAccountStatus): boolean {
  return status === 'enabled';
}

/**
 * Map Stripe's raw Express account flags to our closed enum. Pure so it is
 * unit-testable without a live Stripe account; the dashboard's account-status
 * fetch and the `account.updated` webhook both funnel through this one place
 * so the mapping cannot drift between the two call sites.
 */
export function mapAccountToConnectStatus(account: {
  details_submitted?: boolean;
  payouts_enabled?: boolean;
  charges_enabled?: boolean;
  requirements?: { disabled_reason?: string | null } | null;
}): ConnectAccountStatus {
  if (account.requirements?.disabled_reason) return 'restricted';
  if (account.payouts_enabled && account.charges_enabled) return 'enabled';
  if (account.details_submitted) return 'restricted'; // submitted, Stripe still clearing
  return 'onboarding';
}

export interface ConnectPayoutDecision extends PayoutDecision {
  connectStatus: ConnectAccountStatus;
}

/**
 * The full payout gate a payout run checks per creator: cleared balance must
 * meet the minimum (`decidePayout`, revenue-share.ts) AND the Connect account
 * must be able to receive funds. Either failing blocks the payout for this
 * run — the balance is never lost, it rolls forward to the next run once the
 * creator finishes onboarding or the balance clears the threshold.
 */
export function decidePayoutWithConnect(
  balance: CreatorBalance,
  connectStatus: ConnectAccountStatus,
  minPayoutUsd: number = DEFAULT_MIN_PAYOUT_USD,
): ConnectPayoutDecision {
  if (!canReceivePayout(connectStatus)) {
    return {
      eligible: false,
      amountUsd: 0,
      reason: `creator Connect account not payout-ready (status: ${connectStatus})`,
      connectStatus,
    };
  }
  return { ...decidePayout(balance, minPayoutUsd), connectStatus };
}

// ── Clearance / hold window ────────────────────────────────
// A `pending` ledger entry (billing.ts §4 "sale" / "subscription_cycle" /
// "usage" rows) clears to `available` after a hold window — time for a
// dispute/chargeback to surface before the money is payable to the creator.
// This is the missing link between the billing/usage-metering pipeline (which
// appends `pending` rows at the charge boundary) and the payout run (which
// only ever pays `available` balance): something has to decide when a pending
// row may flip. That decision is pure — the actual status mutation is the
// store's job (append-only discipline: this only answers "may I clear this
// row now", it never mutates anything itself).

/** Default hold window before a pending ledger entry clears (days). Mirrors
 *  Stripe's own rolling-basis payout delay for a new/standard account. */
export const DEFAULT_HOLD_DAYS = 2;

/** Has the hold window elapsed for an entry that occurred at `occurredAt`? */
export function isClearanceElapsed(
  occurredAt: string,
  holdDays: number = DEFAULT_HOLD_DAYS,
  now: Date = new Date(),
): boolean {
  const occurred = new Date(occurredAt).getTime();
  if (!Number.isFinite(occurred)) return false;
  const holdMs = holdDays * 24 * 60 * 60 * 1000;
  return now.getTime() - occurred >= holdMs;
}
