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
  lib/        mongodb.ts, anthropic.ts, branding.ts, utils.ts
  models/     Todo.ts                  ← demo Mongoose model
  api/        health/, todos/          ← health probe + demo CRUD
components/ui/ button.tsx              ← shadcn/ui (add more: npx shadcn add <c>)
tests/      unit/, e2e/
.github/workflows/  ci, merge-gate, claude-review, copilot-review
```

## Hookups (Vercel · Atlas · Sentry)

See **`AI/documentation/BLUEPRINT_HOOKUP.md`** for the click-through, and
**`AI/documentation/BLUEPRINT_ORG_SETUP.md`** for one-time org-level setup
(branch protection, required checks, org secrets, template marker).

## Building with the AI framework

Run `agent mode` in this repo and describe the app you want — the project's
Claude runs Plan → BRD → Gap → TRD → Design → Build autonomously.
