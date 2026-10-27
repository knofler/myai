---
name: web-perceived-performance
description: "Make a Next.js App Router app FEEL instant: measure first, then apply four layers cheapest-first — tap feedback (loading.tsx + press/pending link), server data cache + warm, idle prefetch, persisted client cache. Triggers: 'slow', 'feels slow', 'performance is bad', 'tap does nothing', 'loading', 'perceived performance', 'warm cache', 'prefetch', 'skeleton', 'loading.tsx'."
---

# Web Perceived-Performance Playbook (Next.js App Router)

Owner: `frontend-specialist`. Proven on two apps: a front-of-house kiosk app
(all four layers) and the **myAI dashboard** (layer 2 only, because that is all
the measurements asked for).

Each layer covers a different moment: **the tap → the first server read →
the first client read → the next visit.** Apply them in order and stop when
the numbers are good. Adding layers the measurements don't call for is cost
with no benefit.

## Step 0 — Measure before touching anything (mandatory)

Guessing is how the wrong layer gets built. Log in and measure in a real
browser (Playwright), against a production build (`next start` / standalone),
never `next dev`:

- **Server render per page:** `fetch(path)` from the logged-in page, twice
  (cold, warm). Anything > 300 ms warm is a candidate.
- **Client data per page:** load each page in an iframe, read
  `performance.getEntriesByType('resource')` for `/api/*`: count, slowest, and
  when the last one finished.
- **Isolate before blaming:** a route that is slow only when many requests are
  in flight is queueing behind something else. Re-time it alone.
- **Upstream timings:** if the app talks to a gateway with its own meter
  (myAI: `perf_stats` MCP tool), read p50/p95 per call — it tells you which
  reads to cache.

Record the table; it goes in the PR description as "before".

## Layer 1 — the tap lands instantly (tap feedback)

- Every route that fetches on the server has a `loading.tsx`. Without it Next
  keeps the old screen until the new one renders, and the tap feels dead.
- One shared `ScreenSkeleton` with the real screen's header/title so the swap
  is seamless.
- Press state on the `<Link>` itself: `active:scale-[0.97] active:bg-…` plus
  `motion-reduce:active:scale-100`. Keep it a real `<Link>`, not a button
  calling `router.push`.
- Pending bar: `useLinkStatus()` (next/link) in a child of the Link →
  `data-pending` → a CSS bar that appears only after **100 ms**, so a fast
  navigation shows nothing.
- Haptics are optional and never load-bearing (`navigator.vibrate(10)` on
  Android; iOS 18+ needs a hidden `<input type="checkbox" switch>` clicked
  inside a click handler).

## Layer 2 — nobody pays for the first server read (server cache + warm)

- Wrap slow upstream reads in `unstable_cache` (or `"use cache"`) with a TTL
  per resource. **SDK/axios clients and JSON-RPC POSTs bypass Next's fetch
  cache** — they must be wrapped; `fetch(..., { next: { revalidate } })` does
  nothing for a POST.
- **Never store a failure.** Throw inside the cached function on a failed or
  empty read and catch outside it. Returning a fallback (`null`, zeros) from
  inside caches the outage for the whole TTL.
- **Only cache what is the same for every viewer**, or put the viewer/tenant
  in the key. A read made with one fixed service identity is safe to share; a
  read made with the viewer's credentials is not — leave it uncached.
- `export const dynamic = 'force-dynamic'` makes `fetch` no-store for the
  page. Keep it where the page must run per request, and cache the DATA below
  it.
- Past the TTL Next serves the stale copy at once and refreshes behind it, so
  only a truly cold process pays. Fix that with a warm-up:
  - **`/api/warm`** calls each cached read **with exactly the args the screens
    use** (otherwise it fills entries nobody reads — write a test that pins
    them). One at a time when the reads share an upstream that serialises.
    Return per-read timings and 502 on a failed read. Use `await connection()`,
    not `force-dynamic`.
  - **Hosted on Vercel:** a cron (`vercel.json`, **UTC**) with `CRON_SECRET`
    (`Authorization: Bearer`). Crons are production-only.
  - **Self-hosted / Docker:** warm once at startup from `instrumentation.ts`
    (`register()` → `setTimeout` → fetch `127.0.0.1:$PORT/api/warm` with a
    per-process random token held on `globalThis`). No secret to configure.
  - The warm route authenticates itself, so it needs a carve-out in any auth
    middleware. It returns timings only, never data.
- Outside a Next request (unit tests, scripts) `unstable_cache` has no
  incremental cache: fall back to the live read rather than failing.
- Pages prerendered at build have no runtime secrets and can bake an empty
  state in: make those `force-dynamic` with the data cached beneath.

## Layer 3 — the first client read comes from memory (idle prefetch)

Only for screens that read on the CLIENT (React Query/SWR) and whose data stays
valid for minutes:

- On the landing screen, once idle, `queryClient.prefetchQuery(<the screen's
  own queryOptions>)` — the screen's own options fill the exact cache entry.
- `requestIdleCallback(fn, { timeout: 3000 })` with a `setTimeout(fn, 1500)`
  fallback (Safari has none). Compute date-dependent args on the client.

## Layer 4 — a reload draws instantly (persisted client cache)

Only when layer 3 exists and reloads are common (kiosks, PWAs):

- `PersistQueryClientProvider` + a small IndexedDB persister (~100 lines). IndexedDB, not localStorage
  (~5 MB cap, sync JSON on the main thread).
- Swallow every storage failure; throttle writes (~1 s); open/close per op.
- Allowlist via `shouldDehydrateQuery`: `status === 'success'` and slow data
  that is still right an hour later. **Never live readings** (counts, weather,
  queue depth) — a restored value would display as current.
- `maxAge` = `gcTime` (e.g. 24 h), short `staleTime` (60 s); bump `buster`
  when a persisted query's shape changes.

## Pitfalls that cost real time

- Measuring `next dev`: compile time swamps everything.
- A freshly restarted server is slow for a few requests (JIT); take the median
  of 6, not the first sample.
- A service worker must never cache `/api/*`.
- Adding React Query "for performance" when a server cache closes the gap —
  the myAI dashboard needed none of layers 3/4.

## Verify and ship

1. Unit tests: failure-not-cached, key-by-args, uncached tools bypass, warm
   args match the screens, warm route auth.
2. Rebuild the production image, restart it, and re-measure the SAME table —
   including the first hit after restart (proves the warm-up).
3. Browser check that the changed pages still render real data.
4. PR with the before/after table.

## Related
- `dev-caching-setup` — backend caching (Redis, HTTP caches, invalidation).
- `analysis-lighthouse` — lab metrics (LCP/CLS/INP) to pair with these timings.
