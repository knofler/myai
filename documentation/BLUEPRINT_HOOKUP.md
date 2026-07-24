# Blueprint Hookup — Vercel · Atlas · Sentry · Anthropic

> Per-project click-through to take a repo scaffolded by `init blueprint` from
> local Docker dev to a deployed, monitored production app. Org-level one-time
> setup (branch protection, org secrets, template marker) lives in
> **`BLUEPRINT_ORG_SETUP.md`** — do that once per org, then this per project.

A freshly scaffolded blueprint repo runs entirely offline in Docker with no
external accounts. Everything below is **optional** and wires real services in.
Each integration degrades gracefully when its env var is unset (Sentry no-ops,
Anthropic throws only when called, Mongo points at the local container).

---

## 0. Local first (no accounts needed)

```bash
cd <your-app>
cp .env.example .env.local          # the only required edit: nothing, for local
./dev                                # app + mongo in Docker → http://localhost:3000
./AI/scripts/local-ci.sh             # Docker tsc + tests + build (the CI-thrift gate)
```

`MONGODB_URI` in `.env.example` already points at the local `mongo:7` container.
Add `ANTHROPIC_API_KEY` only when you start making AI calls.

---

## 1. MongoDB Atlas (production database)

1. Atlas → **Create** → shared/free `M0` (or dedicated for prod) cluster.
2. **Database Access** → add a user (username + strong password).
3. **Network Access** → allow Vercel egress: add `0.0.0.0/0` (or Vercel's IP
   ranges for stricter setups).
4. **Connect → Drivers** → copy the `mongodb+srv://…` connection string.
5. Append the database name before the `?`:
   `mongodb+srv://user:pass@cluster.xxxx.mongodb.net/<your-app>?retryWrites=true&w=majority`
6. This becomes the `MONGODB_URI` env var in Vercel (step 3 below).

The blueprint's `app/lib/mongodb.ts` caches the connection across serverless
invocations — no extra config needed.

---

## 2. Sentry (error monitoring)

1. Sentry → **Create Project** → platform **Next.js** → note the project + org slug.
2. Copy the **DSN** (Settings → Client Keys).
3. Settings → **Auth Tokens** → create a token with `project:releases` +
   `org:read` scope (for source-map upload during build).
4. Env vars (local in `.env.local`, prod in Vercel):
   | Var | Where | Purpose |
   |---|---|---|
   | `NEXT_PUBLIC_SENTRY_DSN` | client + server | error reporting |
   | `SENTRY_DSN` | server (optional, falls back to public) | server errors |
   | `SENTRY_AUTH_TOKEN` | build only | source-map upload |
   | `SENTRY_ORG` / `SENTRY_PROJECT` | build only | release association |

Wiring already lives in `sentry.client.config.ts`, `sentry.server.config.ts`,
`sentry.edge.config.ts`, `instrumentation.ts`, and the `withSentryConfig` wrap in
`next.config.ts`. With no DSN set, all of it is a no-op.

> Shortcut: the master repo's `scripts/setup_sentry.sh --vercel` can push a
> personal DSN into a Vercel project's env for you.

---

## 3. Vercel (hosting + preview/prod deploys)

1. Vercel → **Add New → Project** → **Import Git Repository** → pick your repo.
   - Or CLI: `vercel link` then `vercel deploy`.
2. **Framework Preset:** Next.js (auto-detected).
3. **Environment Variables** — add for *Production* (and *Preview* if needed):
   - `MONGODB_URI` (from step 1)
   - `ANTHROPIC_API_KEY`
   - `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`
4. **Deploy.**

The scaffold's `vercel.json` enforces the **CI/Vercel thrift policy**: deploys
fire **only on `main`** (`deploymentEnabled: { main: true, test: false }`), so
pushes to `test`/`codeclot` do **not** burn preview builds. Production ships when
a PR merges to `main`.

> Powerhouse Enterprise team has SSO/Deployment Protection on by default, which
> makes preview URLs unviewable. For test/sandbox apps deploy to the **personal**
> scope (`knoflers-projects`); `init_blueprint.sh --vercel` already defaults there.

---

## 4. Anthropic (AI calls)

1. console.anthropic.com → **API Keys** → create key (`sk-ant-…`).
2. Set `ANTHROPIC_API_KEY` locally (`.env.local`) and in Vercel.
3. Use the shared client in `app/lib/anthropic.ts`:
   ```ts
   import { complete } from "@/app/lib/anthropic";
   const answer = await complete("Summarise this in one line: …");
   ```
   Default model is `claude-sonnet-4-6`; override per call. For the most capable
   model use `claude-opus-4-8`.

> **Cost pool:** interactive `claude` CLI work draws on the **subscription**.
> Programmatic/scheduled agents (`claude -p`, standing agents, the
> `claude-review.yml` workflow) should draw on the **Agent SDK credit pool** —
> see `plan/POWERHOUSE_BLUEPRINT.md` §4.

---

## 5. GitHub (CI + AI review)

The scaffold ships 4 workflows in `.github/workflows/`:

| Workflow | Trigger | Needs |
|---|---|---|
| `ci.yml` | PR → main, manual | nothing (uses ephemeral mongo service) |
| `merge-gate.yml` | PR → main | nothing (enforces source = `test`/`hotfix`) |
| `claude-review.yml` | PR open/sync | repo/org secret `ANTHROPIC_API_KEY` (skips cleanly if absent) |
| `copilot-review.yml` | PR open | Copilot code review enabled for the repo/org |

Branch protection + required checks + org secrets are configured **once per org**
— see `BLUEPRINT_ORG_SETUP.md`.

---

## 6. Checklist

- [ ] `./dev` runs locally, `/api/health` returns `{ "status": "ok" }`
- [ ] `./AI/scripts/local-ci.sh` passes (tsc + tests + build)
- [ ] Atlas cluster created, `MONGODB_URI` ready
- [ ] Sentry project created, DSN + auth token ready
- [ ] Anthropic key ready
- [ ] Vercel project imported, env vars set, first `main` deploy green
- [ ] GitHub branch protection + required checks (org setup) in place
