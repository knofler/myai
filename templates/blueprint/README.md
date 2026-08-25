# __DISPLAY_NAME__

Generated from the **Powerhouse Blueprint** — a production-grade Next.js 15 scaffold.

## Stack

- **Next.js 15** (App Router) + **TypeScript** (strict, `noUncheckedIndexedAccess`)
- **Tailwind v4** + **shadcn/ui** (new-york, neutral)
- **MongoDB** (Mongoose) — local Docker `mongo:7`, Atlas in prod
- **Anthropic SDK** (`@anthropic-ai/sdk`) — `app/lib/anthropic.ts`
- **Sentry** (`@sentry/nextjs`) — browser + server + edge (no-op without DSN)
- **Vitest** + **@testing-library/react** (unit/integration) · **Playwright** (E2E)
- **4 GitHub Actions** — `ci`, `merge-gate`, `claude-review`, `copilot-review`

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

## Layout

```
app/
  layout.tsx, page.tsx, globals.css   ← App Router root + Tailwind v4 theme
  lib/        mongodb.ts, anthropic.ts, branding.ts, utils.ts, operator-auth.ts
  models/     Todo.ts                  ← demo Mongoose model
  api/        health/, todos/, auth/operator/  ← health probe + demo CRUD + login
  login/      page.tsx                 ← single-operator sign-in
components/ui/ button.tsx              ← shadcn/ui (add more: npx shadcn add <c>)
middleware.ts                          ← control-plane gate (see below)
tests/      unit/, e2e/
.github/workflows/  ci, merge-gate, claude-review, copilot-review
```

## Operator login (control-plane gate)

Every route is gated by default — `middleware.ts` refuses anything not
explicitly listed in its `PUBLIC_PATHS` (health check, login, and whatever
marketing/analytics/signed-webhook routes you add) until an operator session
is presented. With no `MYAI_ADMIN_USER` / `MYAI_ADMIN_PASSWORD_HASH` /
`MYAI_ADMIN_SESSION_SECRET` configured in `.env.local`, the gate **fails
closed**: nothing gets in, including the operator. Set those three vars (see
`.env.example` for the hash-generation one-liner) and sign in at `/login`.
Self-service signup is denied by default (`OPERATOR_DENY` in
`middleware.ts`) — only remove that if this app genuinely wants public
registration. `tests/e2e/public-surface-security.spec.ts` is the regression
guard; keep it in sync with `PUBLIC_PATHS` as routes are added.

## Hookups (Vercel · Atlas · Sentry)

See **`AI/documentation/BLUEPRINT_HOOKUP.md`** for the click-through, and
**`AI/documentation/BLUEPRINT_ORG_SETUP.md`** for one-time org-level setup
(branch protection, required checks, org secrets, template marker).

## Building with the AI framework

Run `agent mode` in this repo and describe the app you want — the project's
Claude runs Plan → BRD → Gap → TRD → Design → Build autonomously.
