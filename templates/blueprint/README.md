# __DISPLAY_NAME__

Generated from the **myAI Blueprint** — a production-grade Next.js 16 scaffold.

## Stack

- **Next.js 16** (App Router, Turbopack build+dev by default) + **TypeScript 6** (strict, `noUncheckedIndexedAccess`) — pinned to TS 6.x, not the new native 7.x compiler: `typescript-eslint` (the type-aware linter `eslint-config-next` pulls in) caps its `typescript` peer at `<6.1.0`, and TS 7.0 doesn't yet ship a stable programmatic API. Revisit once that lands (`AI/scripts/blueprint_freshness.sh` will flag it as `BEHIND` until then — a known, deliberate exception).
- **React 19**
- **Tailwind v4** (CSS-first `@theme`) + **shadcn/ui** (new-york, neutral)
- **MongoDB** (Mongoose) — local Docker `mongo:7`, Atlas in prod
- **Anthropic SDK** (`@anthropic-ai/sdk`) — `app/lib/anthropic.ts`
- **Sentry** (`@sentry/nextjs`) — browser + server + edge (no-op without DSN)
- **Vitest** + **@testing-library/react** (unit/integration) · **Playwright** (E2E)
- **ESLint 9** via the CLI directly (`eslint . --max-warnings 0`) — `next lint` was removed in Next 16. Pinned below npm-latest ESLint 10: `eslint-plugin-react` (pulled in by `eslint-config-next`) doesn't support it yet (`react/display-name` crashes) — another deliberate, documented exception, same as TypeScript above
- **Renovate** (`renovate.json`) — weekly grouped minor/patch PRs (patch auto-merges), one PR per major, targets `test`
- **4 GitHub Actions** — `ci`, `merge-gate`, `claude-review`, `copilot-review`
- **API docs** (CLAUDE.md rule 7) — OpenAPI 3.0 spec at `/api/openapi.json`, Scalar interactive docs at `/docs`, OpenAPI MCP server in `.mcp.json`

## Quickstart (Docker-only — no host `npm install`)

```bash
cp .env.example .env.local   # fill MONGODB_URI + ANTHROPIC_API_KEY
./dev                        # start app + mongo, follow logs → http://localhost:3000
```

Other `./dev` commands: `up`, `down`, `build`, `logs`, `shell`, `test`, `typecheck`, `lint`.

## Verify before pushing

```bash
./AI/scripts/local-ci.sh     # Docker tsc + tests + build (the CI-thrift gate)
```

Remote CI runs only on **PR → `main`** (CI-thrift policy). Push to `test`, verify locally, then PR to `main`.

Don't verify a production build with `docker compose exec app npm run build` / `./dev shell` + `npm run build` — that runs Turbopack against the bind-mounted dev container, a combination that can crash intermittently (`useContext` prerender error, unrelated to your code). `local-ci.sh` and `docker build --target build .` both build the same Dockerfile without a bind mount and are reliable — that's what CI/Vercel/Render actually run.

## Layout

```
app/
  layout.tsx, page.tsx, globals.css   ← App Router root + Tailwind v4 theme
  lib/        mongodb.ts, anthropic.ts, branding.ts, utils.ts, operator-auth.ts
  models/     Todo.ts                  ← demo Mongoose model
  api/        health/, todos/, auth/operator/, openapi.json/  ← health probe + demo CRUD + login + OpenAPI spec
  docs/       route.ts                 ← Scalar interactive API docs (reads api/openapi.json)
  login/      page.tsx                 ← single-operator sign-in
components/ui/ button.tsx              ← shadcn/ui (add more: npx shadcn add <c>)
proxy.ts                                ← control-plane gate (see below; Next 16 renamed middleware.ts)
tests/      unit/, e2e/
.github/workflows/  ci, merge-gate, claude-review, copilot-review
renovate.json                           ← weekly dependency-update PRs, target branch `test`
.mcp.json                               ← OpenAPI MCP server (AI agents can call endpoints from the spec)
```

## API docs (CLAUDE.md rule 7)

- `GET /api/openapi.json` — OpenAPI 3.0 spec, the single source of truth (`app/api/openapi.json/route.ts`)
- `GET /docs` — Scalar interactive docs, human-facing (`app/docs/route.ts`)
- `.mcp.json` — `openapi-mcp-server` reads the spec above and exposes each endpoint as an MCP tool for AI agents

Both routes are listed in `proxy.ts`'s `PUBLIC_PATHS` (same exemption as `/api/health`) so the contract stays reachable without an operator session. Add every new endpoint to the `paths` object in `app/api/openapi.json/route.ts` as you build it — undocumented endpoints are not considered complete.

## Operator login (control-plane gate)

Every route is gated by default — `proxy.ts` refuses anything not
explicitly listed in its `PUBLIC_PATHS` (health check, login, the API docs
pair above, and whatever marketing/analytics/signed-webhook routes you add)
until an operator session
is presented. With no `MYAI_ADMIN_USER` / `MYAI_ADMIN_PASSWORD_HASH` /
`MYAI_ADMIN_SESSION_SECRET` configured in `.env.local`, the gate **fails
closed**: nothing gets in, including the operator. Set those three vars (see
`.env.example` for the hash-generation one-liner) and sign in at `/login`.
Self-service signup is denied by default (`OPERATOR_DENY` in
`proxy.ts`) — only remove that if this app genuinely wants public
registration. `tests/e2e/public-surface-security.spec.ts` is the regression
guard; keep it in sync with `PUBLIC_PATHS` as routes are added.

## Perceived performance (skill: `web-perceived-performance`)

Shipped by default (layer 1 — a tap must land instantly):
- `app/loading.tsx` + `components/ui/screen-skeleton.tsx` — add a `loading.tsx` beside every page that fetches on the server.
- `components/ui/nav-link.tsx` — `<NavLink>`: press state plus a pending bar that appears only after 100 ms.

Opt-ins, when measurements call for them (see the skill for the exact recipe):
- **Server cache + warm (layer 2):** wrap slow upstream reads in `unstable_cache` (never store a failed read), then add `/api/warm` (Vercel cron with `CRON_SECRET`, or a startup self-warm from `instrumentation.ts` when self-hosted).
- **Idle prefetch / persisted client cache (layers 3–4):** only for screens that read on the client with React Query and whose data stays valid for minutes. Never persist live readings.

Measure first — per-page server time and `/api/*` timings in a logged-in browser against a production build.

## Hookups (Vercel · Atlas · Sentry)

See **`AI/documentation/BLUEPRINT_HOOKUP.md`** for the click-through, and
**`AI/documentation/BLUEPRINT_ORG_SETUP.md`** for one-time org-level setup
(branch protection, required checks, org secrets, template marker).

## Building with the AI framework

Run `agent mode` in this repo and describe the app you want — the project's
Claude runs Plan → BRD → Gap → TRD → Design → Build autonomously.
