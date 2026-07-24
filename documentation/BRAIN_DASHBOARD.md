# Brain in the myAI Dashboard — what's there + how it gets data on Vercel

> Answers the operator report: "if you use localhost you get access to brain, but in
> the myAI Vercel dashboard brain is currently not visible." The `/brain` page and its
> sidebar entry already ship (`b1c2d6a`, `a125b74`, `ad5189e`); this doc records the
> data-source decision so a Vercel/remote deployment can actually reach it, and gives
> the dashboard a self-explanatory empty state instead of a bare "unavailable" card.

## What's there today

- **Sidebar:** `/brain` lives in the collapsible **Brain & Memory** group alongside
  `/memory` and `/context` (`dashboard/src/lib/nav-groups.ts`).
- **Page:** `dashboard/src/app/brain/page.tsx` — five tabs: **Overview** (namespaces,
  branches, recent commits, hosted-brain quota), **Atoms** (session/handoff/memory
  atoms, newest first), **Search** (federated cross-repo-brain search), **Stashes**
  (frozen context payloads), **Provenance** (code↔memory `brain_blame` links).
- Read-only throughout — the view never checks out, merges, or writes to the brain.

## Data source decision

The brain is a **real git repo** at `~/.myai/brain` on whichever machine runs the
gateway — it already has its own remote and sync path (`brainSyncPush`/`brainSyncPull`
in `runtime/src/core/brain.ts`), unlike memory/registry/tasks, which live in Mongo and
needed the separate local-mirror work (`documentation/MONGO_MIRROR.md`). There is
nothing to mirror for brain — mirroring the git objects into Mongo would just be a
second, lossier copy of a store that's already portable as a git remote.

So the dashboard reads brain the same way every other gateway-backed page already
does — **no new plumbing**:

```
dashboard/src/views/brain.tsx
  → fetchBrainExplore()            (dashboard/src/lib/brain.ts)
    → callGateway('brain_explore') (dashboard/src/lib/gateway.ts)
      → POST {GATEWAY_MCP_URL}     jsonrpc tools/call, x-gateway-local-token header
        → runtime/src/core/brain.ts  brainExplore()  (reads the tenant's ~/.myai/brain)
```

This is the identical `callGateway` pattern used by `/fleet`, `/swarm`,
`/system` (routing), and `/status` — the architecture decision for "how does a
Next.js server component reach the gateway" was already made fleet-wide; brain just
follows it. The one dashboard-owned brain API route, `/api/brain/search`, exists only
because the **client-side** search box (`views/brain-search.tsx`) can't call the
gateway directly from a browser bundle — everything else in the brain view is a
server component calling the gateway server-side, same as its siblings.

**Auth:** `GATEWAY_LOCAL_TOKEN` is sent as `x-gateway-local-token` when the gateway
enforces tenancy (ADR-010); the gateway resolves the tenant server-side from that
token — the dashboard never passes a tenant id for the gateway to trust blindly.

**Synced-store alternative (multi-tenant / don't-want-to-expose-my-gateway case):**
ADR-017's hosted-brain remote is exactly the "synced store" option — a tenant-scoped
bare git repo *served by* the gateway itself. A tenant who provisions it gets their
brain visible from any dashboard deployment that can already reach that gateway, with
no tunnel and no extra dashboard plumbing (`HostedBrainCard` in `views/brain.tsx`
already surfaces its quota/CTA on the Overview tab).

## Why brain (and every other gateway page) goes dark on Vercel

`GATEWAY_MCP_URL` defaults to `http://gateway:3100/mcp` — a hostname that only
resolves inside a local `docker compose` network. A Vercel deployment left on that
default can never reach any gateway, so `brain_explore` (and `routing_config`, the
fleet/swarm calls, etc.) all return `null`. The brain page now says so explicitly
instead of a generic "unavailable" card (`GatewayDown()` in `views/brain.tsx` detects
the default URL and prints the fix).

**To make brain (and the rest of the gateway-backed pages) live on a remote
deployment**, set on that Vercel project:

| Env var | Value |
|---|---|
| `GATEWAY_MCP_URL` | A publicly reachable URL for the gateway's MCP endpoint (e.g. a tunnel — Cloudflare Tunnel / ngrok — in front of the operator's Docker gateway), ending in `/mcp` |
| `GATEWAY_LOCAL_TOKEN` | The same bridge token the gateway is configured with, if it enforces tenancy (ADR-010) |

Without a publicly reachable gateway, the only way brain data reaches a hosted
deployment is via the hosted-brain remote above (ADR-017) — self-hosting the gateway
stays the default; exposing it publicly or provisioning hosted-brain are both opt-in.

## Verifying

```bash
cd dashboard && npm run build   # or: docker compose -f ... build (dashboard image only)
```
Locally (gateway reachable at `localhost`/docker-compose), `/brain` renders live data.
With `GATEWAY_MCP_URL` unset (the Vercel-default case), `/brain` renders the
explanatory card above instead of a silent blank/generic error.
