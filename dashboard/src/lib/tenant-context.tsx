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
  useState,
} from 'react';

export interface TenantSession {
  tenantId: string;
  name: string;
  plan: string;
  /** The raw per-tenant API key (Bearer). Optional: present only when the
   *  session was established by a show-once signup or the "connect a tool"
   *  key flow. Password logins have no key (the JWT cookie is the credential). */
  apiKey?: string;
}

export interface SignupInput {
  /** Organisation / tenant display name (not needed when joining by invite). */
  name?: string;
  email: string;
  password: string;
  /** Team tier: join the inviter's existing tenant instead of creating one. */
  inviteToken?: string;
}

interface TenantContextValue {
  current: TenantSession | null;
  tenants: TenantSession[];
  loading: boolean;
  /** PRIMARY: email + password → JWT session cookie. */
  loginWithPassword: (email: string, password: string) => Promise<TenantSession>;
  /** PRIMARY (passwordless): request a one-time sign-in link by email. Always
   *  resolves — the caller learns nothing about whether the address exists. */
  requestMagicLink: (email: string) => Promise<void>;
  /** PRIMARY (passwordless): complete sign-in with a magic-link token → JWT
   *  session cookie (same session shape as loginWithPassword). */
  loginWithMagicLink: (token: string) => Promise<TenantSession>;
  /** PRIMARY: create org + owner user (show-once API key), or join an
   *  existing tenant via invite (no API key). */
  signup: (input: SignupInput) => Promise<{ session: TenantSession; apiKey?: string }>;
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

export function TenantProvider({ children }: { children: React.ReactNode }) {
  const [tenants, setTenants] = useState<TenantSession[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const { list, current } = readStored();
    setTenants(list);
    setCurrentId(current && list.some((t) => t.tenantId === current) ? current : list[0]?.tenantId ?? null);
    setLoading(false);
  }, []);

  const persist = useCallback((list: TenantSession[], cur: string | null) => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
      if (cur) localStorage.setItem(CURRENT_KEY, cur);
      else localStorage.removeItem(CURRENT_KEY);
    } catch {
      /* storage unavailable (private mode) — context still works in-memory */
    }
  }, []);

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
    async (input: SignupInput): Promise<{ session: TenantSession; apiKey?: string }> => {
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error || 'signup failed');
      const session: TenantSession = { ...json.tenant, apiKey: json.apiKey };
      upsert(session);
      return { session, apiKey: json.apiKey };
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

  const value = useMemo<TenantContextValue>(
    () => ({
      current,
      tenants,
      loading,
      loginWithPassword,
      requestMagicLink,
      loginWithMagicLink,
      signup,
      connectWithKey,
      switchTenant,
      logout,
      authHeaders,
    }),
    [
      current,
      tenants,
      loading,
      loginWithPassword,
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
