# Local Dev Quickstart (Contributors)

This is for someone building or fixing the framework itself — the gateway
(`runtime/`), the dashboard (`dashboard/`), the runner and brain scripts
(`scripts/`) — on their own machine. It is **not** the end-user "deploy your
own instance" guide (that's `selfhost/README.md`), though it uses the same
bundle under the hood. See `documentation/ARCHITECTURE_OVERVIEW.md` first if
you haven't already, for what each piece is.

> If you're working in a *managed-repo workspace clone* (this session's own
> setup is one), do **not** build/up/restart/down the root `docker-compose.yml`
> — that's the shared fleet stack, and a clone's `.env` is not real (see
> `CLAUDE.md` DEPLOY GUARD). Everything below uses `runtime/` or `selfhost/`
> standalone stacks instead, which are safe to run from anywhere.

## Prerequisites

- Docker Engine 24+ with the Compose v2 plugin. No host Node/npm required for
  gateway or dashboard work.
- `git`, `bash`, `python3` — for the shell test suites and helper scripts.
- A GitHub account if you're sending a PR.

## 1. Clone and branch

```bash
git clone https://github.com/knofler/ai_management.git
cd ai_management
git checkout main && git pull
git checkout -b test          # see CONTRIBUTING.md — branch NAME matters for CI
```

## 2. Bring up a stack

Pick based on what you're changing:

**Full stack (gateway + dashboard + Mongo wired together)** — use this if
your change touches how the dashboard and gateway talk to each other, or you
just want something to click around:

```bash
./selfhost/install.sh
# → http://localhost:3210 (dashboard), http://localhost:3200/health (gateway)
```

This builds both production Dockerfiles and generates a throwaway `.env`
under `selfhost/`. Re-run `./selfhost/install.sh` after code changes — it
rebuilds and restarts, keeping the data volume.

**Gateway only** — for backend/API/runner/brain work:

```bash
cd runtime
cp .env.example .env    # defaults are fine for local dev
docker compose up -d --build
curl http://localhost:3200/health
```

**Dashboard only, against a gateway you already have running** — point it at
either stack above:

```bash
cd dashboard
docker build -t myai-dashboard-dev .
docker run --rm -p 3210:3210 \
  -e MONGODB_URI=mongodb://admin:password@host.docker.internal:27200/myai?authSource=admin \
  -e GATEWAY_MCP_URL=http://host.docker.internal:3100/mcp \
  myai-dashboard-dev
```

## 3. Iterate on code

Both `runtime/Dockerfile` and `dashboard/Dockerfile` are multi-stage
production builds (no bind-mounted source, no watch mode) — there is no live
reload. The loop is: edit → rebuild the one service you touched → verify.

```bash
# gateway
docker compose -f runtime/docker-compose.yml up -d --build gateway

# dashboard (inside the selfhost or full-stack compose)
docker compose -f selfhost/docker-compose.yml up -d --build dashboard
```

## 4. Run tests before opening a PR

Everything here is Docker-only for the app code (`runtime/`, `dashboard/`)
per this repo's own policy — the `builder` stage of each Dockerfile has the
full `node_modules` (including dev deps), so run tests against that stage
rather than the slim production image:

```bash
# gateway unit tests (vitest)
docker build --target builder -t myai-gateway-builder ./runtime
docker run --rm myai-gateway-builder npm test

# gateway typecheck
docker run --rm myai-gateway-builder npm run lint    # tsc --noEmit

# dashboard unit tests (vitest)
docker build --target builder -t myai-dashboard-builder ./dashboard
docker run --rm myai-dashboard-builder npm test

# dashboard lint
docker run --rm myai-dashboard-builder npm run lint
```

Dashboard Playwright e2e (`dashboard/e2e/`) needs browser binaries and is
heavier — CI runs it on every PR to `main` (`.github/workflows/dashboard-e2e.yml`)
against an ephemeral `docker-compose.ci-e2e.yml` stack. Run it locally the
same way if you're touching a dashboard flow directly:

```bash
docker compose -f docker-compose.ci-e2e.yml build
docker compose -f docker-compose.ci-e2e.yml up -d --wait --wait-timeout 240
cd dashboard && npx playwright test   # inside a container with browsers, or CI
```

Shell/script-level tests are hermetic (git + python3 only, no Docker, no
network) and run directly on the host — they're not "app dependencies," so
the Docker-only policy doesn't apply to them:

```bash
bash scripts/tests/run_all.sh            # all scripts/tests/test_*.sh suites
bash selfhost/test.sh                    # selfhost bundle structure + compose lint
node scripts/build_docs.mjs              # docs site build (zero-dependency generator)
```

Finally, the one-shot check that mirrors what CI actually gates on:

```bash
bash scripts/local-ci.sh --dry-run
```

## 5. Tear down

```bash
./selfhost/install.sh --down             # stops, keeps the data volume
# or
docker compose -f runtime/docker-compose.yml down
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `docker compose up` fails with `MONGODB_URI is required` | You're pointed at the root `docker-compose.yml` (the shared/production compose file) — use `runtime/docker-compose.yml` or `selfhost/docker-compose.yml` instead, which have local defaults. |
| Gateway container healthy but dashboard 502s | `GATEWAY_MCP_URL` / `MONGODB_URI` mismatch between the two containers — they must point at the same Mongo and the gateway's actual reachable address. |
| Code change doesn't show up | You edited the source but didn't `--build` — Docker cached the old image layer. |
| `npm test` "command not found" inside the built image | You ran it against the final (production) image, not `--target builder`. |

Full end-user deploy details (env reference, backup, TLS, Kubernetes/Helm):
`selfhost/README.md`. Standalone gateway API/CLI reference: `runtime/README.md`.
