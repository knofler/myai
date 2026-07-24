'use client';

// /welcome/start — the guided first-run onboarding wizard (betaC).
//
// Four steps take a brand-new operator from nothing to value with no manual
// wiring: sign up → connect a repo → queue a first task → watch the runner ship
// it. It is self-contained (its own signup, so a cold visitor can complete the
// whole loop here) and renders full-bleed — /welcome/* is already exempt from
// the dashboard chrome (app-shell FULL_BLEED) and the login wall
// (middleware PUBLIC_PREFIXES).
//
// The two middle steps post to /api/onboarding/launch, which upserts the repo's
// directory card and queues a tenant-scoped pending Task. The tenant cookie
// that scopes that write is set by TenantCookieSync the moment signup updates
// the tenant context, so by the time the operator reaches step 3 the queue call
// lands under their tenant.
//
// /welcome/start?plan=solo|team — carried over from a cold visitor's click on a
// paid tier at /pricing (PricingPage.onPaidTierClick). The instant signup
// succeeds we start Stripe Checkout for that plan and redirect to the hosted
// URL, so a paid-intent visitor never has to find billing after the fact — the
// wizard's own onboarding steps are skipped for that pass. Falls back to the
// normal wizard if billing isn't configured on this deployment (503) or the
// checkout call fails; the operator still lands on the free plan and can
// upgrade later from Billing.

import { Suspense, useCallback, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTenant } from '@/lib/tenant-context';

const STEPS = ['Sign up', 'Connect a repo', 'Queue a task', 'Watch it ship'] as const;

const CHECKOUT_PLANS = ['solo', 'team'] as const;
type CheckoutPlan = (typeof CHECKOUT_PLANS)[number];
const PLAN_LABEL: Record<CheckoutPlan, string> = { solo: 'Solo', team: 'Team' };

function asCheckoutPlan(value: string | null): CheckoutPlan | null {
  return value && (CHECKOUT_PLANS as readonly string[]).includes(value) ? (value as CheckoutPlan) : null;
}

const PRIORITIES = [
  { value: 'P1', label: 'P1 — soon' },
  { value: 'P2', label: 'P2 — normal' },
  { value: 'P3', label: 'P3 — whenever' },
] as const;

interface LaunchResult {
  ok: boolean;
  repoName: string;
  taskId: string;
  reused?: boolean;
  message: string;
}

const inputCls =
  'w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

/* ── Step rail ──────────────────────────────────────────────── */
function StepRail({ step }: { step: number }) {
  return (
    <ol className="flex items-center justify-center gap-2 sm:gap-3 text-xs">
      {STEPS.map((label, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <li key={label} className="flex items-center gap-2 sm:gap-3">
            <span
              className={
                'flex items-center gap-1.5 px-2 py-1 rounded-full border transition-colors ' +
                (active
                  ? 'border-teal-600 bg-teal-500/10 text-teal-300'
                  : done
                    ? 'border-emerald-700/60 bg-emerald-500/10 text-emerald-400'
                    : 'border-zinc-800 text-zinc-600')
              }
            >
              <span className="font-mono">{done ? '✓' : i + 1}</span>
              <span className="hidden sm:inline">{label}</span>
            </span>
            {i < STEPS.length - 1 && (
              <span className={'h-px w-4 sm:w-8 ' + (done ? 'bg-emerald-700/60' : 'bg-zinc-800')} />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* ── Wizard ─────────────────────────────────────────────────── */
export default function OnboardingWizard() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <OnboardingWizardInner />
    </Suspense>
  );
}

function OnboardingWizardInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const requestedPlan = asCheckoutPlan(searchParams.get('plan'));
  const { current, signup, loading } = useTenant();

  // If the operator is already signed in, skip straight to "connect a repo".
  const [step, setStep] = useState(0);
  const [bootstrapped, setBootstrapped] = useState(false);
  useEffect(() => {
    if (loading || bootstrapped) return;
    if (current) setStep((s) => (s === 0 ? 1 : s));
    setBootstrapped(true);
  }, [loading, bootstrapped, current]);

  // Step 0 — signup
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Step 1 — connect a repo
  const [repo, setRepo] = useState('');
  const [repoDescription, setRepoDescription] = useState('');

  // Step 2 — first task
  const [taskTitle, setTaskTitle] = useState('');
  const [taskDescription, setTaskDescription] = useState('');
  const [priority, setPriority] = useState<string>('P2');

  // Step 3 — result
  const [result, setResult] = useState<LaunchResult | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Paid-intent auto-checkout (?plan=solo|team) — kicked off right after signup.
  const [checkoutState, setCheckoutState] = useState<'idle' | 'starting' | 'error' | 'not-configured'>('idle');

  const startCheckout = useCallback(
    async (plan: CheckoutPlan, key: string) => {
      setCheckoutState('starting');
      try {
        const res = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: JSON.stringify({ plan, interval: 'month' }),
        });
        if (res.status === 503) {
          setCheckoutState('not-configured');
          return;
        }
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json?.url) {
          setCheckoutState('error');
          return;
        }
        window.location.href = json.url as string;
      } catch {
        setCheckoutState('error');
      }
    },
    [],
  );

  async function onSignup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { apiKey: key } = await signup({ name: name.trim(), email: email.trim(), password });
      setApiKey(key ?? null); // always present here (no inviteToken)
      if (requestedPlan && key) {
        await startCheckout(requestedPlan, key);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'signup failed');
    } finally {
      setBusy(false);
    }
  }

  async function copyKey() {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard blocked — key is still selectable below */
    }
  }

  async function onLaunch(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/onboarding/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          repo: repo.trim(),
          repoDescription: repoDescription.trim(),
          taskTitle: taskTitle.trim(),
          taskDescription: taskDescription.trim(),
          priority,
        }),
      });
      const json = (await res.json()) as LaunchResult & { error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || 'could not queue your first task');
      setResult(json);
      setStep(3);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'could not queue your first task');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* top bar */}
      <header className="max-w-3xl mx-auto px-5 md:px-8 h-16 flex items-center justify-between">
        <Link href="/welcome" className="text-xl font-bold tracking-tight text-brand-orange">
          myAI
        </Link>
        <Link href="/login" className="text-sm text-zinc-400 hover:text-zinc-200">
          Sign in
        </Link>
      </header>

      <main className="max-w-2xl mx-auto px-5 md:px-8 pt-6 pb-20">
        <div className="text-center">
          <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Get your first task shipping</h1>
          <p className="mt-2 text-sm text-zinc-500">
            Four steps to a working autonomous loop — no manual wiring.
          </p>
        </div>

        <div className="mt-7">
          <StepRail step={step} />
        </div>

        {error && (
          <div className="mt-6 px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
            {error}
          </div>
        )}

        <div className="mt-6 gel-surface p-5 md:p-6 rounded-2xl border border-zinc-800">
          {/* ── Step 0: Sign up ─────────────────────────────── */}
          {step === 0 && !apiKey && (
            <form onSubmit={onSignup} className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">Create your account</h2>
                <p className="text-sm text-zinc-500 mt-0.5">No credit card. Starts on the free plan.</p>
              </div>
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1">Organisation name</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Inc" className={inputCls} required />
              </label>
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1">Email</span>
                <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@acme.com" className={inputCls} required />
              </label>
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1">Password</span>
                <input type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="At least 8 characters" className={inputCls} minLength={8} required />
              </label>
              <button
                type="submit"
                disabled={busy || !name.trim() || !email.trim() || password.length < 8}
                className="gel-brand w-full px-3 py-2.5 rounded-lg text-sm font-semibold text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {busy ? 'Creating your account…' : 'Create account →'}
              </button>
              <p className="text-center text-xs text-zinc-600">
                Already have an account?{' '}
                <Link href="/login" className="text-teal-400 hover:text-teal-300">Sign in</Link>
              </p>
            </form>
          )}

          {/* Step 0 success — show the API key once, then continue */}
          {step === 0 && apiKey && (
            <div>
              {requestedPlan && checkoutState === 'starting' ? (
                <>
                  <h2 className="text-lg font-semibold text-zinc-100">
                    Setting up {PLAN_LABEL[requestedPlan]}… 🎉
                  </h2>
                  <p className="text-sm text-zinc-400 mt-1">Redirecting you to secure Stripe checkout.</p>
                </>
              ) : (
                <>
                  <h2 className="text-lg font-semibold text-zinc-100">You&apos;re in. 🎉</h2>
                  {requestedPlan && checkoutState !== 'idle' && (
                    <p className="mt-2 px-3 py-2 rounded-lg bg-amber-950/40 border border-amber-800/50 text-xs text-amber-300">
                      {checkoutState === 'not-configured'
                        ? "Billing isn't configured on this deployment yet — continue on the free plan, you can upgrade later from Billing."
                        : "Couldn't start checkout — continue on the free plan, you can upgrade later from Billing."}
                    </p>
                  )}
                </>
              )}
              <p className="text-sm text-zinc-400 mt-1">
                Here is your tenant API key for the CLI / tools — copy it now, it is shown{' '}
                <strong className="text-zinc-200">only once</strong>.
              </p>
              <code className="block mt-4 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-teal-300 break-all font-mono select-all">
                {apiKey}
              </code>
              <button
                onClick={copyKey}
                className="gel-surface mt-3 w-full px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
              >
                {copied ? '✓ Copied' : 'Copy key'}
              </button>
              {!(requestedPlan && checkoutState === 'starting') && (
                <button
                  onClick={() => setStep(1)}
                  className="gel-brand mt-3 w-full px-3 py-2.5 rounded-lg text-sm font-semibold text-teal-100 hover:brightness-110 transition"
                >
                  Next: connect a repo →
                </button>
              )}
            </div>
          )}

          {/* ── Step 1: Connect a repo ──────────────────────── */}
          {step === 1 && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setError(null);
                setStep(2);
              }}
              className="space-y-3"
            >
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">Connect a repo</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Point at an existing GitHub repo (<span className="font-mono">owner/repo</span>) or name a fresh
                  project. It appears in your{' '}
                  <Link href="/apps" className="text-teal-400 hover:text-teal-300">directory</Link>.
                </p>
              </div>
              {current && (
                <div className="text-xs text-emerald-400/90">Signed in as {current.name}.</div>
              )}
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1">Repo or project name</span>
                <input
                  value={repo}
                  onChange={(e) => setRepo(e.target.value)}
                  placeholder="acme/invoice-tracker  or  Invoice Tracker"
                  className={`${inputCls} font-mono`}
                  maxLength={120}
                  required
                />
              </label>
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1">One-line description (optional)</span>
                <input
                  value={repoDescription}
                  onChange={(e) => setRepoDescription(e.target.value)}
                  placeholder="Invoicing app for freelancers"
                  className={inputCls}
                  maxLength={200}
                />
              </label>
              <div className="flex gap-2 pt-1">
                <button
                  type="submit"
                  disabled={!repo.trim()}
                  className="gel-brand flex-1 px-3 py-2.5 rounded-lg text-sm font-semibold text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  Next: queue a task →
                </button>
              </div>
            </form>
          )}

          {/* ── Step 2: Queue first task ────────────────────── */}
          {step === 2 && (
            <form onSubmit={onLaunch} className="space-y-3">
              <div>
                <h2 className="text-lg font-semibold text-zinc-100">Queue your first task</h2>
                <p className="text-sm text-zinc-500 mt-0.5">
                  Describe one thing to do in{' '}
                  <span className="font-mono text-zinc-400">{repo.trim() || 'your repo'}</span>. The off-hours runner
                  builds it autonomously.
                </p>
              </div>
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1">Task</span>
                <input
                  value={taskTitle}
                  onChange={(e) => setTaskTitle(e.target.value)}
                  placeholder="Add a dark-mode toggle to the settings page"
                  className={inputCls}
                  maxLength={160}
                  required
                />
              </label>
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1">Detail (optional)</span>
                <textarea
                  value={taskDescription}
                  onChange={(e) => setTaskDescription(e.target.value)}
                  placeholder="Persist the choice in localStorage and respect prefers-color-scheme on first load…"
                  className={`${inputCls} min-h-[100px] resize-y`}
                  maxLength={2000}
                />
              </label>
              <label className="block">
                <span className="block text-xs text-zinc-500 mb-1">Priority</span>
                <select value={priority} onChange={(e) => setPriority(e.target.value)} className={inputCls}>
                  {PRIORITIES.map((p) => (
                    <option key={p.value} value={p.value}>{p.label}</option>
                  ))}
                </select>
              </label>
              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => { setError(null); setStep(1); }}
                  className="gel-surface px-3 py-2.5 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
                >
                  ← Back
                </button>
                <button
                  type="submit"
                  disabled={busy || !taskTitle.trim()}
                  className="gel-brand flex-1 px-3 py-2.5 rounded-lg text-sm font-semibold text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
                >
                  {busy ? 'Queueing…' : 'Queue it →'}
                </button>
              </div>
            </form>
          )}

          {/* ── Step 3: Watch it ship ───────────────────────── */}
          {step === 3 && result && (
            <div>
              <h2 className="text-lg font-semibold text-brand-orange">Queued — it ships overnight 🚀</h2>
              <p className="text-sm text-zinc-400 mt-1">{result.message}</p>
              <div className="mt-4 p-4 rounded-xl border border-zinc-800 bg-zinc-950/60 space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Repo</span>
                  <span className="font-mono text-teal-300">{result.repoName}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Task</span>
                  <span className="font-mono text-zinc-300 text-xs break-all">{result.taskId}</span>
                </div>
              </div>
              <ol className="mt-4 space-y-1.5 text-sm text-zinc-400 list-decimal list-inside">
                <li>The off-hours runner picks it up on the next free window.</li>
                <li>It works the task autonomously and lands changes on <code className="text-zinc-300">test</code>.</li>
                <li>It surfaces in <span className="text-teal-300">Work → Needs Review</span> for your{' '}
                  <code className="text-zinc-300">ship it</code>.</li>
              </ol>
              <div className="flex flex-wrap gap-2 mt-5">
                <button
                  onClick={() => router.push('/work?tab=queue')}
                  className="gel-brand flex-1 min-w-[10rem] px-3 py-2.5 rounded-lg text-sm font-semibold text-teal-100 hover:brightness-110 transition"
                >
                  See it in the queue →
                </button>
                <Link
                  href="/"
                  className="gel-surface px-3 py-2.5 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
                >
                  Open dashboard
                </Link>
              </div>
            </div>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-zinc-600">
          Want the bigger picture first?{' '}
          <Link href="/welcome" className="text-teal-400 hover:text-teal-300">See what myAI does</Link>
        </p>
      </main>
    </div>
  );
}
