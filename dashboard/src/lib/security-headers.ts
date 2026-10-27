// Response security headers for every dashboard route (audit M-6, v1 G5).
// Lives outside next.config.ts so the policy is unit-tested.
//
// script-src keeps 'unsafe-inline': Next's App Router bootstraps with inline
// scripts and the layout's theme-boot script runs before paint. A nonce-based
// policy needs per-request rendering and is a follow-up. Everything else is
// locked to this origin: no third-party scripts, styles, fonts or frames load
// today (checked when this was written), so any new one has to be added here
// on purpose. connect-src also allows the gateway URLs the browser calls
// directly (apps/repo-health.tsx, developers/page.tsx).
// Framing is SAMEORIGIN, not DENY: /tour embeds its own /tour/*.html pages.

type Env = Record<string, string | undefined>;

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export function contentSecurityPolicy(env: Env = process.env): string {
  const gateways = [
    originOf(env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:3200'),
    originOf(env.NEXT_PUBLIC_GATEWAY_MCP_URL || 'http://localhost:3100'),
  ].filter((o): o is string => !!o);
  const dev = env.NODE_ENV !== 'production';
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${dev ? " 'unsafe-eval'" : ''}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    `connect-src 'self' ${[...new Set(gateways)].join(' ')}`.trim(),
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

export function securityHeaders(env: Env = process.env): { key: string; value: string }[] {
  return [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(env) },
    { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    // Browsers ignore HSTS over plain http, so local http://localhost is
    // unaffected; on an https deployment it pins https for a year.
    { key: 'Strict-Transport-Security', value: 'max-age=31536000; includeSubDomains' },
  ];
}
