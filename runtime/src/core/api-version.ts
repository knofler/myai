/**
 * REST API versioning — the /api/v1 namespace, version negotiation header,
 * and the deprecation/sunset header machinery behind the documented policy
 * (documentation/API_VERSIONING.md).
 *
 * Design: routes stay registered once on their canonical unversioned paths
 * (`/api/...`) in core/server.ts. This middleware rewrites an explicit
 * `/api/v1/...` request to the canonical path before auth/routing, so both
 * shapes hit the exact same handlers, exemption sets, and rate-limit buckets
 * (a compatibility shim, not a route fork). Every /api response is stamped
 * with `X-API-Version` so clients can pin and detect the contract they got.
 *
 * Unversioned `/api/...` is a frozen alias of v1 for existing integrations.
 * New consumers (SDKs, contract tests) should call `/api/v1/...` — when a v2
 * ever ships, the alias keeps meaning v1 until its own sunset per the policy.
 */

import type { Request, Response, NextFunction } from 'express';

// Augment Express Request with the negotiated API version.
declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiVersion?: string;
    }
  }
}

/** The current (and only) major version of the gateway REST/MCP tool surface. */
export const GATEWAY_API_VERSION = '1';

/** Majors this gateway build can serve. */
export const SUPPORTED_API_VERSIONS: readonly string[] = [GATEWAY_API_VERSION];

/** Response header carrying the version that served the request; also accepted
 * as a request header for explicit pinning (`1` or `v1`). */
export const API_VERSION_HEADER = 'X-API-Version';

/** Where the versioning + deprecation policy is documented. */
export const API_VERSIONING_DOC_URL =
  'https://github.com/knofler/myai/blob/main/documentation/API_VERSIONING.md';

/** `/api/v<major>` prefix — major only (no minor in the path, per policy). */
const VERSIONED_PATH = /^\/api\/v(\d+)(?=\/|\?|$)/;

interface RouteDeprecation {
  /** ISO date the deprecation was announced (Deprecation header value). */
  deprecatedAt: string;
  /** ISO date the route stops being served (Sunset header value). */
  sunsetAt: string;
  /** Replacement route or migration note surfaced in the Link header title. */
  replacement?: string;
}

// Canonical-path prefix → deprecation record. Empty today; populated when a
// route enters the deprecation window so clients get machine-readable
// Deprecation/Sunset/Link headers (RFC 8594) ahead of removal.
const deprecatedRoutes = new Map<string, RouteDeprecation>();

/** Register a route (canonical `/api/...` path prefix) as deprecated. */
export function deprecateRoute(pathPrefix: string, info: RouteDeprecation): void {
  deprecatedRoutes.set(pathPrefix, info);
}

/** Test hook — reset the deprecation registry. */
export function clearDeprecatedRoutes(): void {
  deprecatedRoutes.clear();
}

function unsupportedVersion(res: Response, requested: string): void {
  res.status(400).json({
    error: `Unsupported API version '${requested}'. Supported: ${SUPPORTED_API_VERSIONS.map(v => `v${v}`).join(', ')}.`,
    code: 'UNSUPPORTED_API_VERSION',
    supported: SUPPORTED_API_VERSIONS.map(v => `v${v}`),
    current: `v${GATEWAY_API_VERSION}`,
    policy: API_VERSIONING_DOC_URL,
  });
}

/**
 * Express middleware. Mount before auth/routes (see applyMiddleware step 3d):
 *  - `/api/v1/x` → rewritten to `/api/x` (query string preserved)
 *  - `/api/v9/x` or `X-API-Version: 9` → 400 UNSUPPORTED_API_VERSION
 *  - unversioned `/api/x` → served as v1 (legacy alias)
 *  - every /api response carries `X-API-Version`
 *  - routes in the deprecation registry additionally carry
 *    `Deprecation`, `Sunset`, and `Link rel="sunset"` headers (RFC 8594)
 */
export function apiVersioning() {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.url.startsWith('/api')) {
      next();
      return;
    }

    // Header pinning — accept '1' or 'v1'; reject anything this build can't serve.
    const pinned = req.header(API_VERSION_HEADER)?.trim();
    if (pinned) {
      const normalized = pinned.replace(/^v/i, '');
      if (!SUPPORTED_API_VERSIONS.includes(normalized)) {
        unsupportedVersion(res, pinned);
        return;
      }
    }

    const match = VERSIONED_PATH.exec(req.path);
    if (match) {
      if (!SUPPORTED_API_VERSIONS.includes(match[1])) {
        unsupportedVersion(res, `v${match[1]}`);
        return;
      }
      // Compatibility shim: strip the version segment so the request lands on
      // the canonical route. originalUrl keeps the as-requested path for logs.
      const rest = req.url.slice(`/api/v${match[1]}`.length);
      req.url = `/api${rest.startsWith('/') || rest.startsWith('?') || rest === '' ? rest : `/${rest}`}`;
      req.apiVersion = match[1];
    } else {
      req.apiVersion = GATEWAY_API_VERSION;
    }

    res.setHeader(API_VERSION_HEADER, req.apiVersion);

    for (const [prefix, info] of deprecatedRoutes) {
      if (req.path === prefix || req.path.startsWith(`${prefix}/`)) {
        res.setHeader('Deprecation', `@${Math.floor(Date.parse(info.deprecatedAt) / 1000)}`);
        res.setHeader('Sunset', new Date(info.sunsetAt).toUTCString());
        const title = info.replacement ? `; title="use ${info.replacement}"` : '';
        res.setHeader('Link', `<${API_VERSIONING_DOC_URL}>; rel="sunset"${title}`);
        break;
      }
    }

    next();
  };
}
