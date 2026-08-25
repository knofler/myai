# Gateway k6 Load Test

A repeatable [k6](https://k6.io/) load test for the myAI gateway's two
hottest MCP paths:

- **`tasks_claim`** — the after-hours runner's poll loop (`AI/scripts/*runner*`
  hammers this constantly).
- **`context_boot`** — the cold-start bundle every agent session fetches on
  boot (`agent mode` / `agent mode -min`).

It hits the real JSON-RPC surface (`POST /mcp`, `tools/call`) with tenant
fan-out across several seeded tenants, captures p50/p95/p99 per tool via k6's
built-in `http_req_duration` metric, and asserts each against a budget as a k6
**threshold** — a regression fails the run (nonzero exit), it isn't just a
number printed to a log.

Files:

| Path | Purpose |
|------|---------|
| `runtime/loadtest/k6/gateway-hotpaths.js` | The k6 script (scenarios, tags, thresholds) |
| `runtime/loadtest/seed-tenants.sh` | Signs up N throwaway tenants, writes their `{tenantId, apiKey}` pairs |
| `docker-compose.ci-loadtest.yml` | Ephemeral, fully isolated gateway + mongo + k6 stack |
| `scripts/run_k6_loadtest.sh` | One-command orchestration: build → up → seed → run → teardown |
| `.github/workflows/k6-load-test.yml` | Optional, manual-only CI job |

## Isolation (read before running)

`docker-compose.ci-loadtest.yml` stands up its **own** `mongo-loadtest` +
`gateway-loadtest` containers on a dedicated network (`myai-ci-loadtest-net`,
project name `myai-ci-loadtest`) — distinct from the shared, always-on
`myai-gateway` / `myai-mongo` stack. It is brought up and torn down per run.
This is the same pattern `docker-compose.ci-e2e.yml` uses for the dashboard
E2E suite. **Never** point this test at the shared dev gateway (`:3100`) —
per CLAUDE.md's DEPLOY GUARD, that stack's lifecycle is managed only from the
master checkout, and hammering it with load-test traffic would pollute the
real fleet's task queue and tenant data.

The gateway's per-tenant burst rate limiter (`tenant-quota.ts`, free plan
defaults to 60 req/min) is disabled on this stack
(`TENANT_QUOTA_DISABLED=1`) — the test measures handler/DB latency under
concurrency, not the quota limiter. `AUTH_SIGNUP_MAX` is also raised so
seeding several tenants back-to-back doesn't 429.

## Run it locally

Requires Docker only (no local `k6` binary, no local `npm`/`node` — the
Docker-only development rule holds; k6 runs as a container).

```bash
./scripts/run_k6_loadtest.sh [tenant_count] [vus] [duration]

# e.g. 10 tenants, 20 VUs per scenario (tasks_claim + context_boot each), 1 minute
./scripts/run_k6_loadtest.sh 10 20 1m
```

Defaults: `tenant_count=5`, `vus=20`, `duration=30s`. Each scenario
(`tasks_claim`, `context_boot`) gets its own pool of `vus` virtual users
running for `duration`, so total concurrent load is roughly `2 * vus`.

The script builds the gateway image, brings the stack up and waits for
health, seeds tenants via `POST /api/auth/signup`, runs k6 in a container
against the internal network, prints k6's summary (checks, thresholds,
percentiles), and always tears the stack down — even on failure, after
dumping the gateway's logs for diagnosis.

Exit code is k6's: `0` = every threshold passed, `99` = a threshold was
breached (k6's standard "thresholds failed" exit code).

## Budgets

Defaults mirror the gateway's own live SLO alerter
(`runtime/src/monitoring/slo-alerter.ts`, `MYAI_SLO_P95_MS=2000`) so a
load-test failure here and a production SLO breach alert point at the same
bar. Override per run via env vars (forwarded straight to the k6 script):

| Env var | Default | Meaning |
|---|---|---|
| `LOADTEST_P95_TASKS_CLAIM_MS` | 2000 | p95 budget for `tasks_claim` |
| `LOADTEST_P99_TASKS_CLAIM_MS` | 3000 | p99 budget for `tasks_claim` |
| `LOADTEST_P95_CONTEXT_BOOT_MS` | 2000 | p95 budget for `context_boot` |
| `LOADTEST_P99_CONTEXT_BOOT_MS` | 3000 | p99 budget for `context_boot` |
| `LOADTEST_ERROR_RATE_BUDGET` | 0.05 | max `http_req_failed` rate per tool (5%) |

```bash
LOADTEST_P95_TASKS_CLAIM_MS=300 LOADTEST_P95_CONTEXT_BOOT_MS=500 \
  ./scripts/run_k6_loadtest.sh 10 30 1m
```

The 2000ms defaults are a broad safety net inherited from the alerter, not a
target — once you have a real baseline for your hardware, tighten these
(e.g. to a few hundred ms) so the test actually catches regressions instead
of only catastrophic ones. Don't hardcode a tightened value into the script;
override via the env vars above (in CI, via the workflow's manual inputs, or
a stricter wrapper invocation) so the budget stays visible at the call site.

## Run it in CI

`.github/workflows/k6-load-test.yml` is `workflow_dispatch`-only (per the
fleet CI/Vercel Thrift Policy — no `pull_request`/`push` trigger, so it never
taxes ordinary PRs). Trigger it manually from the Actions tab, or:

```bash
gh workflow run k6-load-test.yml -f tenant_count=10 -f vus=20 -f duration=1m
```

Run it before a release that touches `runtime/src/mcp/tools.ts`
(`handleTasksClaim`/`handleContextBoot`), `runtime/src/core/auth.ts`, or
`runtime/src/core/tenant-quota.ts`, or after any change to the fleet runner's
poll cadence. It is intentionally **not** a required PR check: CI-hosted
runners have noisy-neighbour CPU/network that makes absolute latency numbers
indicative rather than authoritative run-to-run, which would make it a flaky
merge gate. Treat a CI failure as "go investigate," not "the PR is broken."

## Extending

To add another hot path, add a new k6 scenario + `exec` function in
`gateway-hotpaths.js` (tag its `http.post` call with `{ tool: '<tool_name>' }`
and add matching `http_req_duration{tool:<tool_name>}` /
`http_req_failed{tool:<tool_name>}` thresholds), following the existing
`claimTasks`/`bootContext` pattern.
