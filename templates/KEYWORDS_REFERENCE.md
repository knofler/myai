# Keywords Reference (Extended) — Project Repo

Less-frequently-used keywords for this project repo. Core keywords (`start work`, `agent mode`, `wrap up`, `ship it`, `merge it`, `yolo god`, `yolo`, `yolo off`, `hello`) remain in `CLAUDE.md` because the model needs their full protocol in context every session.

The keywords below are loaded on demand: when the user types one of them, Read this file to get the full action description.

## Status & review

| Keyword | Action |
|---------|--------|
| `status` | Read `AI/state/STATE.md` and give a quick summary: done, in-progress, blocked, next priority. |
| `review` | Dispatch `tech-lead` for code review + `qa-specialist` for test coverage check on recent changes. |
| `plan [feature]` | Dispatch `solution-architect` + `product-manager` + `tech-ba` to break down a feature into specs, stories, and ADR before code. |
| `scaffold [thing]` | Generate boilerplate via relevant specialists: `scaffold api`, `scaffold page [name]`, `scaffold schema [name]`, `scaffold docker`, `scaffold tests`. |
| `audit` | Dispatch `security-specialist` (OWASP) + `qa-specialist` (coverage) + `tech-lead` (standards) in parallel. |
| `handoff` | Prepare full handoff: update STATE.md, write detailed AI_AGENT_HANDOFF.md, log session — ready for a different AI agent. |
| `list` | **Audit all managed repos.** Read `config/managed_repos.txt` from the AI master repo, check each path for: AI/ folder exists, STATE.md exists, CLAUDE.md exists, GEMINI.md exists. Output a markdown table with columns: Project, Level (standalone/workspace root/sub-repo), AI/, STATE.md, CLAUDE.md, GEMINI.md. Bold workspace roots and standalones. |
| `show urls` | Show all deployment URLs for this project: production (main branch) and preview (test branch). Check `.vercel/project.json` for Vercel project name, `render.yaml` for Render. Production: `https://{project}.vercel.app`. Preview: `https://{project}-git-test-{org}.vercel.app`. |

## Brain — git-versioned agent memory (`brain …`)

> The Brain is the AI layer's own version control, separate from code git: a private git repo of append-only atoms where **sessions = commits, wrap up = merge, `main` = the consolidated truth every agent boots from**. This repo's namespace lives at `repos/<this-repo>/…` inside the operator's brain store; `memory/` is cross-repo. Agents NEVER read the brain repo directly — use the master gateway's `brain_*` MCP tools (myai server, `localhost:3100`). If the gateway is unreachable, skip brain steps silently (reading needs NO server: `git pull` the brain repo and read `brief.md`/`working.md` on its main). The keywords are deliberate git muscle memory.

| Keyword | Action |
|---------|--------|
| `brain status` | Call `brain_status` — brain location, current branch, namespaces, atom counts, open `session/*` + `idea/*` branches, pending stashes, last commit. Report as a compact table. |
| `brain commit [note]` | Call `brain_commit` — append ONE immutable atom on the current brain branch. Infer `kind` (`session`/`handoff` under this repo's namespace; `memory` = cross-repo, omit repo) + a kebab slug; body = the note or a concise summary of the current working context. Identical re-writes dedup to a no-op. |
| `brain stash [slug]` | Call `brain_stash` — freeze the current working context (task, decisions, next steps) to the brain's **MAIN** branch and walk away. Survives across processes, devices, and agents — ANY later session can pop it. |
| `brain pop [slug]` | Call `brain_pop` — return + consume the newest stash (or newest matching slug) and continue from that context. |
| `brain branch <idea>` | Call `brain_branch` with `kind=idea` — create/resume the long-lived parallel thinking context `idea/<slug>` off brain main. |
| `brain checkout <ref>` | Call `brain_checkout` — switch to `main`, `session/<…>`, or `idea/<…>` only. |
| `brain merge [branch]` | Call `brain_merge` — merge the current (or named) session/idea branch into brain main (`--no-ff`); **what `wrap up` calls.** Session branches are deleted after merge; idea branches survive. Auto-runs the distiller: `brief.md` (~150 tok) / `working.md` (~2k) / `rollup.md` regenerate on main. |
| `brain log [n]` | Call `brain_log` — brain commit history, scopable by `ref`/`path` (e.g. `repos/<this-repo>/sessions`). |
| `brain diff` | Call `brain_diff` — what the current brain branch has that main doesn't (default `main..HEAD`); `patch=true` for the diff. |
| `brain delta` | Call `brain_delta` with `since` = your last-seen brain main SHA (the `Brain:` line the previous wrap-up left in `AI/state/AI_AGENT_HANDOFF.md`, or the SHA from the `context_boot` bundle) — a ~300–800-token catch-up of new atoms/commits/artifacts. No/unknown SHA → the ~150-token boot brief. **What `agent mode -min` boots with.** Remember the returned `sha` as the next anchor. |
| `brain blame <path\|topic>` | Provenance — which session/commit wrote an atom and when: `brain_log` scoped to the atom's path. Full dual code↔memory provenance lands with BRAIN B5. |
| `brain revert <sha>` | Call `brain_revert` — undo a brain commit with an INVERSE commit; history is never rewritten. |

**Anchor convention:** every `wrap up` records the post-merge brain main SHA as a `Brain: <sha>` line in the handoff header; every boot also reports the current SHA. That SHA is the `since` for the next `brain_delta` — diff-only catch-up instead of a full state re-read.

## Scheduling — autonomous work queue (STANDARD)

> **The ONE correct way to schedule autonomous work in this repo: create a TASK in the myAI gateway queue.** A launchd CLI task runner (every few hours, free Fable window, `claude-tech` profile, subscription-billed, 0 API tokens) pulls the highest-priority pending task, works it on a `test` branch, then flips it to **Needs Review** for a human `ship it`. **Do NOT create gateway *cron schedules* for this work** — those bill API tokens and are disabled fleet-wide. Create a task; the runner schedules it by priority.

| Keyword | Action |
|---------|--------|
| `schedule <description>` / `schedule task` | **Queue one autonomous task for this repo.** Run `./AI/scripts/schedule_task.sh --title "<imperative title>" [--priority P0..P3] [--agent <specialist>] [--desc "..."] [--model <id>]`. Defaults: repo = git basename, priority = P2, model = free-window Fable (claude-fable-5 until 2026-06-22, else agent-tier). Infer a clear imperative title, priority, and specialist from the request; pass `--desc` with acceptance criteria. Report the task ID + dashboard links. |
| `schedule list` / `what's scheduled` | Show what's queued: `./AI/scripts/schedule_task.sh --list` (this repo) or `--list-all` (whole fleet). **Where to check:** dashboard `http://localhost:3210/tasks` + `/schedule` (Needs Review / Up Next); runner logs in `~/.ai-cli-runner/logs/`. The dashboard "Scheduled Runs" cron table is a *different*, mostly-disabled system — the real engine is the runner + this task queue. |
| `schedule plan` | **MYTHOS-GRADE PLAN + 10-DAY SCHEDULE → SHIP → WRAP (self-contained; plans/schedules, does NOT build features).** Works from CLI or mobile. **(1) Plan doc:** read `AI/plan/*`, `AI/state/STATE.md`, handoff, README, source + TODOs, then write **`AI/plan/MYTHOS_IMPROVEMENT_PLAN.md`** — ambitious coverage of **tooling, tracking, service & integration, functionality, UX/web design, user journey, practical use cases**. **Always include a CONTINUOUS SELF-IMPROVEMENT track** — tech-debt paydown, test coverage, performance, a11y, security, DX/refactor — not only new features. It's a recurring loop (`schedule plan` re-runs as `wrap up` step 0), so the product keeps improving every session. **(2) Portable artifact `AI/plan/schedule.json`:** `{repo, startDate, days:[{day,focus,status:"enabled"}] (10), tasks:[{title,priority,agent,model:"claude-fable-5",category,day,desc}]}` — the device-independent source of truth. **(3) Register with the master runner IF the gateway is reachable** (`http://localhost:3100/mcp`): run `./AI/scripts/push_schedule.sh` (does `plan_set` → dashboard `/plan` + `schedule_task.sh` per task). **Mobile/cloud (gateway unreachable): SKIP** — the committed artifact is the source; a CLI `agent mode -a` on any Mac ingests it. **(4) Off-hours only:** fires clamp to **weekday 6pm–9am Sydney + all weekend**. **(5) DO NOT build features.** Exclude credential/user-blocked items. **(6) THEN auto-run `ship it`** (commit plan + `schedule.json` on `test` → PR → **main**, reaching all devices) **then `wrap up -u`** (`-u` REQUIRED — skips wrap-up's own `schedule plan` step, prevents a loop). Don't wait for the user to ask. |

**Task field standard:** `repo`, `title` (imperative, <90 chars), `priority` (P0–P3), `assignedAgent`, `recommendedModel`, `description` (what + acceptance), `source: manual`. Gateway must be running (host `http://localhost:3100`); `schedule_task.sh` checks reachability and tells you if it's down.

## Connect Hub

| Keyword | Action |
|---------|--------|
| `check bugs` | Pull open bugs from the Connect Hub DB (`BugReport` collection). List by severity. Suggest which to fix first based on severity and age. |
| `fix bug [id]` | Pull bug details from DB. Set status to "working". Analyse root cause, implement fix on `test` branch, push, create PR. Update bug: status → "solved", resolution, prUrl. |
| `check features` | Pull open feature requests from DB (`FeatureRequest` collection). List by priority and upvotes. Suggest which to implement first. |
| `build feature [id]` | Pull feature details from DB. Set status to "working". Generate implementation plan, implement on `test` branch, push, create PR. Update feature: status → "solved", prUrl. |
| `triage` | Pull all "reported" bugs and features from DB. AI analyses each: set severity/priority, detect duplicates, assign to specialist agent, update status to "triaged". |
| `connect setup` | **Integrate Connect Hub into this project.** 1. Read `AI/documentation/CONNECT_HUB.md` — this is the FULL instruction doc with every step. 2. Check if Connect Hub files exist in `src/models/BugReport.ts`, `src/app/api/connect/`, `src/app/connect/`. If missing, tell user: "Connect Hub files not found. Run this from the master AI repo first: `./scripts/init_connect.sh /path/to/this/project`". 3. If files exist, follow Steps 1-8 in CONNECT_HUB.md: verify files → fix import placeholders (`__DB_IMPORT__`, `__AUTH_IMPORT__`, `__MODELS_PATH__`) → update middleware → update model barrel exports → add nav item → type check → test → report summary table. |

## Productionisation

| Keyword | Action |
|---------|--------|
| `make preview` | **Set up the test→preview pipeline for this repo.** 1. Create `test` branch from `main` if not exists. 2. Push `test` to remote. 3. Add CI workflows (`.github/workflows/ci.yml` + `merge-gate.yml`) if missing. 4. Set branch protection via `gh` CLI. 5. Sync `test` with latest `main`. 6. Report preview URL. |
| `make prod` | **Productionise this project with branching strategy.** 0. **Check first:** Look for existing Vercel config, Render config, Atlas connection. If already configured → verify health, report status, done. 1. **Set up branching:** Create `test` branch, add CI workflows (`.github/workflows/ci.yml` + `merge-gate.yml`), set branch protection rules. 2. **Provision infrastructure:** Detect project type (Next.js → Vercel, Express → Render, MongoDB → Atlas). Create Vercel project + deploy from `main`. Set env vars for both Production and Preview environments. 3. **Verify:** Push test commit to `test` branch, confirm CI passes + Vercel preview deploys. Verify health endpoint. 4. **Update:** State files with production URLs + preview URL pattern. |

## Remote control & Telegram

| Keyword | Action |
|---------|--------|
| `remote` | Go remote. In a RUNNING session prefer native `/remote-control` (or `/rc`) — instant, no restart. For a fresh session start `claude --remote-control` for this project. Run `./AI/scripts/remote.sh` — prints QR code/URL to connect from phone, tablet, or browser. Session runs locally. See `AI/documentation/MOBILE_CONTROL.md`. |
| `telegram setup` | Run guided Telegram bot setup: `./AI/scripts/telegram-setup.sh`. Checks Bun installed, installs plugin, configures bot token, prints next steps for pairing and lockdown. See `AI/documentation/MOBILE_CONTROL.md`. |
| `telegram start` | Launch Claude Code with Telegram channel active: `claude --channels plugin:telegram@claude-plugins-official`. Requires prior setup via `telegram setup`. |

## Fleet inventory (`ai tools` family)

| Keyword | Action |
|---------|--------|
| `ai tools` | **Fleet inventory — show 5 of each.** 1. Try live gateway first: `curl -s http://localhost:3100/mcp` for MCP tools, `curl -s http://localhost:3200/api/agents` + `/api/skills` for counts. If gateway down, fall back to reading `AI/agents/`, `AI/skills/`, and the master repo's `runtime/src/mcp/tools.ts`. 2. Print four sections of 5 rows each: **Agents** (name, category, one-line), **Skills** (name, description, triggers), **MCP Tools** (name, category, purpose), **Gateway Routes** (one row per surface: `:3100` MCP, `:3200` REST, `:3201` WS, `:3210` dashboard). 3. End each section with `… N more — run "more <type>" to see all`. Full reference lives in the master repo's README. |
| `more agents` | Expand the `ai tools` agents block — list all 57 agents grouped by category. |
| `more skills` | Expand the `ai tools` skills block — list all 135 skills with triggers. |
| `more mcp` / `more mcp tools` | Expand all 15 MCP tool definitions with input schemas (pull from `http://localhost:3100/mcp` `tools/list`). |
| `more routes` | Expand every HTTP (`:3200`), WebSocket (`:3201`), MCP (`:3100`), and dashboard (`:3210`) route. |
| `ai tools help` / `help ai tools` | Print the `ai tools` usage block (default behavior + sub-commands + data sources). |
