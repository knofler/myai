// Shared `myai_token` cookie options — GRAND_PRODUCT §3.2 seam 5 (auth
// unification). Every route that sets or clears the session cookie
// (login/signup/magic-link consume, session revoke) goes through here so the
// options can never drift between call sites.
//
// `SESSION_COOKIE_DOMAIN` (unset by default) is the cross-app piece: setting it
// to a shared parent domain (e.g. `.myai.app`) makes the cookie readable by
// agentFlow's and Connect Hub's Next.js apps when they're deployed on sibling
// subdomains of the same parent (agentflow.myai.app, connect.myai.app) — one
// login on any of the three then spans all three, since they all resolve the
// SAME JWT against the gateway's `/api/auth/me`. Leaving it unset keeps today's
// single-host behavior exactly as-is (host-only cookie, no domain attribute).
// This is deliberately simpler than enterprise SSO (core/sso.ts) — no IdP, no
// per-tenant config, just one shared cookie + the gateway as the one verifier.
import type { NextResponse } from 'next/server';

export const SESSION_COOKIE_NAME = 'myai_token';

export interface SessionCookieOptions {
  httpOnly: true;
  secure: boolean;
  sameSite: 'lax';
  path: '/';
  maxAge: number;
  domain?: string;
}

function cookieDomain(): string | undefined {
  const d = process.env.SESSION_COOKIE_DOMAIN?.trim();
  return d ? d : undefined;
}

/** Options for setting the session cookie after a successful login/signup/consume. */
export function sessionCookieOptions(maxAgeSeconds: number): SessionCookieOptions {
  const domain = cookieDomain();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
    ...(domain ? { domain } : {}),
  };
}

/** Options for clearing the session cookie (revocation) — same domain, maxAge 0. */
export function clearSessionCookieOptions(): SessionCookieOptions {
  const domain = cookieDomain();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
    ...(domain ? { domain } : {}),
  };
}

/** Set the shared session cookie on a NextResponse. */
export function setSessionCookie(res: NextResponse, token: string, maxAgeSeconds: number): void {
  res.cookies.set(SESSION_COOKIE_NAME, token, sessionCookieOptions(maxAgeSeconds));
}

/** Clear the shared session cookie on a NextResponse. */
export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE_NAME, '', clearSessionCookieOptions());
}
