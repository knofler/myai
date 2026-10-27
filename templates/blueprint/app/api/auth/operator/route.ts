/**
 * POST /api/auth/operator   — single-operator login (see app/lib/operator-auth.ts)
 * DELETE /api/auth/operator — sign out
 *
 * Credentials come from a local, gitignored `.env.local` and nowhere else. A
 * deployment without `MYAI_ADMIN_*` configured cannot mint a session at all —
 * login returns 503 and every protected surface stays closed to everyone.
 * That is deliberate.
 *
 * Lives under /api/auth, which proxy.ts treats as public — otherwise
 * logging in would require already being logged in.
 */
import { NextResponse } from "next/server";
import {
  OPERATOR_COOKIE,
  OPERATOR_SESSION_SECONDS,
  issueOperatorToken,
  operatorLoginConfigured,
  verifyOperatorPassword,
} from "@/app/lib/operator-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// The operator cookie is Secure in production. If E2E ever runs a production
// build over plain http, a Secure cookie set over http won't survive a
// storageState round-trip — set MYAI_E2E_INSECURE_COOKIES=1 for that build
// only. Real deployments never set it, so production stays Secure.
const COOKIE_SECURE =
  process.env.NODE_ENV === "production" && process.env.MYAI_E2E_INSECURE_COOKIES !== "1";

export async function POST(req: Request) {
  if (!operatorLoginConfigured()) {
    // No credential on this deployment. Say so plainly — it is a deployment
    // posture, not a wrong password, and hiding it only confuses the operator.
    return NextResponse.json(
      { error: "operator login is not configured on this deployment" },
      { status: 503 },
    );
  }

  let body: { user?: unknown; password?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid request body" }, { status: 400 });
  }

  const user = typeof body.user === "string" ? body.user : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!user || !password) {
    return NextResponse.json({ error: "user and password are required" }, { status: 400 });
  }

  if (!(await verifyOperatorPassword(user, password))) {
    // One message for both wrong-user and wrong-password — never reveal which.
    return NextResponse.json({ error: "invalid credentials" }, { status: 401 });
  }

  const token = await issueOperatorToken(user);
  if (!token) {
    return NextResponse.json({ error: "session secret unavailable" }, { status: 503 });
  }

  const res = NextResponse.json({ ok: true, user });
  res.cookies.set(OPERATOR_COOKIE, token, {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: OPERATOR_SESSION_SECONDS,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(OPERATOR_COOKIE, "", {
    httpOnly: true,
    secure: COOKIE_SECURE,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return res;
}
