/**
 * Claude CLI bridge access guard — v1 gate G5, H-6.
 *
 * The bridge runs `claude -p` as the operator, so it binds loopback by default
 * (Docker Desktop still reaches it through host.docker.internal) and every
 * prompt must carry the shared LLM_BRIDGE_TOKEN in `x-bridge-token`. The bridge
 * refuses to start without a token; the gateway sends the same variable.
 */
import { timingSafeEqual } from 'node:crypto';

export const BRIDGE_TOKEN_HEADER = 'x-bridge-token';

/** Host to bind: BRIDGE_HOST, else loopback. */
export function bridgeBindHost(env: NodeJS.ProcessEnv = process.env): string {
  return env.BRIDGE_HOST?.trim() || '127.0.0.1';
}

/** The configured shared token, or null when unset/blank. */
export function bridgeToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = env.LLM_BRIDGE_TOKEN?.trim();
  return t ? t : null;
}

/** Constant-time check of the request header against the configured token. */
export function bridgeRequestAuthorized(provided: string | string[] | undefined, expected: string | null): boolean {
  if (!expected || typeof provided !== 'string' || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
