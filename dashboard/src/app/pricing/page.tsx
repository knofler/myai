'use client';

// /pricing — the standalone self-serve pricing page (GRAND_PRODUCT_ROADMAP §4.2
// / PRODUCTION_MVP_SPRINT P0 "self-serve Stripe"). The Stripe rails themselves
// (checkout session, subscription webhook, plan-tier gate) already shipped in
// M5 — lib/billing.ts, api/billing/checkout, api/billing/webhook, and the
// gateway's core/entitlements.ts enforcement all predate this page. What was
// missing was a dedicated, linkable pricing surface a cold visitor can land on
// and buy from directly, rather than the in-app upsell banners.
//
// Flow for a signed-in tenant: click a paid tier → POST /api/billing/checkout
// → redirect to the hosted Stripe URL (same call as HostedBrainUpgrade /
// BillingBanner). For a cold visitor (no tenant session yet), the paid CTAs
// route to the guided signup wizard with `?plan=` carried through — see
// welcome/start/page.tsx, which auto-starts checkout right after signup so the
// whole thing is still one self-serve pass, no separate "upgrade later" step.
//
// Inert until STRIPE_* env is set: /api/billing/checkout returns 503 when
// `isStripeConfigured()` is false, and every button here surfaces that as a
// plain "billing isn't configured yet" message rather than a broken redirect.

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { useTenant } from '@/lib/tenant-context';
import type { TenantPlan } from '@/lib/billing';

// Mirrors dashboard/src/lib/billing.ts PLAN_LIMITS + runtime/src/core/entitlements.ts
// ENTITLEMENT_LIMITS (repos/off-hours minutes/generation credits) — kept as static
// marketing copy rather than importing the gateway package directly, same
// discipline as the existing hand-kept mirrors between the two packages.
interface Tier {
  plan: TenantPlan;
  name: string;
  price: string;
  per: string;
  tagline: string;
  features: string[];
  cta: string;
  highlight?: boolean;
  /** Paid tiers start Stripe Checkout; non-checkout tiers just link out. */
  checkout: boolean;
}

const TIERS: Tier[] = [
  {
    plan: 'free',
    name: 'Free',
    price: '$0',
    per: 'forever',
    tagline: 'Evaluate the full loop before you pay for anything.',
    features: [
      '1 connected repo',
      'Idea → app generation (capped)',
      'Manual task runs',
      'Community support',
    ],
    cta: 'Start free',
    checkout: false,
  },
  {
    plan: 'solo',
    name: 'Solo',
    price: '$49',
    per: 'per month',
    tagline: 'The wedge — autonomous engineering overnight, on your own repos.',
    features: [
      '3 connected repos',
      'Off-hours autonomous runner (overnight build/ops)',
      'Scheduling + mobile remote (“ship it” from your phone)',
      'Cross-device brain sync (managed remote, ADR-017)',
      '5,000 brain atoms · 200k requests/mo',
    ],
    cta: 'Subscribe to Solo',
    highlight: true,
    checkout: true,
  },
  {
    plan: 'team',
    name: 'Team',
    price: '$299',
    per: 'per month',
    tagline: 'Multi-repo orchestration for agencies running client work.',
    features: [
      '15 connected repos',
      'Multi-repo orchestration + swarm topologies',
      'Connect Hub support→build loop',
      'Up to 10 team seats · per-project dashboards',
    ],
    cta: 'Subscribe to Team',
    checkout: true,
  },
  {
    plan: 'scale',
    name: 'Scale / Enterprise',
    price: 'Custom',
    per: '$2k–10k+/mo',
    tagline: 'Unlimited repos, RBAC + audit, SSO, self-hosted/on-prem option.',
    features: [
      'Unlimited repos & seats',
      'RBAC + audit log, SSO',
      'Cost-aware routing controls',
      'SLA + dedicated support',
    ],
    cta: 'Talk to us',
    checkout: false,
  },
];

function StripeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
      <path d="M13.976 9.15c-2.172-.806-3.356-1.426-3.356-2.409 0-.831.683-1.305 1.901-1.305 2.227 0 4.515.858 6.09 1.631l.89-5.494C18.252.975 15.697 0 12.165 0 9.667 0 7.589.654 6.104 1.872 4.56 3.147 3.757 4.992 3.757 7.218c0 4.039 2.467 5.76 6.476 7.219 2.585.92 3.445 1.574 3.445 2.583 0 .98-.84 1.545-2.354 1.545-1.875 0-4.965-.921-6.99-2.109l-.9 5.555C5.175 22.99 8.385 24 11.714 24c2.641 0 4.843-.624 6.328-1.813 1.664-1.305 2.525-3.236 2.525-5.732 0-4.128-2.524-5.851-6.591-7.305Z" />
    </svg>
  );
}

export default function PricingPage() {
  const { current, authHeaders } = useTenant();
  const [busyPlan, setBusyPlan] = useState<TenantPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notConfigured, setNotConfigured] = useState(false);

  const startCheckout = useCallback(
    async (plan: TenantPlan) => {
      setBusyPlan(plan);
      setError(null);
      setNotConfigured(false);
      try {
        const res = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ plan, interval: 'month' }),
        });
        if (res.status === 503) {
          setNotConfigured(true);
          return;
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.url) {
          setError(json?.error || 'Could not start checkout.');
          return;
        }
        window.location.href = json.url as string;
      } catch {
        setError('Could not reach billing. Try again.');
      } finally {
        setBusyPlan(null);
      }
    },
    [authHeaders],
  );

  const onPaidTierClick = useCallback(
    (plan: TenantPlan) => {
      // No tenant session yet — send them through signup, carrying the chosen
      // tier so welcome/start can auto-checkout right after account creation.
      if (!current?.apiKey) {
        window.location.href = `/welcome/start?plan=${plan}`;
        return;
      }
      void startCheckout(plan);
    },
    [current, startCheckout],
  );

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <header className="max-w-6xl mx-auto px-5 md:px-8 h-16 flex items-center justify-between">
        <Link href="/welcome" className="text-xl font-bold tracking-tight text-brand-orange">
          myAI
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <Link href="/welcome" className="text-zinc-400 hover:text-zinc-200 hidden sm:inline">
            Product
          </Link>
          <Link href="/showcase" className="text-zinc-400 hover:text-zinc-200 hidden sm:inline">
            Capabilities
          </Link>
          <Link
            href="/login"
            className="px-3 py-1.5 rounded-lg border border-zinc-800 text-zinc-200 hover:border-zinc-700 transition"
          >
            Sign in
          </Link>
        </nav>
      </header>

      <main className="max-w-6xl mx-auto px-5 md:px-8 pt-10 pb-20">
        <div className="text-center max-w-2xl mx-auto">
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight">Pricing</h1>
          <p className="mt-3 text-zinc-400">
            Start free. Upgrade to Solo when you want the off-hours autonomous runner working your repos overnight.
            Cancel anytime — billing runs through Stripe.
          </p>
        </div>

        {notConfigured && (
          <div className="mt-6 max-w-lg mx-auto px-4 py-3 rounded-lg bg-amber-950/40 border border-amber-800/50 text-sm text-amber-300 text-center">
            Billing isn&apos;t configured on this deployment yet — set the <code className="font-mono">STRIPE_*</code>{' '}
            env vars to enable self-serve checkout.
          </div>
        )}
        {error && (
          <div className="mt-6 max-w-lg mx-auto px-4 py-3 rounded-lg bg-rose-950/40 border border-rose-800/50 text-sm text-rose-300 text-center">
            {error}
          </div>
        )}

        <div className="mt-10 grid md:grid-cols-2 lg:grid-cols-4 gap-5 items-stretch">
          {TIERS.map((t) => (
            <div
              key={t.plan}
              className={`gel-surface rounded-2xl border p-6 flex flex-col ${
                t.highlight ? 'border-teal-700 ring-1 ring-teal-700/40' : 'border-zinc-800'
              }`}
            >
              <div className="flex items-baseline justify-between">
                <div className="text-sm font-semibold text-teal-300">{t.name}</div>
                {t.highlight && (
                  <span className="text-[10px] uppercase tracking-widest text-teal-400">the wedge</span>
                )}
              </div>
              <div className="mt-3">
                <span className="text-3xl font-bold text-zinc-100">{t.price}</span>
                <span className="ml-2 text-xs text-zinc-500">{t.per}</span>
              </div>
              <p className="mt-2 text-sm text-zinc-400">{t.tagline}</p>
              <ul className="mt-4 space-y-2 text-sm text-zinc-400 flex-1">
                {t.features.map((f) => (
                  <li key={f} className="flex gap-2">
                    <span className="text-teal-400">✓</span>
                    {f}
                  </li>
                ))}
              </ul>

              {t.checkout ? (
                <button
                  type="button"
                  onClick={() => onPaidTierClick(t.plan)}
                  disabled={busyPlan === t.plan}
                  className={`mt-6 inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-50 disabled:cursor-not-allowed ${
                    t.highlight
                      ? 'gel-brand text-teal-100 hover:brightness-110'
                      : 'border border-zinc-700 text-zinc-200 hover:border-teal-700 hover:text-teal-300'
                  }`}
                >
                  {busyPlan === t.plan ? 'Starting checkout…' : (
                    <>
                      <StripeIcon />
                      {t.cta}
                    </>
                  )}
                </button>
              ) : (
                <Link
                  href="/welcome/start"
                  className="mt-6 inline-flex justify-center px-4 py-2.5 rounded-xl text-sm font-semibold border border-zinc-700 text-zinc-200 hover:border-teal-700 hover:text-teal-300 transition"
                >
                  {t.cta}
                </Link>
              )}
            </div>
          ))}
        </div>

        <p className="mt-8 text-center text-xs text-zinc-600">
          Prices in USD, billed monthly. Every tenant's memory, state and tasks stay yours — see the{' '}
          <Link href="/welcome#pricing" className="text-zinc-500 hover:text-teal-300 underline underline-offset-2">
            data-locality guarantee
          </Link>
          .
        </p>
      </main>
    </div>
  );
}
