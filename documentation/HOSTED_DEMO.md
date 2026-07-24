# Hosted Read-Only Demo — setup runbook

> GO_LIVE_PLAN P2 item 14: a demo tenant on Vercel so launch visitors can
> click around the dashboard before installing. The demo is the SAME dashboard
> codebase — no fork, no branch — switched into read-only mode by one env var.

## What demo mode does

Set `NEXT_PUBLIC_DEMO_MODE=true` at build time and the dashboard becomes a
read-only showroom (see `dashboard/src/lib/demo.ts`):

| Layer | Behavior |
|---|---|
| `src/middleware.ts` | Every mutating request (non-GET/HEAD/OPTIONS) → `403 {"error": "read-only demo…"}`. Single choke point — all dashboard writes are fetch calls to `/api/*`. `/api/sessions/search` (a POST-shaped read) stays allowed. Loopback is NOT exempt — the gate protects the shared demo database, not the visitor. |
| `src/lib/tenant.ts` | Active tenant pinned to the default tenant; the `myai_tenant` cookie is ignored, so the tenant switcher can't point the UI anywhere else. |
| `src/app/layout.tsx` | `<DemoBanner />` — fixed bottom banner: "Read-only demo … Install myAI →" (CTA URL overridable via `NEXT_PUBLIC_DEMO_INSTALL_URL`). |

Local dev and the real hosted dashboard leave the flag unset — everything
compiles away to a no-op.

## Creating the demo Vercel project

The demo is a **second Vercel project** on the same repo (the existing hosted
dashboard project keeps its own env). One-time setup in the Vercel UI:

1. **New project** → import `knofler/ai_management`, name it `myai-demo`.
2. **Root Directory:** `dashboard` (framework preset: Next.js).
3. **Environment variables (Production):**
   - `NEXT_PUBLIC_DEMO_MODE=true`
   - `MONGODB_URI=<demo Atlas connection string>` — a **dedicated demo
     database** (e.g. a `myai-demo` database on the existing Atlas cluster, or
     a free-tier cluster). NEVER the production/fleet database: demo mode
     pins the tenant, but the real isolation is that this database only ever
     contains seeded demo data.
   - `REQUIRE_LOGIN` — leave **unset**. Visitors must land straight on the
     dashboard, no login wall.
   - `NEXT_PUBLIC_DEMO_INSTALL_URL` — optional CTA override (defaults to the
     GitHub repo README).
4. **Deploy gate (CI/Vercel Thrift Policy):** `dashboard/vercel.json` is
   committed with `git.deploymentEnabled` main-only + the `ignoreCommand`
   ref check — pushes to `test`/`codeclot` build **nothing**; the demo (and
   the hosted dashboard) deploy only on merge to `main`. Do not weaken this.

## Seeding the demo tenant

The seeded data is what makes the demo alive instead of a wall of empty
panels. Reuse the existing demo seeder against the demo database:

```bash
# From a machine with the gateway stack available, point a throwaway gateway
# at the demo Atlas database, then:
MONGODB_URI='<demo Atlas connection string>' docker compose up -d gateway
scripts/myai_demo.sh --force      # 6 tasks, 2 disabled schedules, 1 plan,
                                  # 3 repo cards, 3 memory vectors, 8 budget rows
docker compose down gateway       # demo data persists in Atlas
```

Notes:
- All seeded rows are namespaced `demo` / `demo-*` — `scripts/myai_demo.sh
  --clean` removes them; `--force` re-seeds fresh.
- Seed rows land on the default tenant, which is exactly the tenant demo mode
  pins to — no extra tenant plumbing needed.
- Re-run `--force` periodically (or after schema changes) so the demo stays
  representative. Timestamps in budget rows are relative to seed time.
- ⚠ Run the seed from the MASTER checkout with an explicit `MONGODB_URI` —
  never rebuild the shared myai gateway stack from a workspace clone (deploy
  guard, LL 2026-07-04).

## Verifying the demo

After the first `main` deploy:

1. Open the demo URL — the amber "Read-only demo" banner must be visible and
   pages (`/work`, `/apps`, `/registry`, `/memory`, `/system`, `/fleet`) show
   seeded data.
2. `curl -X POST https://<demo-url>/api/auth/signup -d '{}'` → expect `403`
   with the read-only error.
3. Tenant switcher must have no effect (tenant pinned).
