'use client';

/**
 * Operator sign-in — the human path to the single-operator gate.
 *
 * WHY THIS EXISTS: the gate (lib/operator-auth.ts + middleware) shipped with only
 * an API endpoint. Middleware redirected unauthenticated users to `/login`, which
 * is the MULTI-TENANT login — magic link, signup, password reset — posting to
 * different endpoints and issuing `myai_token`. Operator credentials entered there
 * could never work, so the gate was effectively unopenable from a browser even
 * though `POST /api/auth/operator` worked perfectly under curl.
 *
 * Deliberately minimal: one form, no signup, no password reset, no magic link.
 * There is exactly one operator and the credential is provisioned out of band
 * (a gitignored .env locally, project env vars on the host). Anything more would
 * imply self-service account management, which this control plane does not have.
 */
import { useState, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function OperatorLoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') || '/';

  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/auth/operator', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user, password }),
      });
      if (res.ok) {
        // Full navigation, not router.push — the middleware gate reads the
        // cookie on a real request, and a client-side transition can render
        // from cache before the new session is in play.
        window.location.href = next;
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      // 503 means the deployment has no credential configured at all — a
      // deployment posture, not a typo. Say which it is; guessing wastes hours.
      setError(
        res.status === 503
          ? body.error || 'Operator login is not configured on this deployment.'
          : 'Invalid credentials.',
      );
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950 px-4">
      <div className="w-full max-w-sm">
        <h1 className="text-xl font-semibold text-neutral-100">myAI — operator sign in</h1>
        <p className="mt-1 text-sm text-neutral-400">
          This control plane has a single operator. Public pages stay open without signing in.
        </p>

        <form onSubmit={onSubmit} className="mt-6 space-y-3">
          <div>
            <label htmlFor="op-user" className="block text-sm text-neutral-300">
              Username
            </label>
            <input
              id="op-user"
              name="username"
              type="text"
              autoComplete="username"
              autoFocus
              required
              value={user}
              onChange={(e) => setUser(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-500"
            />
          </div>

          <div>
            <label htmlFor="op-password" className="block text-sm text-neutral-300">
              Password
            </label>
            <input
              id="op-password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-neutral-100 outline-none focus:border-neutral-500"
            />
          </div>

          {error && (
            <p role="alert" className="text-sm text-red-400">
              {error}
            </p>
          )}

          <button
            type="submit"
            disabled={busy || !user || !password}
            className="w-full rounded-md bg-neutral-100 px-3 py-2 font-medium text-neutral-900 disabled:opacity-50"
          >
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}

export default function OperatorLoginPage() {
  // useSearchParams needs a Suspense boundary for static generation.
  return (
    <Suspense fallback={null}>
      <OperatorLoginForm />
    </Suspense>
  );
}
