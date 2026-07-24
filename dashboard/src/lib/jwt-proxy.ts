// Shared helpers for dashboard→gateway proxy routes that authenticate with the
// user's session JWT (httpOnly `myai_token` cookie) rather than a tenant API
// key — the gateway's /api/auth/invites + /api/auth/members routes verify the
// JWT themselves (they are exempt from the API-key middleware).
import { SESSION_COOKIE_NAME } from './session-cookie';

/** Extract the myai_token JWT from the request's cookies. */
export function jwtFromCookies(req: Request): string | null {
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE_NAME}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** Gateway headers: JWT as Bearer + the in-cluster bridge token. */
export function gatewayAuthHeaders(jwt: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${jwt}`,
    ...(process.env.GATEWAY_LOCAL_TOKEN ? { 'x-gateway-local-token': process.env.GATEWAY_LOCAL_TOKEN } : {}),
  };
}
