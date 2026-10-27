// Next.js 16 renamed middleware.ts -> proxy.ts (exported fn: proxy, not
// middleware) — functionality/matcher config are unchanged, file+fn only.
// Single-operator control-plane gate (see app/lib/operator-auth.ts for the why).
//
// Everything is gated by default — every route not explicitly listed in
// PUBLIC_PATHS requires a valid operator session. Add to PUBLIC_PATHS only
// for surfaces that must be reachable by anyone: marketing/landing pages,
// analytics endpoints, health checks, and signed third-party webhooks
// (those authenticate themselves via provider signatures — gating them would
// silently break the integration).
//
// FAIL CLOSED: with no MYAI_ADMIN_* configured (the default posture — the
// credential lives only in a local, gitignored .env.local) no token can ever
// verify, so every non-public path is refused for everyone.
import { NextResponse, type NextRequest } from "next/server";
import { OPERATOR_COOKIE, verifyOperatorToken } from "@/app/lib/operator-auth";

/** Reachable without an operator session. Keep this list boring and explicit —
 *  each entry is a deliberate decision to expose something to the internet. */
const PUBLIC_PATHS = [
  "/login",
  "/api/auth", // login/logout endpoints themselves must be reachable to log in
  "/api/health",
  "/api/openapi.json", // OpenAPI spec — CLAUDE.md rule 7, consumed unauthenticated by the MCP server
  "/docs", // Scalar docs render the spec above; same rule 7 exemption
  // Examples for when this app grows public surfaces — uncomment as needed:
  // "/pricing",
  // "/status",
  // "/api/webhooks", // signed third-party callbacks (verify signature in the route)
];

/**
 * Carve-outs that override PUBLIC_PATHS even though they live under a public
 * prefix. `/api/auth` is public so login/logout work — but that same prefix
 * would also cover a self-service `/api/auth/signup` if one is ever added.
 * Deny it by default: registration is an explicit product decision, not
 * something a control-plane app should expose just because auth is public.
 * Remove this line only once the app genuinely wants public registration.
 */
const OPERATOR_DENY = ["/api/auth/signup"];

function isPublic(pathname: string): boolean {
  if (OPERATOR_DENY.some((p) => pathname === p || pathname.startsWith(`${p}/`))) return false;
  return PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const operator = await verifyOperatorToken(req.cookies.get(OPERATOR_COOKIE)?.value);
  if (operator) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "operator authentication required" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

// Run on everything except Next internals / static assets.
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp)$).*)"],
};
