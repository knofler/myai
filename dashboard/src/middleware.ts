// Hosted login-wall (opt-in). When REQUIRE_LOGIN=true, non-loopback requests
// without a session cookie are redirected to /login. This is what makes the
// dashboard safe to expose on a public domain — but it is OFF by default and
// ALWAYS exempts localhost, honouring the standing requirement that local /
// loopback access never requires a login (see src/lib/tenant.ts).
//
// Coarse gate by design: it checks for the presence of the `myai_token` cookie
// only. Real JWT verification happens server-side at the gateway on every data
// call (runtime/src/core/auth.ts) — the middleware just decides redirect-vs-render.
//
// NOTE: REQUIRE_LOGIN is read at BUILD time (Next inlines process.env into the
// edge bundle). Set it when building the hosted image; local dev leaves it unset
// → the gate is off. The localhost exemption works at runtime regardless, so a
// local build with the flag accidentally on still never locks you out.
import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/session-cookie';
import { OPERATOR_COOKIE, verifyOperatorToken } from '@/lib/operator-auth';

// Always-public prefixes: the auth surface itself, health, and the marketing
// page must be reachable without a session.
const PUBLIC_PREFIXES = [
  '/login',
  '/welcome',
  '/pricing',
  '/api/auth',
  '/api/health',
  '/status',
  '/api/status',
  // Trust pack — a buyer must reach these before creating an account.
  '/privacy',
  '/terms',
  '/acceptable-use',
  '/security',
  // Compliance pack — DPA + subprocessor list; procurement/legal reads these
  // pre-signature, so they must sit outside every wall like the trust pack.
  '/dpa',
  '/subprocessors',
  // GTM proof asset (GRAND_PRODUCT_ROADMAP §7.4) — anonymized aggregate stats,
  // never gated behind the login wall.
  '/proof',
  // Public developer portal — external integrators (Zapier/n8n connector
  // authors, direct API callers) need the API-key + curl-quickstart docs
  // before they can create an account.
  '/developers',
  // ── Stays open under the operator gate too (see OPERATOR_PUBLIC below) ──
  // Portfolio / marketing surface.
  '/showcase',
  // The operator sign-in form — must be reachable without a session.
  '/operator-login',
];

/**
 * Paths that remain reachable WITHOUT an operator session.
 *
 * Everything not listed here is control-plane surface and requires the operator
 * login (lib/operator-auth.ts). Keep this list boring and explicit: each entry is
 * a deliberate decision to expose something to the whole internet.
 */
/**
 * Carve-outs that override OPERATOR_PUBLIC.
 *
 * `/api/auth` is public so the login endpoints are reachable — but that prefix
 * also covers `/api/auth/signup`, i.e. self-service account creation. myAI is a
 * single-operator control plane, not a product with public registration, so
 * signup is explicitly closed. (A registration product belongs in its own app on
 * its own domain, not behind this gate.)
 */
const OPERATOR_DENY = ['/api/auth/signup'];

const OPERATOR_PUBLIC = [
  ...PUBLIC_PREFIXES,
  // Aggregate, anonymized analytics — public by design (GRAND_PRODUCT §7.4).
  '/proof',
  // Signed third-party callbacks. These authenticate themselves via provider
  // signatures; gating them would silently break billing and Connect payouts.
  '/api/billing/webhook',
  '/api/marketplace/connect/webhook',
  // Cache warm-up: authenticates itself (per-process token or CRON_SECRET)
  // and returns timings only, never data.
  '/api/warm',
];

// ── Read-only demo gate (GO_LIVE_PLAN P2 item 14, see src/lib/demo.ts) ──
// On the hosted demo deployment (NEXT_PUBLIC_DEMO_MODE=true) every mutating
// request is rejected here — the single choke point, since all dashboard
// writes are fetch calls to /api/*. Inlined at build time like REQUIRE_LOGIN.
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
const DEMO_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Reads that use POST for a request body — safe to keep working in the demo.
const DEMO_POST_ALLOWLIST = new Set(['/api/sessions/search']);

// Local auto-login (task-a6930b2b, repeat operator ask 2026-10-02): trust a
// single, narrow signal that ONLY `loopback-gate.js` can produce — never a
// client, never Next itself. That file is the sole process bound to the
// published port; it strips any client-supplied copy of this header before
// setting its own, and only sets it when DASHBOARD_LOCAL_AUTOLOGIN=1 AND
// HOST_BIND=127.0.0.1 AND the connection's real peer address looks loopback
// (see its comments for why both env conditions are required on Docker
// Desktop). Unlike the old Host-header exemption this replaces nothing and
// adds no new trust in `req.headers.get('host')` or any forwarded-for header.
const LOOPBACK_AUTOLOGIN_HEADER = 'x-myai-verified-loopback';

/**
 * True only when loopback-gate.js has vouched for this exact request AND we
 * are not running on Vercel. The `VERCEL` check is independent of the
 * DASHBOARD_LOCAL_AUTOLOGIN flag on purpose: Vercel sets `VERCEL=1` itself
 * (not client-settable) in both its build and runtime environment, so even a
 * misconfigured hosted deploy that somehow carried DASHBOARD_LOCAL_AUTOLOGIN
 * into its env cannot be tricked into trusting a client-sent copy of the
 * header — there is no loopback-gate.js running there to have stripped it.
 */
function isVerifiedLocalAutologin(req: NextRequest): boolean {
  return process.env.VERCEL !== '1' && req.headers.get(LOOPBACK_AUTOLOGIN_HEADER) === '1';
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const h = host.toLowerCase();
  return (
    h.startsWith('localhost') ||
    h.startsWith('127.0.0.1') ||
    h.startsWith('[::1]') ||
    h.startsWith('::1')
  );
}

export async function middleware(req: NextRequest) {
  // Demo gate first — a read-only demo must stay read-only regardless of any
  // other switch. Loopback is NOT exempt here (unlike the login wall): demo
  // mode exists to protect the shared demo database, not the visitor.
  if (
    DEMO_MODE &&
    !DEMO_SAFE_METHODS.has(req.method) &&
    !DEMO_POST_ALLOWLIST.has(req.nextUrl.pathname)
  ) {
    return NextResponse.json(
      { error: 'This is a read-only demo — writes are disabled. Install myAI to get your own workspace.' },
      { status: 403 },
    );
  }

  const { pathname } = req.nextUrl;

  // ── Operator gate (GHSA-ffgf-pmmg-cjj5 follow-through) ─────────────────────
  // The control plane requires the single-operator session. This runs ALWAYS —
  // not behind REQUIRE_LOGIN — and has no Host-header "loopback" exemption,
  // because that header is attacker-controlled and inside Docker every request
  // arrives via the bridge, so `Host: localhost` would have bypassed it from
  // anywhere on the network.
  //
  // FAIL CLOSED: with no MYAI_ADMIN_* configured (the production posture — the
  // credential lives only in a local gitignored .env) no token can verify, so
  // every control-plane path is refused for everyone while the public surfaces
  // above stay open.
  const operatorDenied = OPERATOR_DENY.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  const operatorPublic =
    !operatorDenied && OPERATOR_PUBLIC.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  if (!operatorPublic) {
    // Local auto-login bypass — never for the explicitly-denied paths (e.g.
    // signup stays closed to everyone, loopback included; see OPERATOR_DENY).
    if (!operatorDenied && isVerifiedLocalAutologin(req)) {
      return NextResponse.next();
    }
    const operator = await verifyOperatorToken(req.cookies.get(OPERATOR_COOKIE)?.value);
    if (!operator) {
      if (pathname.startsWith('/api/')) {
        return NextResponse.json({ error: 'operator authentication required' }, { status: 401 });
      }
      // MUST be the operator form, not /login. /login is the multi-tenant
      // sign-in (magic link / signup / reset) and posts to different endpoints
      // issuing myai_token — operator credentials entered there can never work.
      const url = req.nextUrl.clone();
      url.pathname = '/operator-login';
      url.searchParams.set('next', pathname);
      return NextResponse.redirect(url);
    }
    return NextResponse.next();
  }

  // Master switch — off unless explicitly enabled for a hosted build.
  if (process.env.REQUIRE_LOGIN !== 'true') return NextResponse.next();

  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  // STANDING REQUIREMENT: localhost / loopback is never gated, on any machine.
  if (isLoopbackHost(req.headers.get('host'))) return NextResponse.next();

  // Session present → let it through (gateway verifies the JWT on data calls).
  if (req.cookies.get(SESSION_COOKIE_NAME)) return NextResponse.next();

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.searchParams.set('next', pathname);
  return NextResponse.redirect(url);
}

// Run on everything except Next internals / static assets.
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)'],
};
