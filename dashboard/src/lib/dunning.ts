// Dunning + failed-payment recovery (ADR-010 billing follow-up). When a Stripe
// subscription payment fails, Stripe retries on its own schedule and fires
// `invoice.payment_failed` on each attempt. This module turns those events into:
//   1. a recorded dunning state on the tenant (past_due + failure count),
//   2. a retry-cadence email nudging the customer to fix their card, and
//   3. an auto-downgrade to Free after the final failed attempt.
// Recovery (`invoice.payment_succeeded`) clears the dunning state.
//
// Same discipline as dashboard/src/lib/overage.ts: SDK-free, PURE decision core
// (unit-tested with no DB/network), and ENV-GATED end-to-end. The side-effecting
// parts (sending email, auto-downgrade) only fire when the master switch is on:
//   STRIPE_DUNNING_ENABLED       "1"/"true"/"yes"/"on" — master switch (default OFF)
//   STRIPE_DUNNING_MAX_ATTEMPTS  failed attempts before auto-downgrade (default 4)
// The webhook still RECORDS past_due + the failure count when the switch is off
// (that is harmless and keeps the banner accurate); only the email cadence and
// the downgrade are gated. The billing gate (lib/billing.ts) already treats
// `past_due` as non-entitling, so autonomous work is paused the moment we mark it.

import { APP_BASE_URL, type SubscriptionStatus, type TenantPlan } from './billing';

// ── Env (read at call time so tests can toggle process.env) ────
function truthy(v: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes((v || '').toLowerCase());
}
function numEnv(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

/** Failed attempts before the tenant is auto-downgraded to Free (env-tunable). */
export function dunningMaxAttempts(): number {
  return numEnv('STRIPE_DUNNING_MAX_ATTEMPTS', 4);
}

/** Master switch: is the dunning email cadence + auto-downgrade turned on AND a
 *  Stripe secret key present? Off → the webhook only records past_due/count. */
export function isDunningEnabled(): boolean {
  return truthy(process.env.STRIPE_DUNNING_ENABLED) && Boolean(process.env.STRIPE_SECRET_KEY);
}

// ── Retry-cadence copy (pure) ─────────────────────────────────
// One step per failed attempt. `dayOffset` is informational (mirrors Stripe's
// default Smart Retries spacing) so the copy can tell the customer roughly when
// the next automatic retry lands. The final step warns that this is the last
// attempt before downgrade.
export interface DunningStep {
  /** 1-based failed-payment attempt this email corresponds to. */
  attempt: number;
  /** Approx. days since the first failure (Stripe's default retry spacing). */
  dayOffset: number;
  /** True on the last attempt — the next failure downgrades to Free. */
  final: boolean;
  /** Short headline used as the email subject and the banner title. */
  headline: string;
}

/** The escalating headline for the Nth failed attempt, clamped to [1, max]. */
function headlineFor(attempt: number, max: number): string {
  if (attempt >= max) return 'Final notice: update your payment method to keep myAI';
  if (attempt <= 1) return 'Your myAI payment failed — please update your card';
  return `We still couldn't charge your card (attempt ${attempt} of ${max})`;
}

/** Approximate day offset for the Nth attempt (Stripe Smart Retries default). */
function dayOffsetFor(attempt: number): number {
  const spacing = [0, 3, 5, 7, 7];
  return spacing[Math.min(attempt - 1, spacing.length - 1)] ?? 7;
}

/**
 * The cadence step for a given failed-payment attempt (1-based), or null when
 * `attempt` is below 1. Attempts at/over the configured max resolve to the
 * `final` step (the last email before auto-downgrade). PURE.
 */
export function dunningStepForAttempt(attempt: number, max = dunningMaxAttempts()): DunningStep | null {
  if (!Number.isFinite(attempt) || attempt < 1) return null;
  const clamped = Math.min(Math.floor(attempt), max);
  return {
    attempt: clamped,
    dayOffset: dayOffsetFor(clamped),
    final: clamped >= max,
    headline: headlineFor(clamped, max),
  };
}

/** Has the tenant hit the final failed attempt (→ auto-downgrade)? PURE. */
export function shouldDowngrade(attempt: number, max = dunningMaxAttempts()): boolean {
  return Number.isFinite(attempt) && attempt >= max;
}

/** Is this subscription state a dunning (payment-recovery) state? */
export function isInDunning(status: SubscriptionStatus | undefined): boolean {
  return status === 'past_due';
}

// ── The decision (pure) ───────────────────────────────────────
export interface DunningDecision {
  /** The normalized attempt number this decision was made for. */
  attempt: number;
  /** Subscription status to persist: `past_due` while retrying, `canceled` on downgrade. */
  subscriptionStatus: Extract<SubscriptionStatus, 'past_due' | 'canceled'>;
  /** Plan to persist: unchanged while retrying, `free` on downgrade. */
  plan: TenantPlan;
  /** True when this attempt triggers the auto-downgrade to Free. */
  downgraded: boolean;
  /** The cadence email to send for this attempt (null if no email applies). */
  step: DunningStep | null;
}

/**
 * Decide what a failed-payment attempt does to a tenant. PURE — no I/O. Before
 * the final attempt the tenant is held in `past_due` on their current plan (the
 * gate pauses paid features but the subscription can still recover). On the
 * final attempt the tenant is downgraded to Free and marked `canceled`.
 */
export function decideDunning(opts: {
  attempt: number;
  currentPlan: TenantPlan;
  max?: number;
}): DunningDecision {
  const max = opts.max ?? dunningMaxAttempts();
  const attempt = Math.max(1, Math.floor(opts.attempt) || 1);
  const step = dunningStepForAttempt(attempt, max);
  if (shouldDowngrade(attempt, max)) {
    return { attempt, subscriptionStatus: 'canceled', plan: 'free', downgraded: true, step };
  }
  return { attempt, subscriptionStatus: 'past_due', plan: opts.currentPlan, downgraded: false, step };
}

// ── Email rendering (pure) ────────────────────────────────────
export interface DunningEmail {
  to: string;
  subject: string;
  text: string;
}

export interface DunningEmailContext {
  ownerEmail: string;
  tenantName?: string;
  /** Where the customer updates their card (defaults to the billing page). */
  manageUrl?: string;
  max?: number;
}

/**
 * Render the retry-cadence email for a decision. Returns null when there is no
 * owner email or no applicable step. PURE (safe to unit-test).
 */
export function renderDunningEmail(
  decision: DunningDecision,
  ctx: DunningEmailContext,
): DunningEmail | null {
  if (!ctx.ownerEmail || !decision.step) return null;
  const max = ctx.max ?? dunningMaxAttempts();
  const manageUrl = ctx.manageUrl || `${APP_BASE_URL}/billing`;
  const who = ctx.tenantName ? `${ctx.tenantName} team` : 'there';
  const lines: string[] = [`Hi ${who},`, ''];

  if (decision.downgraded) {
    lines.push(
      `We were unable to collect payment for your myAI subscription after ${max} attempts,`,
      `so your workspace has been downgraded to the Free plan. Autonomous/off-hours work`,
      `is paused until you resubscribe.`,
      '',
      `You can resubscribe any time here: ${manageUrl}`,
    );
  } else {
    const next = decision.step.final
      ? 'This is our final attempt — the next failure will downgrade you to Free.'
      : 'Stripe will retry automatically, but updating your card now avoids any interruption.';
    lines.push(
      `We couldn't process the latest payment for your myAI subscription`,
      `(attempt ${decision.attempt} of ${max}). Your paid features are paused until the`,
      `payment succeeds.`,
      '',
      next,
      '',
      `Update your payment method here: ${manageUrl}`,
    );
  }
  lines.push('', '— The myAI team');

  return { to: ctx.ownerEmail, subject: decision.step.headline, text: lines.join('\n') };
}

// ── Email delivery (pluggable; console fallback) ──────────────
// The dashboard has no bundled mail transport, so — mirroring the gateway
// mailer's `consoleTransport` self-host default — we log the message by default
// and let a real transport (SMTP relay, gateway notify, Resend, …) be injected
// via setDunningMailer(). Tests inject a spy; a self-host deploy sees the mail
// in the dashboard logs; a hosted deploy wires a real sender at startup.
export type DunningMailer = (email: DunningEmail) => Promise<void>;

let mailer: DunningMailer | null = null;

/** Override the dunning mail sender (tests, real transports). null → console. */
export function setDunningMailer(fn: DunningMailer | null): void {
  mailer = fn;
}

/** Send a dunning email via the active transport (console fallback). Never throws. */
export async function sendDunningEmail(email: DunningEmail): Promise<boolean> {
  try {
    if (mailer) {
      await mailer(email);
    } else {
      console.log(
        `[dunning] MAIL to=${email.to} subject="${email.subject}"\n${email.text}\n` +
          '(console transport — inject setDunningMailer() to send real email)',
      );
    }
    return true;
  } catch (err) {
    console.error('[dunning] email send failed:', (err as Error).message);
    return false;
  }
}
