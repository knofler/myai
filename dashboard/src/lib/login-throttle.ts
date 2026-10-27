// Per-client throttle for the operator login (audit M-7, v1 G5). Five failed
// attempts in fifteen minutes from one client locks that client out until the
// oldest failure ages out; a success clears its record.
//
// In-memory and per process: exactly right for the self-hosted dashboard (one
// Next process behind loopback-gate.js, which overwrites X-Forwarded-For with
// the real peer so a client cannot mint a fresh key per attempt). On Vercel
// each instance keeps its own count, so it slows an attacker without being a
// hard global limit; the password check itself is PBKDF2-slow either way.

export const LOGIN_WINDOW_MS = 15 * 60_000;
export const LOGIN_MAX_FAILURES = 5;
const MAX_TRACKED = 10_000;

const failures = new Map<string, number[]>();

/** The caller's client key: the first X-Forwarded-For hop, else X-Real-IP. */
export function loginClientKey(req: Request): string {
  const xff = req.headers.get('x-forwarded-for');
  const first = xff?.split(',')[0]?.trim();
  return first || req.headers.get('x-real-ip')?.trim() || 'unknown';
}

function recent(key: string, now: number): number[] {
  const kept = (failures.get(key) ?? []).filter((t) => now - t < LOGIN_WINDOW_MS);
  if (kept.length) failures.set(key, kept);
  else failures.delete(key);
  return kept;
}

/** Seconds until this client may try again, or 0 when it may try now. */
export function loginRetryAfterSeconds(key: string, now = Date.now()): number {
  const kept = recent(key, now);
  if (kept.length < LOGIN_MAX_FAILURES) return 0;
  return Math.max(1, Math.ceil((kept[0] + LOGIN_WINDOW_MS - now) / 1000));
}

export function recordLoginFailure(key: string, now = Date.now()): void {
  if (failures.size >= MAX_TRACKED) {
    for (const k of failures.keys()) recent(k, now); // drop aged-out clients
    if (failures.size >= MAX_TRACKED) failures.delete(failures.keys().next().value as string);
  }
  failures.set(key, [...recent(key, now), now]);
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

/** Tests only. */
export function resetLoginThrottle(): void {
  failures.clear();
}
