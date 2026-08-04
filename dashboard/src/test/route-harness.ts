// Shared helpers for testing Next.js App Router route handlers (the /api/**
// route.ts files) directly, without booting the Next server. A route handler
// is just `(req: Request) => Promise<Response>`, so these build plain
// `Request`s and stub `global.fetch` to stand in for the myai gateway the
// proxy routes call out to.
import { vi } from 'vitest';

type ReqInit = { method?: string; body?: unknown; headers?: Record<string, string> };

function buildHeaders(init: ReqInit | undefined, extra?: Record<string, string>): Record<string, string> {
  return {
    ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}),
    ...extra,
    ...init?.headers,
  };
}

// A Request with a body can't use GET/HEAD (the Fetch spec throws) — a body
// implies a mutating call, so default to POST unless the caller overrides it.
function methodFor(init: ReqInit | undefined): string {
  return init?.method ?? (init?.body !== undefined ? 'POST' : 'GET');
}

/** Build a Request carrying the `myai_token` session cookie the jwt-proxy
 *  routes (src/lib/jwt-proxy.ts) read via `jwtFromCookies`. */
export function requestWithSessionCookie(url: string, jwt: string, init?: ReqInit): Request {
  return new Request(url, {
    method: methodFor(init),
    headers: buildHeaders(init, { cookie: `myai_token=${encodeURIComponent(jwt)}` }),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Build a Request with no session cookie and no Authorization header — the
 *  "unauthenticated caller" case every proxy route must 401 on. */
export function requestPlain(url: string, init?: ReqInit): Request {
  return new Request(url, {
    method: methodFor(init),
    headers: buildHeaders(init),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Build a Request carrying a raw `Authorization: Bearer <key>` header — the
 *  tenant-API-key routes (src/lib/tenant-auth.ts `keyFromRequest`) read this. */
export function requestWithApiKey(url: string, apiKey: string, init?: ReqInit): Request {
  return new Request(url, {
    method: methodFor(init),
    headers: buildHeaders(init, { authorization: `Bearer ${apiKey}` }),
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
}

/** Stub global.fetch to resolve once with a given status/JSON body (the mocked
 *  gateway response). Returns the mock so callers can assert call args
 *  (headers forwarded, method, body). Caller must `vi.unstubAllGlobals()` in
 *  afterEach. */
export function stubFetchOnce(status: number, body: unknown): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValueOnce({
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as Response);
  vi.stubGlobal('fetch', mock);
  return mock;
}

/** Stub global.fetch to reject once (simulating a gateway-unreachable / network
 *  error), exercising the route's catch-block error mapping. */
export function stubFetchRejectOnce(err: unknown = new Error('fetch failed')): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockRejectedValueOnce(err);
  vi.stubGlobal('fetch', mock);
  return mock;
}
