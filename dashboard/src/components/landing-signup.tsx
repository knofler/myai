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

export function LandingSignup() {
  const router = useRouter();
  const { signup } = useTenant();

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { apiKey } = await signup({ name: name.trim(), email: email.trim(), password });
      setNewKey(apiKey ?? null); // always present here (no inviteToken)
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
    'w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

  if (newKey) {
    return (
      <div className="gel-surface p-5 rounded-2xl border border-amber-700/40">
        <h3 className="text-lg font-semibold text-zinc-100">You&apos;re in. 🎉</h3>
        <p className="text-sm text-zinc-400 mt-1">
          Your account is ready and you&apos;re signed in. This is your tenant API key for connecting a tool or the
          CLI — copy it now, it is shown <strong className="text-zinc-200">only once</strong> and cannot be retrieved
          later.
        </p>
        <code className="block mt-4 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-teal-300 break-all font-mono select-all">
          {newKey}
        </code>
        <button
          onClick={copyKey}
          className="gel-brand mt-3 w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition"
        >
          {copied ? '✓ Copied' : 'Copy key'}
        </button>
        <p className="text-[11px] text-amber-400/80 mt-3">
          ⚠ Store it in your password manager. You sign in with your email + password — this key is only for
          programmatic / CLI access.
        </p>
        <button
          onClick={() => router.push('/')}
          className="mt-4 w-full px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
        >
          Open my dashboard →
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="gel-surface p-5 rounded-2xl border border-zinc-800 space-y-3">
      <div>
        <h3 className="text-lg font-semibold text-zinc-100">Start free in 30 seconds</h3>
        <p className="text-sm text-zinc-500 mt-0.5">No credit card. Sign in with your email after.</p>
      </div>

      {error && (
        <div className="px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
          {error}
        </div>
      )}

      <label className="block">
        <span className="block text-xs text-zinc-500 mb-1">Organisation name</span>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Acme Inc"
          className={inputCls}
          required
        />
      </label>
      <label className="block">
        <span className="block text-xs text-zinc-500 mb-1">Email</span>
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
        <span className="block text-xs text-zinc-500 mb-1">Password</span>
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
      <button
        type="submit"
        disabled={busy || !name.trim() || !email.trim() || password.length < 8}
        className="gel-brand w-full px-3 py-2.5 rounded-lg text-sm font-semibold text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
      >
        {busy ? 'Creating your account…' : 'Create my account →'}
      </button>
      <p className="text-center text-xs text-zinc-600">
        Already have an account?{' '}
        <Link href="/login" className="text-teal-400 hover:text-teal-300">
          Sign in
        </Link>
      </p>
    </form>
  );
}
