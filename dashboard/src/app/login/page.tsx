'use client';

// /login — PRIMARY: email + password (MVP M2 graft, PR #239+).
//  • Sign in        — email + password → JWT session cookie.
//  • Create account — org + email + password → provisions tenant + owner user;
//                     the raw API key is shown ONCE (for connecting a tool/CLI).
//  • Join by invite — /login?invite=<token> (Team tier): the signup tab becomes
//                     a "join <tenant>" form — email locked to the invite, no
//                     org name, no show-once key (the account joins the
//                     inviter's existing tenant with the invite's role).
//  • Forgot password — link under sign-in → email form → the gateway mails a
//                     single-use expiring link back here (/login?reset=<token>),
//                     which swaps in a "set a new password" form.
//  • Magic link      — PRIMARY passwordless alternative to sign-in: "Email me
//                     a sign-in link" → the gateway mails a single-use,
//                     short-TTL link back here (/login?magic=<token>), which
//                     is consumed automatically on load — no password, no
//                     form. Distinct from password reset / email verification.
//  • Connect a tool — SECONDARY, collapsed below: paste a `myai_live_…` key.
// On success the tenant lands in TenantContext (localStorage) and we route home.

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useTenant } from '@/lib/tenant-context';

type Tab = 'login' | 'signup';

interface InviteInfo {
  token: string;
  tenantName?: string;
  email?: string;
  role?: string;
}

export default function LoginPage() {
  // useSearchParams needs a Suspense boundary in the App Router.
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { loginWithPassword, requestMagicLink, loginWithMagicLink, signup, connectWithKey } = useTenant();
  const [tab, setTab] = useState<Tab>('login');

  // Team-tier invite (?invite=<token>): looked up on mount; valid → the signup
  // tab becomes a join form locked to the invited email.
  const inviteToken = searchParams.get('invite');
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  // Password reset (?reset=<token>): looked up on mount; valid → the page
  // becomes a "set a new password" form. `forgot` is the request-an-email view.
  const resetToken = searchParams.get('reset');
  const [reset, setReset] = useState<{ token: string; email?: string } | null>(null);
  const [resetError, setResetError] = useState<string | null>(null);
  const [forgot, setForgot] = useState(false);
  const [forgotSent, setForgotSent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Magic link (?magic=<token>): consumed automatically on mount — no form,
  // no password. `magicMode` is the request-an-email view (parallel to
  // `forgot`, under the login tab).
  const magicToken = searchParams.get('magic');
  const [magicConsuming, setMagicConsuming] = useState(false);
  const [magicConsumeError, setMagicConsumeError] = useState<string | null>(null);
  const [magicMode, setMagicMode] = useState(false);
  const [magicSent, setMagicSent] = useState(false);

  // shared credential state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  // signup-only
  const [name, setName] = useState('');
  // secondary "connect a tool"
  const [showKey, setShowKey] = useState(false);
  const [apiKey, setApiKey] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // After signup, the show-once raw key.
  const [newKey, setNewKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // Idle-session auto-logout (?reason=idle): dropped here by
  // idle-timeout-guard.tsx after it revoked the session server-side.
  useEffect(() => {
    if (searchParams.get('reason') === 'idle') {
      setNotice('You were signed out after a period of inactivity.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/auth/invites/lookup?token=${encodeURIComponent(inviteToken)}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && json.valid) {
          setInvite({ token: inviteToken, tenantName: json.tenantName, email: json.email, role: json.role });
          if (json.email) setEmail(json.email);
          setTab('signup');
        } else {
          setInviteError(json.reason || 'this invite link is not valid');
        }
      } catch {
        if (!cancelled) setInviteError('could not verify the invite link');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteToken]);

  useEffect(() => {
    if (!resetToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/auth/password/lookup?token=${encodeURIComponent(resetToken)}`);
        const json = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && json.valid) {
          setReset({ token: resetToken, email: json.email });
          if (json.email) setEmail(json.email);
        } else {
          setResetError(json.reason || 'this reset link is not valid');
        }
      } catch {
        if (!cancelled) setResetError('could not verify the reset link');
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetToken]);

  useEffect(() => {
    if (!magicToken) return;
    let cancelled = false;
    setMagicConsuming(true);
    (async () => {
      try {
        await loginWithMagicLink(magicToken);
        if (!cancelled) router.push('/');
      } catch (err) {
        if (!cancelled) {
          setMagicConsumeError(err instanceof Error ? err.message : 'sign-in link failed');
          setMagicConsuming(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magicToken]);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await loginWithPassword(email.trim(), password);
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  }

  async function onSignup(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { apiKey: raw } = await signup({
        name: invite ? undefined : name.trim(),
        email: email.trim(),
        password,
        inviteToken: invite?.token,
      });
      // Invite joins get no show-once key (the tenant's key already exists) —
      // straight to the dashboard.
      if (raw) setNewKey(raw);
      else router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'signup failed');
    } finally {
      setBusy(false);
    }
  }

  async function onForgot(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/password/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      });
      if (res.status === 429) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || 'too many attempts — please wait and try again');
      }
      if (!res.ok) throw new Error('reset request failed — please try again');
      // Always the same outcome whether or not the address has an account.
      setForgotSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'reset request failed');
    } finally {
      setBusy(false);
    }
  }

  async function onMagicLink(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestMagicLink(email.trim());
      // Always the same outcome whether or not the address has an account.
      setMagicSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'sign-in link request failed');
    } finally {
      setBusy(false);
    }
  }

  async function onReset(e: React.FormEvent) {
    e.preventDefault();
    if (!reset) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/password/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: reset.token, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'password reset failed');
      // Back to a clean sign-in with the email prefilled and the token gone
      // from the URL (it's burned anyway).
      setReset(null);
      setPassword('');
      setNotice('Password updated — sign in with your new password.');
      setTab('login');
      window.history.replaceState(null, '', '/login');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'password reset failed');
    } finally {
      setBusy(false);
    }
  }

  async function onConnect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await connectWithKey(apiKey.trim());
      router.push('/');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'connect failed');
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
      /* clipboard blocked — the key is still selectable in the field */
    }
  }

  const inputCls =
    'w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-sm text-zinc-100 placeholder-zinc-600 focus:border-teal-600 outline-none transition-colors';

  // ── Show-once key panel (after signup) ───────────────────────
  if (newKey) {
    return (
      <div className="max-w-md mx-auto mt-10">
        <h1 className="text-2xl font-bold text-brand-orange tracking-tight">You&apos;re in 🎉</h1>
        <p className="text-sm text-zinc-400 mt-1">
          Your account is ready and you&apos;re signed in. This is your tenant API key for connecting a tool or the
          CLI — copy it now, it is shown <strong className="text-zinc-200">only once</strong> and cannot be retrieved
          later.
        </p>
        <div className="gel-surface mt-5 p-4 rounded-xl border border-amber-700/40">
          <code className="block text-xs text-teal-300 break-all font-mono select-all">{newKey}</code>
          <button
            onClick={copyKey}
            className="gel-brand mt-3 w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 transition"
          >
            {copied ? '✓ Copied' : 'Copy key'}
          </button>
        </div>
        <p className="text-[11px] text-amber-400/80 mt-3">
          ⚠ Store it in your password manager. You sign in with your email + password — this key is only for
          programmatic / CLI access, and you can rotate it later.
        </p>
        <button
          onClick={() => router.push('/')}
          className="gel-surface mt-5 w-full px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
        >
          Continue to dashboard →
        </button>
      </div>
    );
  }

  // ── Magic link auto-consume (?magic=<token>) ──────────────────
  if (magicConsuming) {
    return (
      <div className="max-w-md mx-auto mt-10">
        <h1 className="text-2xl font-bold text-brand-orange tracking-tight">Signing you in…</h1>
        <p className="text-sm text-zinc-400 mt-1">Verifying your sign-in link, one moment.</p>
      </div>
    );
  }

  // ── Set a new password (?reset=<token> verified) ─────────────
  if (reset) {
    return (
      <div className="max-w-md mx-auto mt-10">
        <h1 className="text-2xl font-bold text-brand-orange tracking-tight">Set a new password</h1>
        <p className="text-sm text-zinc-400 mt-1">
          {reset.email ? (
            <>Choose a new password for <strong className="text-zinc-200">{reset.email}</strong>.</>
          ) : (
            'Choose a new password for your account.'
          )}{' '}
          This link works once.
        </p>
        {error && (
          <div className="mt-4 px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
            {error}
          </div>
        )}
        <form onSubmit={onReset} className="mt-4 space-y-3">
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">New password</span>
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
            disabled={busy || password.length < 8}
            className="gel-brand w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {busy ? 'Updating…' : 'Update password'}
          </button>
        </form>
      </div>
    );
  }

  // ── Login / signup forms ─────────────────────────────────────
  return (
    <div className="max-w-md mx-auto mt-10">
      <Link href="/welcome" className="text-xs text-zinc-500 hover:text-teal-300 transition">
        ← Back to home
      </Link>
      <h1 className="text-2xl font-bold text-brand-orange tracking-tight mt-2">myAI</h1>
      <p className="text-sm text-zinc-500 mt-1">
        {invite
          ? `You've been invited to join ${invite.tenantName || 'a team'}.`
          : tab === 'login'
            ? 'Sign in with your email and password.'
            : 'Create your account to get started.'}
      </p>

      {invite && (
        <div className="mt-4 px-3 py-2 rounded-lg gel-brand border border-teal-800/50 text-xs text-teal-200">
          Joining <strong>{invite.tenantName || 'a team'}</strong> as{' '}
          <strong>{invite.role || 'member'}</strong> — create a password to accept the invite.
        </div>
      )}
      {inviteError && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-amber-950/50 border border-amber-800/50 text-xs text-amber-300">
          Invite link problem: {inviteError}. Ask your team owner for a fresh invite, or sign in below.
        </div>
      )}
      {resetError && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-amber-950/50 border border-amber-800/50 text-xs text-amber-300">
          Reset link problem: {resetError}. Request a new one via &ldquo;Forgot password?&rdquo; below.
        </div>
      )}
      {magicConsumeError && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-amber-950/50 border border-amber-800/50 text-xs text-amber-300">
          Sign-in link problem: {magicConsumeError}. Request a new one via &ldquo;Email me a sign-in link&rdquo;
          below.
        </div>
      )}
      {notice && (
        <div className="mt-4 px-3 py-2 rounded-lg gel-brand border border-teal-800/50 text-xs text-teal-200">
          {notice}
        </div>
      )}

      <div className="flex gap-1 mt-5 p-1 gel-surface rounded-lg border border-zinc-800">
        {(['login', 'signup'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => {
              setTab(t);
              setError(null);
            }}
            className={`flex-1 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
              tab === t ? 'gel-brand text-teal-200' : 'text-zinc-500 hover:text-zinc-300'
            }`}
          >
            {t === 'login' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>

      {error && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-rose-950/50 border border-rose-800/50 text-xs text-rose-300">
          {error}
        </div>
      )}

      {tab === 'login' && forgot ? (
        // ── Forgot password: request a reset email ──
        forgotSent ? (
          <div className="mt-4 space-y-3">
            <div className="px-3 py-2 rounded-lg gel-brand border border-teal-800/50 text-xs text-teal-200">
              If <strong>{email.trim() || 'that address'}</strong> has an account, a reset link is on its way — check
              your inbox. The link expires in about an hour and works once.
            </div>
            <p className="text-[11px] text-zinc-500">
              Self-hosting without SMTP configured? The reset link is printed in the gateway logs instead.
            </p>
            <button
              onClick={() => {
                setForgot(false);
                setForgotSent(false);
                setError(null);
              }}
              className="gel-surface w-full px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
            >
              ← Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={onForgot} className="mt-4 space-y-3">
            <p className="text-xs text-zinc-500">
              Enter your account email and we&apos;ll send you a single-use link to set a new password.
            </p>
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
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="gel-brand w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {busy ? 'Sending…' : 'Email me a reset link'}
            </button>
            <button
              type="button"
              onClick={() => {
                setForgot(false);
                setError(null);
              }}
              className="w-full text-xs text-zinc-500 hover:text-zinc-300 transition"
            >
              ← Back to sign in
            </button>
          </form>
        )
      ) : tab === 'login' && magicMode ? (
        // ── Magic link: request a passwordless sign-in email ──
        magicSent ? (
          <div className="mt-4 space-y-3">
            <div className="px-3 py-2 rounded-lg gel-brand border border-teal-800/50 text-xs text-teal-200">
              If <strong>{email.trim() || 'that address'}</strong> has an account, a sign-in link is on its way —
              check your inbox. The link expires in about 15 minutes and works once.
            </div>
            <p className="text-[11px] text-zinc-500">
              Self-hosting without SMTP configured? The sign-in link is printed in the gateway logs instead.
            </p>
            <button
              onClick={() => {
                setMagicMode(false);
                setMagicSent(false);
                setError(null);
              }}
              className="gel-surface w-full px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 transition"
            >
              ← Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={onMagicLink} className="mt-4 space-y-3">
            <p className="text-xs text-zinc-500">
              Enter your account email and we&apos;ll send you a single-use link that signs you in — no password
              needed.
            </p>
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
            <button
              type="submit"
              disabled={busy || !email.trim()}
              className="gel-brand w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
            >
              {busy ? 'Sending…' : 'Email me a sign-in link'}
            </button>
            <button
              type="button"
              onClick={() => {
                setMagicMode(false);
                setError(null);
              }}
              className="w-full text-xs text-zinc-500 hover:text-zinc-300 transition"
            >
              ← Back to sign in
            </button>
          </form>
        )
      ) : tab === 'login' ? (
        <form onSubmit={onLogin} className="mt-4 space-y-3">
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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className={inputCls}
              required
            />
          </label>
          <button
            type="submit"
            disabled={busy || !email.trim() || !password}
            className="gel-brand w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
          <div className="flex justify-between gap-2">
            <button
              type="button"
              onClick={() => {
                setForgot(true);
                setError(null);
                setNotice(null);
              }}
              className="text-xs text-zinc-500 hover:text-teal-300 transition"
            >
              Forgot password?
            </button>
            <button
              type="button"
              onClick={() => {
                setMagicMode(true);
                setError(null);
                setNotice(null);
              }}
              className="text-xs text-zinc-500 hover:text-teal-300 transition"
            >
              Email me a sign-in link →
            </button>
          </div>
        </form>
      ) : (
        <form onSubmit={onSignup} className="mt-4 space-y-3">
          {!invite && (
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
          )}
          <label className="block">
            <span className="block text-xs text-zinc-500 mb-1">
              Email{invite?.email ? ' (locked to the invite)' : ''}
            </span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@acme.com"
              className={`${inputCls} ${invite?.email ? 'opacity-60' : ''}`}
              readOnly={Boolean(invite?.email)}
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
            disabled={busy || (!invite && !name.trim()) || !email.trim() || password.length < 8}
            className="gel-brand w-full px-3 py-2 rounded-lg text-sm font-medium text-teal-100 hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed transition"
          >
            {busy
              ? invite ? 'Joining…' : 'Creating…'
              : invite ? `Join ${invite.tenantName || 'team'}` : 'Create account'}
          </button>
        </form>
      )}

      {/* ── Secondary: connect a tool / CLI with an API key ─────────── */}
      <div className="mt-6 pt-5 border-t border-zinc-800/70">
        {!showKey ? (
          <button
            onClick={() => {
              setShowKey(true);
              setError(null);
            }}
            className="text-xs text-zinc-500 hover:text-teal-300 transition"
          >
            Connecting a tool or CLI? Use an API key instead →
          </button>
        ) : (
          <form onSubmit={onConnect} className="space-y-3">
            <p className="text-xs text-zinc-500">
              Paste a per-tenant API key to connect a tool or CLI session to its tenant.
            </p>
            <input
              type="password"
              autoComplete="off"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="myai_live_…"
              className={`${inputCls} font-mono`}
              required
            />
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={busy || !apiKey.trim()}
                className="gel-surface flex-1 px-3 py-2 rounded-lg border border-zinc-800 text-sm text-zinc-200 hover:border-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition"
              >
                {busy ? 'Connecting…' : 'Connect with key'}
              </button>
              <button
                type="button"
                onClick={() => setShowKey(false)}
                className="px-3 py-2 rounded-lg text-sm text-zinc-500 hover:text-zinc-300 transition"
              >
                Cancel
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
