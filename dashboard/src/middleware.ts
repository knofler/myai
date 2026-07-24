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
  '/security',
  // GTM proof asset (GRAND_PRODUCT_ROADMAP §7.4) — anonymized aggregate stats,
  // never gated behind the login wall.
  '/proof',
  // Public developer portal — external integrators (Zapier/n8n connector
  // authors, direct API callers) need the API-key + curl-quickstart docs
  // before they can create an account.
  '/developers',
];

// ── Read-only demo gate (GO_LIVE_PLAN P2 item 14, see src/lib/demo.ts) ──
// On the hosted demo deployment (NEXT_PUBLIC_DEMO_MODE=true) every mutating
// request is rejected here — the single choke point, since all dashboard
// writes are fetch calls to /api/*. Inlined at build time like REQUIRE_LOGIN.
const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === 'true';
const DEMO_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Reads that use POST for a request body — safe to keep working in the demo.
const DEMO_POST_ALLOWLIST = new Set(['/api/sessions/search']);

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

export function middleware(req: NextRequest) {
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

  // Master switch — off unless explicitly enabled for a hosted build.
  if (process.env.REQUIRE_LOGIN !== 'true') return NextResponse.next();

  const { pathname } = req.nextUrl;
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
