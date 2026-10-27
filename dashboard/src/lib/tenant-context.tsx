'use client';

// Tenant context (ADR-010 / MVP M2) — holds the active tenant + every saved
// tenant session in localStorage, so an operator can sign into several tenants
// and switch between them. The stored `apiKey` is the per-tenant Bearer key;
// `authHeaders()` surfaces it for any client→gateway call that should be
// tenant-scoped. Persisted client-side only (the dashboard talks to the
// gateway over the Docker loopback; hosted enforcement is TENANT_ENFORCE).

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { TenantRegion } from '@/lib/residency';

export interface TenantSession {
  tenantId: string;
  name: string;
  plan: string;
  /** The raw per-tenant API key (Bearer). Optional: present only when the
   *  session was established by a show-once signup or the "connect a tool"
   *  key flow. Password logins have no key (the JWT cookie is the credential). */
  apiKey?: string;
  /** The tenant's require2fa policy is on but this account hasn't enrolled
   *  TOTP yet — the dashboard should route to /2fa instead of home. */
  totpEnrollmentRequired?: boolean;
}

/** Thrown by loginWithPassword when the account has TOTP enabled — password
 *  matched, but the caller must complete completeTotpLogin(pendingToken, code)
 *  before a real session exists. Distinct from a plain login failure so the
 *  login page can switch to the code-entry step instead of showing an error. */
export class MfaRequiredError extends Error {
  pendingToken: string;
  constructor(pendingToken: string) {
    super('TOTP code required');
    this.name = 'MfaRequiredError';
    this.pendingToken = pendingToken;
  }
}

export interface SignupInput {
  /** Organisation / tenant display name (not needed when joining by invite). */
  name?: string;
  email: string;
  password: string;
  /** Team tier: join the inviter's existing tenant instead of creating one. */
  inviteToken?: string;
  /** GROWTH — referral program: the `?ref=` code from another tenant's
   *  tracked invite link, if this signup arrived via one. */
  referralCode?: string;
  /** Design-partner program (GRAND_PRODUCT §7.4): a `trial_days` gift code
   *  (e.g. from a `?trial=` link) redeemed at signup for an immediate
   *  time-boxed trial (e.g. 60 days of Solo) instead of the free plan. */
  trialCode?: string;
  /** Click-wrap consent: the "I agree to the Terms / Privacy / Acceptable
   *  Use" checkbox. Recorded per tenant (version + timestamp) on the gateway;
   *  REQUIRED there when LEGAL_CONSENT_REQUIRED=1. */
  acceptTerms?: boolean;
  /** ADR-024 Phase 2b — data-residency region to pin the new tenant to
   *  ("choose your data region" signup step). Only meaningful on the
   *  fresh-tenant path; ignored (the gateway already has a pinned region) on
   *  invite joins. Absent → the gateway's 'us' schema default. */
  region?: TenantRegion;
}

interface TenantContextValue {
  current: TenantSession | null;
  tenants: TenantSession[];
  loading: boolean;
  /** The single-operator session (lib/operator-auth.ts), which is INDEPENDENT of
   *  tenant sessions: it is minted by /operator-login into an httpOnly
   *  `myai_operator` cookie and has no tenant, plan or API key. The sidebar's
   *  "Sign in" chip points at /operator-login, so without this the UI could not
   *  tell that an operator had signed in at all — see the 2026-09-12 report. */
  operator: { user: string } | null;
  /** Ends the operator session (clears the cookie). */
  operatorLogout: () => Promise<void>;
  /** PRIMARY: email + password → JWT session cookie. Throws MfaRequiredError
   *  (carrying a pendingToken) when the account has TOTP enabled instead of
   *  resolving — the caller must then call completeTotpLogin. */
  loginWithPassword: (email: string, password: string) => Promise<TenantSession>;
  /** Second half of a TOTP-gated login: pendingToken from a caught
   *  MfaRequiredError + a 6-digit code (or a recovery code) → JWT session cookie. */
  completeTotpLogin: (pendingToken: string, code: string) => Promise<TenantSession>;
  /** PRIMARY (passwordless): request a one-time sign-in link by email. Always
   *  resolves — the caller learns nothing about whether the address exists. */
  requestMagicLink: (email: string) => Promise<void>;
  /** PRIMARY (passwordless): complete sign-in with a magic-link token → JWT
   *  session cookie (same session shape as loginWithPassword). */
  loginWithMagicLink: (token: string) => Promise<TenantSession>;
  /** PRIMARY: create org + owner user (show-once API key), or join an
   *  existing tenant via invite (no API key). */
  signup: (input: SignupInput) => Promise<{ session: TenantSession; apiKey?: string; trialEndsAt?: string }>;
  /** SECONDARY: paste a per-tenant API key ("connect a tool / CLI"). */
  connectWithKey: (apiKey: string) => Promise<TenantSession>;
  switchTenant: (tenantId: string) => void;
  logout: (tenantId?: string) => void;
  /** Authorization header for the active tenant (empty if no key / signed out). */
  authHeaders: () => Record<string, string>;
}

const STORAGE_KEY = 'myai.tenants.v1';
const CURRENT_KEY = 'myai.tenant.current.v1';

const TenantCtx = createContext<TenantContextValue | null>(null);

export function useTenant(): TenantContextValue {
  const v = useContext(TenantCtx);
  if (!v) throw new Error('useTenant must be used within <TenantProvider>');
  return v;
}

function readStored(): { list: TenantSession[]; current: string | null } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const cur = localStorage.getItem(CURRENT_KEY);
    const list = raw ? (JSON.parse(raw) as TenantSession[]) : [];
    return { list: Array.isArray(list) ? list : [], current: cur };
  } catch {
    return { list: [], current: null };
  }
}

/** What /api/auth/me tells us about the cookie session (subset we consume). */
export interface MeSession {
  tenantId?: string;
  tenantName?: string;
  tenantPlan?: string;
}

/**
 * Reconcile the locally stored sessions with what the server says the httpOnly
 * cookie is worth. Pure so it can be tested without a DOM.
 *
 * `me` = null means /api/auth/me answered 401 (no valid cookie).
 * Returns the next session list plus which tenant should be current.
 */
export function reconcileTenantSessions(
  stored: TenantSession[],
  me: MeSession | null,
): { list: TenantSession[]; current: string | null } {
  if (me?.tenantId) {
    const existing = stored.find((t) => t.tenantId === me.tenantId);
    const session: TenantSession = {
      tenantId: me.tenantId,
      name: me.tenantName || existing?.name || me.tenantId,
      plan: me.tenantPlan || existing?.plan || 'free',
      // /me never returns an API key; dropping one already held for this tenant
      // would break key-authenticated calls.
      ...(existing?.apiKey ? { apiKey: existing.apiKey } : {}),
    };
    return {
      list: [...stored.filter((t) => t.tenantId !== me.tenantId), session],
      current: me.tenantId,
    };
  }
  // No valid cookie: drop stale JWT-only sessions, keep API-key ones (they
  // carry no JWT by design, so a 401 says nothing about them).
  const list = stored.filter((t) => t.apiKey);
  return { list, current: list[0]?.tenantId ?? null };
}

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [tenants, setTenants] = useState<TenantSession[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [operator, setOperator] = useState<{ user: string } | null>(null);

  // Hydrate from localStorage, then RECONCILE WITH THE SERVER.
  //
  // WHY the server round-trip (operator report 2026-09-12: "when logged in
  // still shows sign in option"): the httpOnly `myai_token` cookie is the real
  // credential, but this context used to derive its entire notion of "am I
  // signed in?" from localStorage alone. Any path that sets the cookie without
  // also writing localStorage — a different browser profile, cleared site data,
  // private mode, a magic-link/invite landing, or a storage write that threw —
  // left `current` null while the session was perfectly valid, so the switcher
  // rendered its signed-out "Sign in" link to an already-authenticated user.
  //
  // The mirror case is handled too: a stale localStorage entry for a session
  // whose cookie has since expired used to render a tenant while every API call
  // 401'd. API-KEY sessions (show-once signup / "connect a tool") are exempt —
  // they carry no JWT by design, so a 401 from /api/auth/me says nothing about
  // them and they are left alone.
  useEffect(() => {
    let cancelled = false;
    const { list, current } = readStored();
    setTenants(list);
    setCurrentId(current && list.some((t) => t.tenantId === current) ? current : list[0]?.tenantId ?? null);

    (async () => {
      let me: {
        tenantId?: string;
        tenantName?: string;
        tenantPlan?: string;
      } | null = null;
      try {
        // Both sessions are asked for together: they are independent, and a
        // machine can hold either, both or neither.
        const [meRes, opRes] = await Promise.all([
          fetch('/api/auth/me', { cache: 'no-store' }),
          fetch('/api/auth/operator', { cache: 'no-store' }).catch(() => null),
        ]);
        if (meRes.ok) me = await meRes.json();
        if (opRes?.ok) {
          const op = await opRes.json();
          if (!cancelled && op?.user) setOperator({ user: op.user });
        }
      } catch {
        /* offline / gateway down — keep whatever localStorage gave us */
        if (!cancelled) setLoading(false);
        return;
      }
      if (cancelled) return;

      const { list: next, current: cur } = reconcileTenantSessions(list, me);
      setTenants(next);
      setCurrentId(cur);
      persistRef.current(next, cur);
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Written to by the effect above, which must not depend on `persist`
  // (declared below) to stay mount-only.
  const persistRef = useRef<(list: TenantSession[], cur: string | null) => void>(() => {});

  const persist = useCallback((list: TenantSession[], cur: string | null) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      if (cur) localStorage.setItem(CURRENT_KEY, cur);
      else localStorage.removeItem(CURRENT_KEY);
    } catch {
      /* storage unavailable (private mode) — context still works in-memory */
    }
  }, []);

  persistRef.current = persist;

  const upsert = useCallback(
    (session: TenantSession) => {
      setTenants((prev) => {
        const next = [...prev.filter((t) => t.tenantId !== session.tenantId), session];
        persist(next, session.tenantId);
        return next;
      });
      setCurrentId(session.tenantId);
    },
    [persist],
  );

  // PRIMARY — email + password. The route sets an httpOnly JWT cookie; the
  // session here carries no API key (the cookie is the credential).
  const loginWithPassword = useCallback(
    async (email: string, password: string): Promise<TenantSession> => {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'login failed');
      if (json.mfaRequired) throw new MfaRequiredError(json.pendingToken);
      const session: TenantSession = { ...json.tenant, totpEnrollmentRequired: !!json.user?.totpEnrollmentRequired };
      upsert(session);
      return session;
    },
    [upsert],
  );

  // Second half of a TOTP-gated login: pendingToken (from a caught
  // MfaRequiredError) + a 6-digit authenticator code, or a one-time recovery
  // code. The route sets an httpOnly JWT cookie; the session here carries no
  // API key, same as loginWithPassword.
  const completeTotpLogin = useCallback(
    async (pendingToken: string, code: string): Promise<TenantSession> => {
      const res = await fetch('/api/auth/totp/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pendingToken, code }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'verification failed');
      const session: TenantSession = { ...json.tenant };
      upsert(session);
      return session;
    },
    [upsert],
  );

  // PRIMARY (passwordless) — request a one-time sign-in link by email.
  const requestMagicLink = useCallback(async (email: string): Promise<void> => {
    const res = await fetch('/api/auth/magic-link/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.error || 'sign-in link request failed');
  }, []);

  // PRIMARY (passwordless) — complete sign-in with a magic-link token. The
  // route sets an httpOnly JWT cookie; the session here carries no API key,
  // same as loginWithPassword.
  const loginWithMagicLink = useCallback(
    async (token: string): Promise<TenantSession> => {
      const res = await fetch('/api/auth/magic-link/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'sign-in failed');
      const session: TenantSession = { ...json.tenant };
      upsert(session);
      return session;
    },
    [upsert],
  );

  // PRIMARY — create org + owner user (email/password), or join an existing
  // tenant when an invite token is supplied. New-org signups return the
  // show-once API key; invite joins never re-expose the tenant's key.
  const signup = useCallback(
    async (input: SignupInput): Promise<{ session: TenantSession; apiKey?: string; trialEndsAt?: string }> => {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'signup failed');
      const session: TenantSession = { ...json.tenant, apiKey: json.apiKey };
      upsert(session);
      return { session, apiKey: json.apiKey, trialEndsAt: json.trialEndsAt };
    },
    [upsert],
  );

  // SECONDARY — paste a per-tenant API key ("connect a tool / CLI"). Validates
  // against the gateway-mirror route and keeps the key on the session for
  // programmatic (Bearer) calls.
  const connectWithKey = useCallback(
    async (apiKey: string): Promise<TenantSession> => {
      const res = await fetch('/api/auth/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'connect failed');
      const session: TenantSession = { ...json.tenant, apiKey };
      upsert(session);
      return session;
    },
    [upsert],
  );

  const switchTenant = useCallback(
    (tenantId: string) => {
      setTenants((prev) => {
        if (!prev.some((t) => t.tenantId === tenantId)) return prev;
        setCurrentId(tenantId);
        persist(prev, tenantId);
        return prev;
      });
    },
    [persist],
  );

  const logout = useCallback(
    (tenantId?: string) => {
      setTenants((prev) => {
        const next = tenantId ? prev.filter((t) => t.tenantId !== tenantId) : [];
        setCurrentId((cur) => {
          const newCur = tenantId
            ? cur === tenantId
              ? next[0]?.tenantId ?? null
              : cur
            : null;
          persist(next, newCur);
          return newCur;
        });
        return next;
      });
    },
    [persist],
  );

  const current = useMemo(
    () => tenants.find((t) => t.tenantId === currentId) ?? null,
    [tenants, currentId],
  );

  const authHeaders = useCallback(
    (): Record<string, string> => (current?.apiKey ? { Authorization: `Bearer ${current.apiKey}` } : {}),
    [current],
  );

  const operatorLogout = useCallback(async () => {
    try {
      await fetch('/api/auth/operator', { method: 'DELETE' });
    } finally {
      setOperator(null);
    }
  }, []);

  const value = useMemo<TenantContextValue>(
    () => ({
      current,
      tenants,
      loading,
      operator,
      operatorLogout,
      loginWithPassword,
      completeTotpLogin,
      requestMagicLink,
      loginWithMagicLink,
      signup,
      connectWithKey,
      switchTenant,
      logout,
      authHeaders,
    }),
    [
      operator,
      operatorLogout,
      current,
      tenants,
      loading,
      loginWithPassword,
      completeTotpLogin,
      requestMagicLink,
      loginWithMagicLink,
      signup,
      connectWithKey,
      switchTenant,
      logout,
      authHeaders,
    ],
  );

  return <TenantCtx.Provider value={value}>{children}</TenantCtx.Provider>;
}
