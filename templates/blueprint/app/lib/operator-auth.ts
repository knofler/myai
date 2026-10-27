/**
 * Single-operator login for the app's control plane.
 *
 * WHY THIS EXISTS: a scaffolded app's API routes are reachable by anyone who
 * finds the URL unless something gates them. Without a gate, a route like
 * `GET /api/todos` serves live data to the whole internet, and a `POST` on
 * the same route accepts writes from anyone too. This module is that gate —
 * ship it enabled by default rather than adding it reactively after an
 * incident.
 *
 * ── FAIL CLOSED BY DESIGN ──────────────────────────────────────────────────
 * The credential lives ONLY in a local, gitignored `.env.local` (see
 * `.env.example`). A deployment that has no `MYAI_ADMIN_*` configured
 * therefore has NO valid credential and NO verifiable session — every
 * protected path is refused for everyone, including the operator. That is
 * the intended default posture: public surfaces (health checks, marketing,
 * signed webhooks) stay open, the control plane is simply not reachable
 * until the operator deliberately configures credentials.
 *
 * ── NO HOST-HEADER EXEMPTION ───────────────────────────────────────────────
 * Do not add a "loopback" exemption keyed off the `Host` header — that
 * header is attacker-controlled, and inside Docker every request arrives via
 * the bridge network, so `Host: localhost` would bypass the gate from
 * anywhere on the network. Local access uses the same login as everything
 * else.
 *
 * Uses Web Crypto only (no node:crypto) — historically required because
 * middleware ran on the Edge runtime. Next.js 16's proxy.ts always runs on
 * the Node.js runtime (the Edge option was removed), so node:crypto would
 * work too now, but Web Crypto is kept: it also runs in route handlers
 * without an extra import surface, and there is no reason to reintroduce a
 * node:crypto dependency into code this security-sensitive.
 */

const enc = new TextEncoder();

export const OPERATOR_COOKIE = "myai_operator";
/** Session lifetime. Short enough to bound a stolen cookie, long enough to work in. */
export const OPERATOR_SESSION_SECONDS = 12 * 60 * 60;

function b64urlFromBytes(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(pad + "=".repeat((4 - (pad.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** Constant-time comparison — never short-circuits on the first differing byte. */
function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** True only when a complete operator credential set is configured. */
export function operatorLoginConfigured(): boolean {
  return Boolean(
    process.env.MYAI_ADMIN_USER &&
      process.env.MYAI_ADMIN_PASSWORD_HASH &&
      process.env.MYAI_ADMIN_SESSION_SECRET,
  );
}

// ── password verification ────────────────────────────────────────────────
// Stored form: pbkdf2$<iterations>$<saltB64>$<hashB64>   (base64, not b64url)

export async function verifyOperatorPassword(user: string, password: string): Promise<boolean> {
  const expectedUser = process.env.MYAI_ADMIN_USER;
  const stored = process.env.MYAI_ADMIN_PASSWORD_HASH;
  if (!expectedUser || !stored) return false;

  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const [, iterationsStr, saltB64, hashB64] = parts;
  if (iterationsStr === undefined || saltB64 === undefined || hashB64 === undefined) return false;
  const iterations = Number(iterationsStr);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
    expected = Uint8Array.from(atob(hashB64), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }

  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" },
    key,
    expected.length * 8,
  );

  // Compare BOTH factors in constant time, and always do the (expensive) derive
  // first so a wrong username is not measurably faster than a wrong password.
  const userOk = timingSafeEqual(enc.encode(user), enc.encode(expectedUser));
  const passOk = timingSafeEqual(new Uint8Array(bits), expected);
  return userOk && passOk;
}

// ── session token: <payloadB64url>.<hmacB64url> ──────────────────────────

async function hmacKey(): Promise<CryptoKey | null> {
  const secret = process.env.MYAI_ADMIN_SESSION_SECRET;
  if (!secret) return null;
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

export async function issueOperatorToken(user: string, nowMs = Date.now()): Promise<string | null> {
  const key = await hmacKey();
  if (!key) return null;
  const payload = JSON.stringify({ u: user, exp: Math.floor(nowMs / 1000) + OPERATOR_SESSION_SECONDS });
  const payloadB64 = b64urlFromBytes(enc.encode(payload));
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return `${payloadB64}.${b64urlFromBytes(new Uint8Array(sig))}`;
}

/**
 * Verify a session token. Returns the username, or null.
 * Null whenever anything is off — unconfigured, malformed, bad signature, expired.
 */
export async function verifyOperatorToken(token: string | undefined, nowMs = Date.now()): Promise<string | null> {
  if (!token) return null;
  const key = await hmacKey();
  if (!key) return null; // not configured → nothing can ever verify (fail closed)

  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let sig: Uint8Array;
  try {
    sig = bytesFromB64url(sigB64);
  } catch {
    return null;
  }

  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64)));
  if (!timingSafeEqual(sig, expected)) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(bytesFromB64url(payloadB64))) as {
      u?: unknown;
      exp?: unknown;
    };
    if (typeof claims.u !== "string" || typeof claims.exp !== "number") return null;
    if (claims.exp * 1000 <= nowMs) return null;
    return claims.u;
  } catch {
    return null;
  }
}
