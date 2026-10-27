'use client';

// LandingSignup — the self-serve signup card embedded in the /welcome landing
// page (MVP M6). A prospect can create a tenant without leaving the marketing
// page: name + optional email + plan → /api/auth/signup provisions the tenant
// and returns the raw API key, which we show ONCE with a copy button (same
// contract as /login). On success we offer a one-tap jump to the dashboard.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTenant } from '@/lib/tenant-context';
import { ConsentCheckbox } from '@/components/consent-checkbox';
import { RegionSelect } from '@/components/region-select';
import type { TenantRegion } from '@/lib/residency';

export function LandingSignup() {
  const router = useRouter();
  const { signup } = useTenant();
  // GROWTH — referral program: a tracked invite link lands here as
  // `/welcome?ref=<code>`. Read directly off `window.location` (rather than
  // `useSearchParams`, which forces a Suspense boundary on this page) once at
  // mount and threaded through to signup; an absent/invalid code is a no-op
  // on the gateway.
  const [referralCode] = useState<string | undefined>(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('ref') || undefined : undefined,
  );
  // Design-partner program (GRAND_PRODUCT §7.4): a `?trial=<code>` link
  // redeems a trial_days gift code at signup (e.g. a 60-day Solo trial).
  // Same read-once-at-mount posture as referralCode above.
  const [trialCode] = useState<string | undefined>(() =>
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('trial') || undefined : undefined,
  );

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // ADR-024 Phase 2b — data-residency region, defaults to 'us' (the schema default).
  const [region, setRegion] = useState<TenantRegion>('us');
  // Click-wrap consent — required before the form submits. Forwarded as
  // acceptTerms so the gateway records the accepted document versions +
  // timestamp per tenant (core/legal.ts).
  const [agreed, setAgreed] = useState(false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [trialEndsAt, setTrialEndsAt] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { apiKey, trialEndsAt: endsAt } = await signup({
        name: name.trim(),
        email: email.trim(),
        password,
        referralCode,
        trialCode,
        acceptTerms: agreed,
        region,
      });
      setNewKey(apiKey ?? null); // always present here (no inviteToken)
      setTrialEndsAt(endsAt ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'signup failed');
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!newKey) return;
    try {
      await navigator.clipboard.writeText(newKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — key is still selectable below */
    }
  }

  const inputCls =
    'w-full px-3 py-2 rounded-lg bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-primary))] placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

  if (newKey) {
    return (
      <div className="gel-surface p-5 rounded-2xl border border-amber-700/40">
        <h3 className="text-lg font-semibold text-[rgb(var(--text-primary))]">You&apos;re in. 🎉</h3>
        {trialEndsAt && (
          <p className="text-sm text-teal-300 mt-1">
            Design-partner trial active — Solo tier through {new Date(trialEndsAt).toLocaleDateString()}.
          </p>
        )}
        <p className="text-sm text-[rgb(var(--text-secondary))] mt-1">
          Your account is ready and you&apos;re signed in. This is your tenant API key for connecting a tool or the
          CLI — copy it now, it is shown <strong className="text-[rgb(var(--text-primary))]">only once</strong> and cannot be retrieved
          later.
        </p>
        <code className="block mt-4 px-3 py-2 rounded-lg bg-[rgb(var(--bg-page))] border border-[rgb(var(--border-subtle))] text-xs text-teal-300 break-all font-mono select-all">
          {newKey}
        </code>
        <button
          onClick={copyKey}
          className="gel-brand mt-3 w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition"
        >
          {copied ? '✓ Copied' : 'Copy key'}
        </button>
        <p className="text-label text-amber-400/80 mt-3">
          ⚠ Store it in your password manager. You sign in with your email + password — this key is only for
          programmatic / CLI access.
        </p>
        <button
          onClick={() => router.push('/')}
          className="mt-4 w-full px-3 py-2 rounded-lg border border-[rgb(var(--border-subtle))] text-sm text-[rgb(var(--text-primary))] hover:border-zinc-700 transition"
        >
          Open my dashboard →
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="gel-surface p-5 rounded-2xl border border-[rgb(var(--border-subtle))] space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-[rgb(var(--text-primary))]">Start free in 30 seconds</h3>
        <p className="text-sm text-[rgb(var(--text-muted))] mt-0.5">No credit card. Sign in with your email after.</p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
          {error}
        </div>
      )}

      <label className="block">
        <span className="block text-xs text-[rgb(var(--text-muted))] mb-1">Organisation name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc"
          className={inputCls}
          required
        />
      </label>
      <label className="block">
        <span className="block text-xs text-[rgb(var(--text-muted))] mb-1">Email</span>
        <input
          type="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@acme.com"
          className={inputCls}
          required
        />
      </label>
      <label className="block">
        <span className="block text-xs text-[rgb(var(--text-muted))] mb-1">Password</span>
        <input
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="At least 8 characters"
          className={inputCls}
          minLength={8}
          required
        />
      </label>
      <RegionSelect value={region} onChange={setRegion} />
      <ConsentCheckbox checked={agreed} onChange={setAgreed} />
      <button
        type="submit"
        disabled={busy || !name.trim() || !email.trim() || password.length < 8 || !agreed}
        className="gel-brand w-full px-3 py-2.5 rounded-lg text-sm font-semibold text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        {busy ? 'Creating your account…' : 'Create my account →'}
      </button>
      <p className="text-center text-xs text-zinc-600">
        Already have an account?{' '}
        <Link href="/operator-login" className="text-teal-400 hover:text-teal-300">
          Sign in
        </Link>
      </p>
    </form>
  );
}
