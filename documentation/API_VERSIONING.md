# API Versioning & Deprecation Policy

> Applies to the gateway's public surfaces: the REST API (`/api/...`), the MCP
> tool surface (`/mcp`), and by extension anything the SDK or contract tests
> build against. Implementation: `runtime/src/core/api-version.ts` (REST shim +
> headers) and `runtime/src/mcp/handler.ts` (MCP handshake + `/mcp/v1` mount).

## Why

External consumers (SDKs, integrations, contract tests) need a stable contract
boundary. Without one, any breaking change to a route or tool schema silently
breaks callers. Versioning gives us a namespace to keep stable (`v1`), a place
to put breaking changes when they're ever needed (`v2`), and a documented,
machine-readable path for retiring anything (`Deprecation`/`Sunset` headers).

## The scheme

**Major-only, path-based, with a header for pinning and detection.**

| Surface | Versioned form | Legacy alias |
|---------|----------------|--------------|
| REST    | `/api/v1/<route>` (e.g. `/api/v1/agents`) | `/api/<route>` — frozen alias of v1 |
| MCP (HTTP) | `/mcp/v1` | `/mcp` — same router, same handlers |
| MCP handshake | `initialize` → `serverInfo.apiVersion: "1"` (also on `GET /mcp` discovery) | — |

- **`/api/v1/...` is a compatibility shim, not a route fork.** The middleware
  rewrites the versioned path to the canonical route before auth/routing, so
  both shapes share the exact same handlers, auth exemptions, and rate-limit
  buckets. There is no behavioural difference between them today.
- **Every `/api` response carries `X-API-Version`** (currently `1`).
- **Requests may pin a version** with the same `X-API-Version` header (`1` or
  `v1`). An unsupported pinned or path version returns
  `400 { code: "UNSUPPORTED_API_VERSION", supported, current, policy }` —
  never a silent fallback to a different major.
- **Minor/patch changes are not versioned in the path.** Additive changes
  (new routes, new optional fields, new tools) land inside the current major.

## What counts as a breaking change (requires a new major)

- Removing or renaming a route, tool, request field, or response field
- Changing a field's type or semantics
- Tightening validation so previously-valid requests fail
- Changing an error `code` that clients are told to branch on
- Changing auth requirements on an existing route

Not breaking (lands in the current major): new routes/tools, new optional
request fields, new response fields, new enum values where the spec says the
set may grow, bugfixes that make behaviour match the documented spec.

## Deprecation & sunset policy

1. **Announce.** A deprecated route/tool is registered in the gateway
   (`deprecateRoute()` in `api-version.ts`) and noted in `CHANGELOG.md` and the
   OpenAPI spec. From that moment its responses carry (RFC 8594):
   - `Deprecation: @<unix-epoch>` — when it was deprecated
   - `Sunset: <HTTP-date>` — when it stops being served
   - `Link: <this policy>; rel="sunset"` — optionally with the replacement route
2. **Window.** The sunset date is **at least 90 days** after the announcement
   for any route in the v1 namespace. A whole major version gets **at least
   180 days** of overlap after its successor ships.
3. **Remove.** After sunset the route returns `410 Gone` (major removal: the
   `/api/v<n>` prefix returns `400 UNSUPPORTED_API_VERSION`).

The **unversioned `/api` alias** follows the same policy: it is not deprecated
today, but if a v2 ever ships, the alias keeps meaning v1 until the alias
itself is deprecated with the full window above.

## Guidance for consumers

- **New integrations, the SDK, and contract tests must call `/api/v1/...`**
  and should assert `X-API-Version` in their contract tests.
- Existing callers of unversioned `/api/...` keep working unchanged.
- Watch for `Deprecation`/`Sunset` headers in responses — they are the
  machine-readable early warning.
- The OpenAPI document (`GET /api/openapi.json`) carries the same metadata
  under the root `x-api-versioning` extension.
