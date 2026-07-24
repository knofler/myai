# Architecture Overview (Contributor Guide)

This is a code-oriented map of the framework for people building or debugging
it — where each concept lives on disk, and how the pieces talk to each other.
For the end-user/conceptual explanation (continuity model, memory tiers,
budgets, fleet), see `docs/concepts.md` on the docs site — this doc exists so
a contributor can find the right directory in one pass instead of reading
that narrative first.

## The four pieces

```
                 ┌──────────────┐        MCP (stdio/HTTP)      ┌─────────────┐
                 │  Claude Code │ ───────────────────────────▶ │   gateway   │
                 │ / any MCP    │ ◀─────────────────────────── │ (runtime/)  │
                 │   agent      │       tool calls + results   │ :3100 MCP   │
                 └──────────────┘                               │ :3200 HTTP  │
                                                                  │ :3201 WS   │
                        ▲                                        └──────┬──────┘
                        │ headless session, one queued task at a time    │
                        │                                                │ reads/writes
                 ┌──────┴───────┐         HTTP + MCP over the            ▼
                 │    runner    │         Docker bridge           ┌─────────────┐
                 │ (scripts/*)  │ ◀──────────────────────────────│   MongoDB   │
                 └──────────────┘                                 │ (or Atlas)  │
                                                                  └──────┬──────┘
                 ┌──────────────┐         HTTP + MCP                    │
                 │  dashboard   │ ◀──────────────────────────────────────┘
                 │ (dashboard/) │  reads task queue, state, budget, brain
                 │ :3210        │
                 └──────────────┘
                        ▲
                        │ git (branches = sessions, merge = wrap-up)
                 ┌──────┴───────┐
                 │    brain     │
                 │ (git repo,   │
                 │ scripts/*)   │
                 └──────────────┘
```

### Gateway — `runtime/`

The gateway is the only stateful service. It's a Node/TypeScript daemon
(`runtime/src/core/` bootstraps it) that exposes:

- **MCP** on `:3100` — the tool surface agents connect to (`myai connect-agent`
  wires Claude Code/Cursor/Codex to it). Tool definitions live in
  `runtime/src/mcp/tools.ts`.
- **HTTP API** on `:3200` — session/agent/skill CRUD, task queue, budget,
  brain endpoints. See `runtime/README.md` for the endpoint table.
- **WebSocket** on `:3201` — typed session protocol for the dashboard's live
  views (log relay, task streaming).

Domain code is split by concern under `runtime/src/`: `agents/` (agent+skill
loader), `tasks/` (task store, priority aging, runner lease/heartbeat,
preemption), `scheduler/` (morning/evening sweeps, dispatch worker, quota
reset), `memory/` + `core/brain*.ts` (brain plumbing), `mcp/` (tool
definitions + context-bundle assembly), `webhooks/`, `channels/`,
`marketplace/`, `analytics/`, `rules/` (RBAC), `repos/` (multi-repo registry).
State (tasks, sessions, budget, tenants) persists to MongoDB — bundled Mongo
for self-host, Atlas for the shared fleet deployment (ADR-011).

### Dashboard — `dashboard/`

A Next.js 15 app (App Router, `dashboard/src/app/`) — the operator console at
`:3210`. It talks to the gateway over HTTP and MCP (`GATEWAY_MCP_URL`), never
touches Mongo directly except for a few read paths that share the gateway's
Mongoose models. Key surfaces: `/schedule` (task queue), `/fleet` (cross-repo
morning sweep), `/directory` (app cards), `/analytics` (budget + cold-start
savings), `/documentation` and `/showcase` (render markdown straight off the
`AI_ROOT` bind mount — this is why both gateway and dashboard mount the repo
root read-only in `docker-compose.yml`).

### Runner — `scripts/cli_task_runner.sh` + `scripts/myai_runner.sh`

The runner is not a service — it's a scheduled script (launchd on macOS via
`scripts/setup_cli_runner_schedule.sh`, systemd/cron on Linux via
`scripts/setup_cli_runner_linux.sh`, Task Scheduler on Windows via
`scripts/setup_cli_runner_windows.ps1`). Each tick it:

1. Claims the highest-priority pending task from the gateway's task queue
   (atomic claim + lease, `runner-lease-store.ts` / `runner-heartbeat-store.ts`
   on the gateway side — this is what makes a multi-machine runner safe,
   ADR-011).
2. Opens a headless Claude Code session in the target repo's worktree, on the
   `test` branch (never `main`).
3. Flips the task to `review` on completion (or `blocked`/skips past poison
   tasks — see `LL/2026-06-23-runner-headofline-block-unresolvable-task.md`).

`scripts/runner_health.sh` and `scripts/runner_log_rotate.sh` are its
maintenance scripts; `config/runner_budget.conf` gates cost-aware dispatch
(`predictive pre-claim cost estimate` — see recent commits).

### Brain — `scripts/myai_brain.sh` + gateway `core/brain*.ts`

The brain is a separate git repository (not this repo, not the managed
repo's own git history) used as an append-only memory log: sessions are
branches, wrap-up is a merge, and a distiller recompiles `brief.md` /
`working.md` / `rollup.md` on `main` after every merge. The gateway exposes it
as MCP tools (`brain_commit`, `brain_merge`, `brain_delta`, `brain_stash`,
`brain_blame`, …, all defined in `runtime/src/mcp/tools.ts`); the CLI wraps
the same operations (`myai brain init|status|write|session|idea|log`). Detail:
`documentation/BRAIN_WORKFLOW.md`, `documentation/BRAIN_OFFLINE.md`,
`architecture/ADR-017-hosted-brain-remote.md`,
`architecture/ADR-020-brain-lakehouse-topic-index.md`.

## How a task flows end to end

1. A task lands in the gateway's task queue — via `myai schedule`, the
   dashboard `/schedule` page, or the fleet morning sweep.
2. The runner (on whichever machine is scheduled) claims it, opens a headless
   session, and works it on `test` in the target repo.
3. The session writes state back through the gateway: task status, a session
   atom to the brain, updated handoff/state files in the target repo.
4. The task shows up in the dashboard's **Needs Review**. A human reviews and
   ships (`test` → PR → `main`) or rejects.
5. Reconciliation scripts (`scripts/reconcile_review_tasks.sh`,
   `scripts/triage_blocked_tasks.sh`) self-heal the board if a task's outcome
   drifts from its recorded status (e.g. it shipped anyway on the branch).

## Two deployment shapes — don't confuse them

- **`docker-compose.yml` (repo root)** — the shared, single "myai" stack: one
  gateway + dashboard + Mongo that a whole fleet of managed repos points at.
  This is what the "DEPLOY GUARD" in `CLAUDE.md` protects — never
  build/up/restart it from a workspace clone of a *managed* repo, only from
  the master checkout.
- **`selfhost/`** and **`runtime/docker-compose.yml`** — self-contained,
  single-operator stacks meant to be started from anywhere, including a
  contributor's laptop. Use these for local development; see
  `documentation/LOCAL_DEV_QUICKSTART.md`.

## Where to look for what

| Concern | Path |
|---|---|
| Gateway HTTP/MCP/WS server | `runtime/src/core/`, `runtime/src/mcp/` |
| Task queue, priority aging, leases | `runtime/src/tasks/` |
| Scheduler / sweeps | `runtime/src/scheduler/` |
| Brain (gateway side) | `runtime/src/core/brain*.ts`, `runtime/src/core/team-brain.ts` |
| RBAC / multi-tenant scoping | `runtime/src/rules/`, ADR-010, ADR-013 |
| Dashboard pages | `dashboard/src/app/` |
| Runner scripts | `scripts/cli_task_runner.sh`, `scripts/myai_runner.sh`, `scripts/setup_cli_runner_*` |
| Brain CLI wrapper | `scripts/myai_brain.sh` |
| Agents/skills consumed by the loader | `agents/`, `skills/` (top-level) — mirrored into `.claude/` |
| CLI entry point | `bin/myai.cjs` |
| Docs site generator | `scripts/build_docs.mjs`, `docs/` |
| Architecture decisions | `architecture/ADR-*.md` |
