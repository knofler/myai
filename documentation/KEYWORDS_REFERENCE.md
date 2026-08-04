# Keywords Reference (Extended)

Less-frequently-used keywords. **Core keywords** (`agent mode`, `wrap up`, `ship it`, `init blueprint`, `yolo god`, `yolo`, `yolo off`, `hello`, `init`, `jam`) keep a **compact recognition row in `CLAUDE.md`** (trigger + safety-critical bits) so the per-turn context stays small; their **full step-by-step protocol lives in `documentation/CORE_KEYWORDS.md`** (Read it when a verbose one fires). The short keywords (`hello`, `init`, `yolo god`, `yolo`, `yolo off`) are fully inline in `CLAUDE.md`.

The keywords below are loaded on demand: when the user types one of them, read this file to get the full action description.

## Jam — collaborative ideation (`jam`)

`jam` (or `jam <idea>`) is the front-door for the **0→1** part: thinking an idea through *together* before building. It is the one mode where the zero-prompt/YOLO policy is **suspended** — in a jam, asking, exploring, and disagreeing IS the work.

**Posture.** When `jam` fires, switch from executor to thought-partner:
- **NO building during the jam** — no code, no file edits, no commits, no task dispatch. The output is shared understanding, not a diff.
- It's a **conversation, not a form.** Do NOT fire a batch of multiple-choice `AskUserQuestion`s — talk it through. (Use a structured question only if the user is genuinely stuck choosing between concrete options.)
- Drive loosely toward: **problem/goal → constraints → options + tradeoffs → recommended direction → open risks.** Stay fluid; follow the user.
- Bring a point of view — react, build on the idea, push back where it's weak. A good jam makes the idea sharper, not just documented.

**Persistent mode.** `jam` holds across turns until the user says `build it`, `jam done`, or picks "schedule it" at the decision point. `more jam` (or simply continuing the discussion) keeps brainstorming.

**On convergence → brief + register (automatic).** When the idea has a clear shape:
1. Write a concise brief to `plan/jam/<slug>.md` (managed repos: `AI/plan/jam/<slug>.md`): **Problem · Decision/Direction · Approach · Scope (in/out) · Open risks · Next steps.**
2. Register it as a plan via `plan_set` (→ dashboard `/plan`) so the idea is captured + visible. (Gateway calls send the `x-gateway-local-token`; see `scripts/lib/gateway.sh`.)

**Then → DECISION POINT (explicit, every time — nothing auto-builds).** Present the fork and let the user choose:
- **Schedule it** — break the brief into build tasks (`schedule_task`, focus-tier priority) so the runner builds it off-hours; or `agent mode` to build now interactively; or `init blueprint` if it's a brand-new app.
- **More jam** — not ready. Keep refining (loop back into brainstorm).
- **Park it** — the brief + plan are saved on `/plan`; pick it up any time.

**Why it exists.** Every other keyword executes; `jam` is the deliberate space to think first, so we build the right thing. It feeds straight into the existing funnel: **`jam` → brief/plan → schedule → runner builds.**

## Brain — git-versioned agent memory (`brain …`)

> The Brain is the AI layer's own version control, separate from code git (`plan/jam/brain-layer.md`): a private git repo of append-only atoms where **sessions = commits, wrap up = merge, `main` = the consolidated truth every agent boots from**. Agents NEVER read the brain repo directly — they use the gateway `brain_*` MCP tools (myai server, `localhost:3100`). Bash fallback when the gateway is down: `myai brain <cmd>` / `scripts/myai_brain.sh` (reading needs NO server at all — `git pull` the brain repo and read `brief.md`/`working.md` on its main). The keywords are deliberate git muscle memory.

| Keyword | Action |
|---------|--------|
| `brain status` | Call `brain_status` — where the brain lives, current branch, namespaces, atom counts (sessions/handoffs/memory), open `session/*` + `idea/*` branches, pending stashes, last commit. Report it as a compact table. |
| `brain commit [note]` | Call `brain_commit` — append ONE immutable atom on the current brain branch. Infer `kind` (`session`/`handoff` under this repo's namespace; `memory` = cross-repo, omit repo) and a kebab slug from the note; body = the note or a concise summary of the current working context. **Always pass an explicit `topic`** — the note's dominant theme from the controlled BRAIN_TOPICS set (`runner-ops`, `cost-policy`, `gateway-infra`, `go-live`, `continuity`, `distribution`, `billing`, `brain`, `security`, `docs`); omitting it writes a warned `general` atom that degrades the ADR-020 topic index. Bash callers pass it via `BRAIN_TOPIC=<topic>` (`myai brain write`). Atoms are immutable — identical re-writes dedup to a no-op. |
| `brain stash [slug]` | Call `brain_stash` — freeze the current working context (task, decisions, next steps) as a payload committed to the brain's **MAIN** branch, then you can walk away. Unlike git-stash it survives across processes, devices, and agents: ANY later session can pop it. |
| `brain pop [slug]` | Call `brain_pop` — return + consume the newest stash (or newest matching slug) and continue from that context. Run `brain status` first if unsure what's pending. |
| `brain branch <idea>` | Call `brain_branch` with `kind=idea` — create/resume the long-lived parallel thinking context `idea/<slug>` off brain main. (`kind=session` is the auto session branch `session/<date>-<host>-<profile>` — normally created by session start, not by hand.) |
| `brain checkout <ref>` | Call `brain_checkout` — switch the brain to `main`, `session/<…>`, or `idea/<…>`. Refuses anything outside those families. |
| `brain merge [branch]` | Call `brain_merge` — merge the current (or named) session/idea branch into brain main (`--no-ff`); **this is what `wrap up` calls.** Session branches are deleted after merge; idea branches survive. Auto-runs the distiller (compile-at-write): `brief.md` (~150 tok) / `working.md` (~2k) / `rollup.md` regenerate on main. Conflicts abort cleanly. |
| `brain log [n]` | Call `brain_log` — brain commit history (sha, date, subject), scopable by `ref`/`path` (e.g. `repos/<name>/sessions`). |
| `brain diff` | Call `brain_diff` — what the current brain branch has that main doesn't (default `main..HEAD`); `patch=true` for the unified diff (20k cap). |
| `brain search <query>` | Call `brain_search` — **federated** search: ranks the brain's atoms (every repo namespace, keyword term-frequency) together with the RAG session-corpus vectors (`recallSession`, semantic) in one merged, score-normalized list. "What have we done about X" without knowing which repo-brain holds the answer. Narrow with `repo=`/`k=`/`since=`. Dashboard: the Search tab at `/brain` (`views/brain-search.tsx` → `/api/brain/search`). Bash (the one `myai brain` subcommand that needs the gateway, since the session-corpus half lives in Mongo): `myai brain search <query…> [--repo r] [--k N] [--since date] [--json]`. |
| `brain delta` | Call `brain_delta` with `since` = your last-seen brain main SHA (the `Brain:` line the previous wrap-up left in the handoff header, or the SHA the `context_boot` bundle reported) — returns ONLY the ~300–800-token delta: new atoms, commits, changed compiled artifacts. No/unknown SHA degrades to the ~150-token boot brief. **This is what `agent mode -min` boots with.** Remember the returned `sha` as the next anchor. |
| `brain blame <code-sha\|brain-ref>` | Call `brain_blame` — dual code↔memory provenance (BRAIN B5). **Forward** (`code_sha`, full or ≥7-char prefix): which brain commits reference that code commit — "what was the agent thinking when it produced X" — with the atom files (session logs) to read. **Reverse** (`ref`, e.g. `idea/<slug>`): every code SHA that line of thinking produced. Stamps come from `brain_commit` `code_*` args (repo, branch, HEAD SHA, commits — the runner stamps automatically on task completion, and git notes under `refs/notes/myai-brain` back-link the code commits with zero code-history pollution: `git log --notes=myai-brain` in the code repo shows them). Bash: `myai brain blame <sha\|ref>` / `myai brain stamp <code-dir> <repo> <slug> [sha…]`. For "which session wrote atom X": `brain_log` scoped to the atom's path still works. |
| `brain revert <sha>` | Call `brain_revert` — undo a brain commit with an INVERSE commit; history is never rewritten, atoms stay append-only. Merge commits revert against their first parent; conflicts abort cleanly. |
| `brain gc [--dry-run] [--stash-age N]` | Compact the store to bound growth WITHOUT rewriting history: dedup byte-identical atoms (two-host merges land the same fact under different `<ts>-<host>-` prefixes → collapse to the earliest, survivor untouched), prune orphan namespaces (zero session+handoff atoms) and abandoned stashes (frozen > N days ago, default 30), then `git gc --prune=now` to fold loose objects. Removals are normal (revertable) commits on main; reports reclaimed KB. `--dry-run` prints the plan and mutates nothing. Round-trip safe. Bash: `myai brain gc` (`brain_gc`); Node mirror `brainGc()`. |

**Anchor convention:** every `wrap up` records the post-merge brain main SHA as a `Brain: <sha>` line in the handoff header; every boot (`context_boot` / MCP initialize bundle) also reports the current SHA. That SHA is the `since` for the next `brain_delta` — diff-only catch-up instead of a full state re-read.

## Sync & maintenance

| Keyword | Action |
|---------|--------|
| `sync all` | Run `./scripts/update_all.sh` without committing master first. |
| `health check` | Run `./scripts/health_check.sh` and report results. |
| `add repo [path]` | Append path to `config/managed_repos.txt`, run init on it, then sync. |
| `init [agent]` | Run `./scripts/introduce_agent.sh [agent]` to generate the agent's instruction file. Agents: `all`, `claude`, `gemini`, `copilot`, `cursor`, `windsurf`, `cline`, `aider`, `agents-md`. Reads paths from `config/agent_paths.conf`. |
| `list` | **Audit all managed repos.** Read `config/managed_repos.txt`, check each path for: AI/ folder exists, STATE.md exists, CLAUDE.md exists, GEMINI.md exists. Output a markdown table with columns: Project, Level (standalone/workspace root/sub-repo), AI/, STATE.md, CLAUDE.md, GEMINI.md. Bold workspace roots and standalones. |
| `show urls` | Show all deployment URLs across all managed repos: production (main) and preview (test). Read `.vercel/project.json` from each repo, construct URLs. Output as a markdown table. |

## Scheduling — autonomous work queue (STANDARD, fleet-wide)

> **There is ONE correct way to schedule autonomous work in any repo: create a TASK in the gateway queue.** The launchd CLI task runner (every few hours, free Fable window, `claude-tech`, subscription-billed, 0 API tokens) pulls the highest-priority pending task, works it on a `test` branch, then flips it to **Needs Review** for a human `ship it`. **Do NOT create gateway *cron schedules* for per-repo work** — those bill API tokens and are disabled fleet-wide. Create a task; the runner schedules it by priority.

| Keyword | Action |
|---------|--------|
| `schedule <description>` / `schedule task` | **Queue one autonomous task for this repo.** Run `./AI/scripts/schedule_task.sh --title "<imperative title>" [--priority P0..P3] [--agent <specialist>] [--desc "..."] [--model <id>]` (master repo: `./scripts/schedule_task.sh`). Defaults: repo = git basename, priority = P2, model = free-window Fable (claude-fable-5 until 2026-06-22, else agent-tier). Before running: infer a clear imperative title, a sensible priority, and the right specialist agent from the request; pass `--desc` with acceptance criteria. Report the returned task ID + dashboard links. The runner works it by global priority on its next fire. |
| `schedule list` / `what's scheduled` | Show what's queued. `./AI/scripts/schedule_task.sh --list` (this repo) or `--list-all` (whole fleet queue). **Where to check:** dashboard `http://localhost:3210/tasks` (full backlog) and `/schedule` (Needs Review + Up Next). Runner transcripts: `~/.ai-cli-runner/logs/`. NOTE: the dashboard "Scheduled Runs" cron table is a *different*, mostly-disabled system — the real engine is the launchd runner + this task queue. |
| `schedule plan` | **MYTHOS-GRADE PLAN + 10-DAY SCHEDULE → SHIP → WRAP (self-contained; plans/schedules, does NOT build features).** The standing protocol every repo runs to become a world-class, production-grade app — works from **CLI or mobile**. **(1) Produce the plan doc:** read `AI/plan/*`, `AI/state/STATE.md`, handoff, README, source layout + TODOs, then write **`AI/plan/MYTHOS_IMPROVEMENT_PLAN.md`** (master: `plan/…`) — ambitious, opinionated coverage of **tooling, tracking, service & integration, functionality, UX/web design, user journey, practical use cases**. **Every plan MUST carry a continuous CONTINUOUS SELF-IMPROVEMENT track** — tech-debt paydown, test-coverage lift, performance, accessibility, security hardening, DX/refactor — not only new features. This is a recurring self-improvement loop: `schedule plan` re-runs as `wrap up` step 0, so each product keeps improving itself every session. **(2) Write the portable schedule artifact `AI/plan/schedule.json`** (master: `plan/schedule.json`): `{repo, startDate, days:[{day,focus,status:"enabled"}] (10 days), tasks:[{title,priority,agent,model:"claude-fable-5",category,day,desc}]}`. This file is the device-independent source of truth. **(3) Register with the master runner — IF the gateway is reachable** (`http://localhost:3100/mcp`, i.e. a CLI session on the gateway Mac): call `plan_set` (→ dashboard `/plan`) + `./AI/scripts/schedule_task.sh` per task — OR just run `./AI/scripts/push_schedule.sh` which does both from the artifact. **Mobile/cloud sessions (gateway unreachable): SKIP registration** — the committed artifact is the source; a CLI `agent mode -a` on any Mac ingests it (see `agent mode`). **(4) Off-hours only:** fire times auto-clamp to **weekday 6pm–9am Sydney + all weekend**; never schedule into weekday 9am–6pm. **(5) DO NOT build features.** Exclude credential/user-blocked items. **(6) THEN automatically run `ship it`** (commits the plan doc + `schedule.json` on `test` → PR → **main**, so it reaches both devices) **followed by `wrap up -u`** (the `-u` is REQUIRED — it skips wrap-up's own `schedule plan` step 0, preventing a loop). Do not wait for the user to ask for ship/wrap. **(7) CONSENT LIST:** if this repo is on `config/schedule_ignore.txt` (the no-autonomous-schedule list — your consented sandbox/secondary repos — see `config/schedule_ignore.txt`), **DO NOT auto-submit a plan or top up its queue** — `schedule_task.sh`/`push_schedule.sh` refuse it, and if a plan is somehow submitted you MUST check with the user before scheduling. Consented override only: `SCHEDULE_CONSENT=1`. See AI_RULES §7. |

**Task field standard** (every scheduled task carries): `repo`, `title` (imperative, <90 chars), `priority` (P0–P3), `assignedAgent` (a specialist), `recommendedModel` (free-window model or tier-default), `description` (what + acceptance), `source: manual`. Direct MCP path if the script is unavailable: `tasks_create` on `http://localhost:3100/mcp` (`tasks_list {"limit":500}` to view — it defaults to 50).

**Per-tenant off-hours runner (ADR-010 M4).** The runner serves the local `default` tenant over loopback by default (unchanged). To run a paying tenant's queue on the free-window model, give it that tenant's per-tenant API key — the gateway then derives `tenantId` from the credential and scopes **both** task pickup and the review/blocked flip to that tenant (never from a tool arg):
- `./scripts/cli_task_runner.sh --tenant <id>` — serve one tenant.
- `./scripts/cli_task_runner.sh --all-tenants` — sweep every tenant in the keys file (concurrent slot fires spread across the combined pool).
- Keys live in a git-ignored local file (`~/.ai-cli-runner/tenant-keys.env`, override `$TENANT_KEYS_FILE`; template `config/tenant_keys.env.example`) as `<tenantId>=<rawApiKey>` lines, or `$TENANT_API_KEY` for a single tenant. A non-default tenant with no key is skipped (never silently served as `default`). Same off-hours window + slot/backoff model as the single-operator runner. Parser: `scripts/lib/tenant_keys.sh` (unit-tested via `scripts/tests/test_tenant_keys.sh`).

## Fleet Morning Console — `agent mode -resume all` (MASTER REPO ONLY)

> **The "coffee + drive the whole fleet from one terminal" command.** Where `agent mode -resume` joins the last headless run for THIS repo, `agent mode -resume all` (aka `resume all`, `morning fleet`, or the slash command **`/fleet`** → the `fleet` skill in `skills/fleet/`) sweeps EVERY managed repo's overnight work, shows one decision table, and lets you trigger merge / fix / test / ship / wrap-up per repo **directly from the master terminal** — no need to open each repo. Every action streams **live to the dashboard `/fleet` page** (http://localhost:3210/fleet, 4s auto-refresh). Master-repo-only (it reads `config/managed_repos.txt`); never propagated to managed repos.

**Architecture:** `scripts/fleet_resume.sh` (aggregator + live-progress CLI) → gateway `fleet_run_*` MCP tools (`fleet_run_start` / `fleet_run_repo_update` / `fleet_run_finish` / `fleet_run_latest` / `fleet_run_list`) → `FleetRun` Mongo collection → dashboard `/fleet` SSR page (auto-refresh). Trigger model is **Option 1 (direct execution from this terminal)**, user-chosen 2026-06-16.

**Protocol:**

1. **Sweep** — `./scripts/fleet_resume.sh scan` (add `--no-fetch` for a fast, possibly-stale preview). It resolves `config/managed_repos.txt` to unique git roots and for each gathers: branch, commits on `test` ahead of `main` (uses `origin/*` refs after fetch), uncommitted count, open PRs + the `test→main` PR's CI rollup, CLI-runner jobs in the last 24h (`~/.ai-cli-runner/logs/*-<repo>-task-*.log`), and queued `review`/`blocked` gateway tasks. It computes a per-repo **recommendation** and a one-line **overnight** summary, opens a `FleetRun` (keyed `fleet-YYYYMMDD-HHMM`), prints the table, and emits a `RUNID=…` tail line. Capture that runId.
   - **Recommendation heuristic:** green `test→main` PR → `merge`; failing PR or `blocked` tasks → `fix`; `review` tasks present → `review`; commits ahead of main → `ship`; only uncommitted changes → `wrap-up`; otherwise `idle`. These are hints — refine per repo with judgment.
2. **Present** the table to the operator and collect per-repo decisions in plain English (e.g. `ship web · fix api · merge mobile · skip the rest`).
3. **Execute each pick DIRECTLY from here**, one repo at a time. For each:
   - `./scripts/fleet_resume.sh update <RUNID> <repo> --status in-progress --action <ship|fix|merge|test|wrap-up> --decision "<what the user said>"` (reflects live on `/fleet`).
   - `cd` into the repo's git root and run the matching flow:
     - **ship** → the `ship it` protocol (commit → push `test` → CI / local-ci fallback → PR → admin-merge when Actions billing-blocked, per the Local-CI Policy).
     - **fix** → diagnose + patch; for non-trivial work spawn a focused sub-agent (`Agent` tool) scoped to that repo, then verify.
     - **merge** → admin-merge the green PR (`gh pr merge --merge --admin` where branch protection permits).
     - **test** → run the repo's Docker test gate (`./AI/scripts/local-ci.sh` or `./dev test`).
     - **wrap-up** → the `wrap up` protocol in that repo.
   - On completion: `./scripts/fleet_resume.sh update <RUNID> <repo> --status done --detail "<result>" [--pr <url>]` (or `--status failed --detail "<why>"`).
   - Safety rails apply per repo (no-push-main, secret-scan, protected-files hooks run regardless of bypass mode). **Repos flagged AI-folder-only in `config/managed_repos.txt` — never write outside `AI/`, never push.**
4. **idle / skip** → leave `pending`, or mark `--status skipped` to record the choice.
5. **Close** — when all picks are handled: `./scripts/fleet_resume.sh finish <RUNID>` (stamps `completed` + final summary). Re-display any time with `./scripts/fleet_resume.sh latest`.
6. **Zero-prompt + YOLO honored** — decide and act; only stop for a genuine credential/decision blocker. Cross-machine merges/ships are **irreversible** → execute exactly the operator's picks, nothing extra.

## Connect Hub

| Keyword | Action |
|---------|--------|
| `check bugs` | Pull open bugs from Connect Hub DB. List by severity. Suggest which to fix first. |
| `fix bug [id]` | Pull bug from DB, analyse, implement fix on test branch, create PR, update bug status. |
| `check features` | Pull open feature requests from DB. List by priority + votes. Suggest which to build. |
| `build feature [id]` | Pull feature from DB, implement on test branch, create PR, update status. |
| `triage` | Pull all "reported" bugs and features. AI triages: set severity/priority, detect duplicates, assign agents. |
| `init connect [path]` | **Install Connect Hub into a project.** Run `./scripts/init_connect.sh [path]`. Copies models, API routes, pages, and `AI/documentation/CONNECT_HUB.md` instruction doc. Auto-detects DB and auth imports. The local agent then uses `connect setup` keyword to integrate. |

## Productionisation

| Keyword | Action |
|---------|--------|
| `make preview` | **Set up test→preview pipeline for a repo.** Create `test` branch, add CI workflows, set branch protection, verify Vercel deploys preview. |
| `make prod` | **Productionise a project with branching strategy.** 0. **Check first:** Look for existing Vercel config, Render config, Atlas connection. If already configured → verify health, report status, done. 1. **Set up branching:** Create `test` branch, add CI workflows (`.github/workflows/ci.yml` + `merge-gate.yml`), set branch protection rules. 2. **Provision infrastructure:** Detect project type (Next.js → Vercel, Express → Render, MongoDB → Atlas). Create Vercel project + deploy from `main`. Set env vars for both Production and Preview environments. 3. **Verify:** Push test commit to `test` branch, confirm CI passes + Vercel preview deploys. Verify health endpoint. 4. **Update:** State files with production URLs + preview URL pattern. |
| `scan [path]` | **Scan a project codebase.** Run `./scripts/scan-project.sh [path]`. Detects tech stack, frameworks, databases, Docker, CI/CD, auth, tests. Outputs JSON report at `<project>/AI/scan-report.json` + console summary with recommendations. |
| `generate [idea]` | **Autonomous project generation — idea to deployment plan.** 1. Create project workspace: `mkdir -p projects/<name>/stages/artifacts/code/`, write `project.json` manifest. 2. Read `config/generation-stages.json` for the 8 stage definitions. 3. For each stage (idea → plan → brd → gap-analysis → trd → design → build → ship): generate content following the stage instructions, using the previous stage's output as context (relay semantics). Save to `projects/<name>/stages/<stage>.md`. 4. If `--scan /path` provided, first run `./scripts/scan-project.sh [path]` and include the scan report as context. 5. Update `project.json` after each stage. No API key needed — Claude Code generates directly. |

## Remote control & Telegram

> **Auto-check on session start:** `agent mode` and `agent mode -min` now check remote control for the **current repo** automatically — if the repo you're starting isn't phone-drivable (`[museum …]` in `remote_fleet.sh status`), they run `remote_fleet.sh start <this-repo>` to open its doorway. **Current-repo scope only** — session start never spawns the whole fleet (that's the explicit `remote start`/`remote fleet` keyword below), keeping idle museum credit spend off the slow-burn path.


| Keyword | Action |
|---------|--------|
| `remote status` / `remote start [all\|core\|repo…\|--last-start]` / `remote stop [repo…\|--last-start]` (aka `remote fleet …`) | **Fleet remote sessions — works in EVERY repo.** Runs `./scripts/remote_fleet.sh <action>` (master) or `./AI/scripts/remote_fleet.sh <action>` (managed repos; repo set in `config/remote_fleet.txt`, absolute paths so it's identical everywhere). **`status`**: table of every fleet repo with its live claude sessions + profile per session — the "who is already working where" view that prevents parallel-agent duplication; run it BEFORE starting interactive work on any repo. **`start`**: opens an iTerm tab per repo running `CLAUDE_CONFIG_DIR=~/.claude-museum claude`; museum's `remoteControlAtStartup:true` makes each session auto-appear in the phone's Code list. **Wrap-up-aware duplicate guard**: a repo whose museum session is already live is skipped; a repo with only tech/default sessions gets the museum doorway ALONGSIDE when its working tree is clean (wrap up completed = no duplicate-work risk) and is skipped with a 'wrap up first' warning when the tree is dirty (mid-work). `status` shows a TREE column (clean/DIRTY) so you can see from the phone which repos are safely wrapped. `--max N` RAM cap (default 12, ~350 MB/session), `--dry-run`. **`stop`**: stops MUSEUM sessions only — interactive claude/claude-tech shells are never touched. **ANCHOR RULE: the master AI repo's museum session is NEVER stopped** (not via `all`, not by name) — it is the fleet's remote doorway: with every other session stopped, you restart them FROM THE PHONE by opening the AI session in the mobile app's Code list and typing `remote start <repo…>` (or `remote start all`) — that session runs `remote_fleet.sh` on the Mac and the new iTerm tabs auto-appear in the phone's Code list. Deliberate override: `--include-anchor`. If the anchor itself ever dies (Mac reboot, crash), recovery needs one on-Mac action: any terminal (or SSH/Screen Sharing) running `./scripts/remote_fleet.sh start AI` — then the phone has its doorway back. **`stop --last-start` (undo a start):** stops ONLY the sessions the most recent real `start` run launched — already-live sessions from before that start are untouched. Every non-dry-run explicitly-targeted `start` records what it launched to `~/.myai-remote-fleet-last-start` (machine-local, overwritten per run); `stop --last-start` reads it. Anchor rule still applies on top. **`start --last-start` (reopen the last set):** starts exactly the recorded set again (duplicate guard applies as normal; stale recorded paths are skipped with a notice). Deliberately NEVER rewrites the record — the record always means "the last start whose repo set was chosen explicitly", so `stop --last-start` / `start --last-start` form a stable, re-runnable toggle over the same set. No record on this machine → clean error (exit 1); a record whose run launched nothing → graceful no-op. Idle sessions burn ZERO tokens (billing only happens when a session is driven) — the cost is RAM only. Operating model: claude-tech = off-hours runner (queue-driven, atomic claim); claude-museum = remote doorway + interactive (interactive work ALWAYS ends with `wrap up`); mid-work handover = `wrap up` in the tech/default session → pick up the museum session from the phone (train mode). |
| `remote` | Go remote. In a RUNNING session prefer native `/remote-control` (or `/rc`) — instant, no restart. For a fresh session start `claude --remote-control` for this project. Run `./scripts/remote.sh` — prints QR code/URL to connect from phone, tablet, or browser. Session runs locally. See `documentation/MOBILE_CONTROL.md`. |
| `telegram setup` | Run guided Telegram bot setup: `./scripts/telegram-setup.sh`. Checks Bun installed, installs plugin, configures bot token, prints next steps for pairing and lockdown. See `documentation/MOBILE_CONTROL.md`. |
| `telegram start` | Launch Claude Code with Telegram channel active: `claude --channels plugin:telegram@claude-plugins-official`. Requires prior setup via `telegram setup`. |

## Fleet inventory (`ai tools` family)

| Keyword | Action |
|---------|--------|
| `ai tools` | **Fleet inventory — show 5 of each category + route surfaces.** 1. Try gateway endpoints first: `curl -s http://localhost:3100/mcp` for MCP tool list, `curl -s http://localhost:3200/api/agents` and `/api/skills` for counts. If gateway down, fall back to reading `.claude/agents/`, `.claude/skills/`, and `runtime/src/mcp/tools.ts`. 2. Print four sections (5 rows each): **Agents** (name, category, one-line), **Skills** (name, description, triggers), **MCP Tools** (name, category, purpose), **Gateway Routes** (one row per surface: `:3100` MCP, `:3200` REST, `:3201` WS, `:3210` dashboard). 3. End each section with `… N more — run "more <type>" to see all`. 4. Full reference is in README section "Gateway Routes & Endpoints" + "`ai tools` — Fleet Inventory Command". |
| `more agents` | Expand `ai tools` agents block — list all 57 agents grouped by category (core / swarm / dev / analysis / neural / github / ops / data / content / extra) with name + description. |
| `more skills` | Expand `ai tools` skills block — list all 135 skills with name, description, trigger keywords. Group by owning specialist where obvious from filename prefix. |
| `more mcp` / `more mcp tools` | Expand `ai tools` MCP block — call `tools/list` on `http://localhost:3100/mcp` (fallback: read `runtime/src/mcp/tools.ts`) and print every tool with its name, description, and full input schema (required params + optional params). |
| `more routes` | Expand `ai tools` routes block — dump full tables of HTTP routes (`:3200`), WebSocket message types (`:3201`), MCP JSON-RPC methods (`:3100`), and dashboard pages (`:3210`). Data source: runtime/src/core/server.ts, runtime/src/ws/handler.ts, runtime/src/mcp/handler.ts, dashboard/src/app/. |
| `ai tools help` / `help ai tools` | Print the `ai tools` usage block: default behavior, sub-commands, data sources, notes on live vs fallback mode. Block is reproduced verbatim in README section "`ai tools` — Fleet Inventory Command". |

## Multi-Org

| Keyword | Action |
|---------|--------|
| `org status` | Show the current multi-org setup status. Report: active org (from `$CLAUDE_CONFIG_DIR`), authenticated config dirs (`~/.claude-museum`, `~/.claude-tech`, `~/.claude-personal`), repo→org map entries from `config/repo_org_map.txt`, `forceLoginOrgID` lockdown status. Reference: `documentation/MULTI_ORG_WORKFLOW.md`. |
| `org check` | Run the multi-org health check from `health_check.sh` (org section only). Report per-org dir: exists, authenticated, mapped repo count. |

## Gateway & API

| Keyword | Action |
|---------|--------|
| `seed schedules` | Run `./scripts/seed_schedules.sh` — idempotently seed the standard autonomous schedules (`morning_sweep_daily` 09:00 UTC, `evening_sweep_daily` 18:00 UTC) into the gateway. `--disabled` seeds them switched off. Report created/existing + the current schedule list. |
| `api docs` | Open/report the gateway API reference: `http://localhost:3200/api/docs` (self-contained HTML, offline-capable) and `http://localhost:3200/api/openapi.json` (OpenAPI 3.1 spec, 33 paths / 39 operations). If the gateway is down, the spec source is `runtime/src/core/openapi.ts`. |
