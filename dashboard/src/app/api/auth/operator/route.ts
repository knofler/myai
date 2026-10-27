/**
 * GET /api/auth/operator    — who is signed in as operator (or 401)
 * POST /api/auth/operator   — single-operator login (see lib/operator-auth.ts)
 * DELETE /api/auth/operator — sign out
 *
 * Credentials come from a local, gitignored `.env` and nowhere else. A deployment
 * without `MYAI_ADMIN_*` configured cannot mint a session at all — login returns
 * 503 and every protected surface stays closed to everyone. That is deliberate.
 *
 * Lives under /api/auth, which middleware treats as public — otherwise logging in
 * would require already being logged in.
 */
import { NextResponse } from 'next/server';
import {
  OPERATOR_COOKIE,
  OPERATOR_SESSION_SECONDS,
  issueOperatorToken,
  operatorLoginConfigured,
  verifyOperatorPassword,
  verifyOperatorToken,
} from '@/lib/operator-auth';
import {
  clearLoginFailures,
  loginClientKey,
  loginRetryAfterSeconds,
  recordLoginFailure,
} from '@/lib/login-throttle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The operator cookie is Secure in production. The CI E2E runs the *production*
// build over plain http (127.0.0.1): a Secure cookie set over http never
// survives Playwright's APIRequestContext → global-setup → storageState
// round-trip, so the authenticated control-plane specs would 401. The
// MYAI_E2E_INSECURE_COOKIES escape hatch — set ONLY by docker-compose.ci-e2e.yml
// — opts that one build out. Real deployments never set it, so production stays
// Secure. (Bracketed so a future https-derived flag can slot in here.)
const COOKIE_SECURE =
  process.env.NODE_ENV === 'production' && process.env.MYAI_E2E_INSECURE_COOKIES !== '1';

// GET — the client cannot see the operator cookie (httpOnly by design), so it
// has no way to answer "am I signed in?" without asking the server.
//
// WHY THIS EXISTS (operator report 2026-09-12, "Sign in still visible after
// login"): this dashboard has TWO independent sessions — the OPERATOR cookie
// minted here, and the TENANT JWT (`myai_token`) minted by /api/auth/login.
// The sidebar's "Sign in" chip links to /operator-login, but the tenant
// switcher only ever looked for a TENANT session, so signing in as operator
// left the chip reading "Sign in" forever. Nothing was broken about the login
// itself — the UI simply had no way to observe it.
export async function GET(req: Request) {
  const cookie = req.headers.get('cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${OPERATOR_COOKIE}=([^;]*)`));
  const user = await verifyOperatorToken(match?.[1] ? decodeURIComponent(match[1]) : undefined);
  if (!user) return NextResponse.json({ error: 'not authenticated' }, { status: 401 });
  return NextResponse.json({ user });
}

export async function POST(req: Request) {
  if (!operatorLoginConfigured()) {
    // No credential on this deployment. Say so plainly — it is a deployment
    // posture, not a wrong password, and hiding it only confuses the operator.
    return NextResponse.json(
      { error: 'operator login is not configured on this deployment' },
      { status: 503 },
    );
  }

  // Audit M-7 (v1 G5): throttle guessing per client, before any password work.
  const client = loginClientKey(req);
  const retryAfter = loginRetryAfterSeconds(client);
  if (retryAfter > 0) {
    return NextResponse.json(
      { error: 'too many failed attempts, try again later' },
      { status: 429, headers: { 'Retry-After': String(retryAfter) } },
    );
  }

  let body: { user?: unknown; password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 });
  }

  const user = typeof body.user === 'string' ? body.user : '';
  const password = typeof body.password === 'string' ? body.password : '';
  if (!user || !password) {
    return NextResponse.json({ error: 'user and password are required' }, { status: 400 });
  }

  if (!(await verifyOperatorPassword(user, password))) {
    recordLoginFailure(client);
    // One message for both wrong-user and wrong-password — never reveal which.
    return NextResponse.json({ error: 'invalid credentials' }, { status: 401 });
  }
  clearLoginFailures(client);

  const token = await issueOperatorToken(user);
  if (!token) {
    return NextResponse.json({ error: 'session secret unavailable' }, { status: 503 });
  }

  const res = NextResponse.json({ ok: true, user });
  res.cookies.set(OPERATOR_COOKIE, token, {
    httpOnly: true,                                   // not readable by JS — unlike myai_tenant, which is how we got here
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: OPERATOR_SESSION_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(OPERATOR_COOKIE, '', {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return res;
}
