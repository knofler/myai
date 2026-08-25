"use client";

// /login — single-operator sign-in for the control plane (see
// app/lib/operator-auth.ts + middleware.ts). Posts to /api/auth/operator and
// follows ?next= back to the page the operator was denied. This is
// deliberately minimal — one credential, one form, no self-service signup.

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { branding } from "@/app/lib/branding";

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  );
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const next = searchParams.get("next") || "/";

  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/operator", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user: user.trim(), password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "sign in failed");
      router.push(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sign in failed");
    } finally {
      setBusy(false);
    }
  }

  const inputCls =
    "w-full px-3 py-2 rounded-lg border border-border bg-card text-sm outline-none focus:border-foreground/40 transition-colors";

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center p-8">
      <h1 className="text-2xl font-bold tracking-tight">{branding.name}</h1>
      <p className="mt-1 text-sm text-muted-foreground">Sign in as the operator to continue.</p>

      {error && (
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      <form onSubmit={onSubmit} className="mt-4 space-y-3">
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">User</span>
          <input
            autoComplete="username"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            className={inputCls}
            required
          />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs text-muted-foreground">Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
            required
          />
        </label>
        <button
          type="submit"
          disabled={busy || !user.trim() || !password}
          className="w-full rounded-lg bg-foreground px-3 py-2 text-sm font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </main>
  );
}
