# 🧠 myAI — your AI's memory, and you own it

> **A self-owned, git-versioned AI memory + multi-agent framework. Plug any agent into your OWN portable brain so it boots already knowing your projects, decisions, and context.**

[![npm version](https://img.shields.io/npm/v/ai-management.svg)](https://www.npmjs.com/package/ai-management)
[![npm downloads](https://img.shields.io/npm/dm/ai-management.svg)](https://www.npmjs.com/package/ai-management)
[![license](https://img.shields.io/npm/l/ai-management.svg)](https://www.npmjs.com/package/ai-management)
[![docs](https://img.shields.io/badge/docs-knofler.github.io-blue.svg)](https://knofler.github.io/ai_management/)

**myAI** (`npm i -g ai-management`, CLI: `myai`) is a **self-owned, git-versioned AI memory layer** and a **multi-agent development framework** in one package. Plug any agent — Claude Code, Cursor, Gemini, Codex, opencode — into your **own portable brain** so it boots already knowing your projects, your decisions, and where you left off, instead of starting from a blank slate every session. It is **local-first** (runs in Docker on your machine), **MCP-native** (Model Context Protocol tools any agent can call), and ships an **autonomous runner**, **RAG semantic search**, a **live operations dashboard**, and **one-command app blueprints**. No SaaS account. No vendor lock-in. Your memory lives in a private git repo that you push, clone, and back up like any other.

---

## 🤔 Why myAI

Every AI coding session, your agent learns things — decisions made, gotchas hit, what shipped, what's next. Then the chat closes and it all dies. Worse:

- **Agent context dies each session.** Tomorrow's session starts from zero and you re-explain everything.
- **Memory is locked in a vendor's cloud.** Switch tools or lose your subscription and your context evaporates.
- **Every new agent starts blank.** Claude doesn't know what Cursor learned; Gemini doesn't know what Codex decided.

**myAI is the answer.** One portable brain that *you* own, served to *every* agent through a small local gateway. Sessions become git commits, `wrap up` is a merge, `main` is the single truth every agent boots from. A returning agent gets a ~300-token catch-up diff instead of re-reading everything. Bring your own credentials, run it all on your own machine, and take your context anywhere. **Honest positioning:** most "memory" tools are complementary — run myAI next to whichever you already use (see the [comparison hub](#-docs-comparisons--hands-on-guides)).

---

## ✨ Feature highlights

| | Pillar | What it gives you |
|---|--------|-------------------|
| 🧠 | **[The Brain](#-the-brain--own-your-ais-memory)** | Git-versioned agent memory you own — sessions = commits, wrap up = merge |
| 🔌 | **[Plug any agent](#-plug-any-agent-into-your-context)** | One command wires Claude / Cursor / Windsurf / Codex / Gemini / opencode into your context |
| 💻 | **[The `myai` CLI](#-the-myai-cli)** | One binary wrapping install → run → scan → scaffold → brain → backup |
| 📊 | **[Dashboard](#-dashboard--your-live-operations-console)** | A live Next.js ops console at `localhost:3210` — agents, tasks, plans, memory |
| 📱 | **[Remote management](#-remote-management--drive-the-fleet-from-your-phone)** | Drive any repo from your phone; hand off seamlessly to desktop |
| 🤖 | **[Autonomous Runner](#-autonomous-runner--work-that-ships-while-you-sleep)** | Off-hours worker drains a task queue on `test` and surfaces work for review |
| 🔌 | **[MCP servers](#-mcp-servers--plug-in-tools)** | Model Context Protocol tools: library docs, browser, containers, your API |
| 🔎 | **[RAG & memory search](#-rag--memory-search)** | Semantic search across everything you've done — local vectors, your data |
| 🤝 | **[Multi-agent handoff](#-multi-agent-handoff)** | Hand off between agents/devices; the file system is the shared memory |
| 🐳 | **[Local Docker stack](#-local-docker-stack)** | Gateway + dashboard + Mongo, memory-capped, single-tenant loopback |
| 🚀 | **[Quick-to-production](#-quick-to-production--make-prod)** | `make prod` provisions branching + CI + Vercel/Render/Atlas |
| ⭐ | **[Blueprint](#-blueprint--from-idea-to-app-in-4-steps)** | Describe an app in one sentence → full-stack scaffold |
| 💡 | **[Jam](#-jam--ideate-before-you-build)** | Collaborative ideation mode — brainstorm *before* you build |
| 🏗️ | **[Architecture](#-architecture--how-agents-coordinate)** | Parallel dispatch lanes, file ownership, state coordination |
| 📚 | **[Skills](#-skills--repeatable-playbooks)** | Repeatable playbooks that auto-trigger on your prompt |
| 🎭 | **[Agents](#-the-specialist-agents)** | Specialist subagents (frontend, API, DB, DevOps, security, QA…) |
| 🪝 | **[Hooks](#-hooks--the-session-usage-guard)** | Session Usage Guard + lifecycle hooks — never lose context again |
| 🔑 | **[Keywords](#-keywords)** | Type `agent mode`, `ship it`, `wrap up`, `yolo god` — full workflows |

---

## 📑 Table of contents

- [Quickstart (5 minutes)](#-quickstart--download--running-in-5-minutes)
- [Add myAI to any repo — one command](#-add-myai-to-any-repo--one-command-greenfield)
- **Pillars**
  - [🧠 The Brain](#-the-brain--own-your-ais-memory)
  - [🔌 Plug any agent](#-plug-any-agent-into-your-context)
  - [💻 The `myai` CLI](#-the-myai-cli)
  - [📊 Dashboard](#-dashboard--your-live-operations-console)
  - [📱 Remote management](#-remote-management--drive-the-fleet-from-your-phone)
  - [🤖 Autonomous Runner](#-autonomous-runner--work-that-ships-while-you-sleep)
  - [🔌 MCP servers](#-mcp-servers--plug-in-tools)
  - [🔎 RAG & memory search](#-rag--memory-search)
  - [🤝 Multi-agent handoff](#-multi-agent-handoff)
  - [🐳 Local Docker stack](#-local-docker-stack)
  - [🚀 Quick-to-production (`make prod`)](#-quick-to-production--make-prod)
  - [⭐ Blueprint (idea → app)](#-blueprint--from-idea-to-app-in-4-steps)
  - [💡 Jam (ideation)](#-jam--ideate-before-you-build)
  - [🏗️ Architecture](#-architecture--how-agents-coordinate)
  - [📚 Skills](#-skills--repeatable-playbooks)
  - [🎭 The specialist agents](#-the-specialist-agents)
  - [🪝 Hooks & the Usage Guard](#-hooks--the-session-usage-guard)
  - [🔑 Keywords](#-keywords)
- [🔬 Under the hood (deep dive)](#-under-the-hood-deep-dive)
- [🛠️ For framework operators / self-hosters](#-for-framework-operators--self-hosters)
- [📚 Docs, comparisons & hands-on guides](#-docs-comparisons--hands-on-guides)
- [🔗 Connect Hub](#-connect-hub--help-desk-bug-reports-feature-requests)
- [🔧 Maintenance & contributing](#-maintenance--contributing)

---

## ⚡ Quickstart — download → running in 5 minutes

> Self-hosted, single operator, your own Anthropic key. No SaaS account, no lock-in.
> **Prerequisites:** Docker Desktop (running), Node 20+, git. Optionally the Claude CLI logged in (`claude`) instead of an API key.

```bash
# 0. npm preflight — a root-owned npm prefix (Homebrew/OS-bundled Node) fails
#    the next line with a raw EACCES. Check + redirect to ~/.local if needed:
p="$(npm config get prefix)"; [ -w "$p" ] || { npm config set prefix "$HOME/.local"; export PATH="$HOME/.local/bin:$PATH"; }

# 1. Install the CLI (one binary: `myai`, aliased `ai-manage`)
npm i -g ai-management

# 2. Preflight — checks docker, node, compose, ports, your key
myai doctor

# 3. Initialize the framework into a repo (this one, or any path)
#    The guided wizard asks 3 things: API key · profile · scan dir.
#    It writes them to AI/.env. Press Enter to skip any answer.
myai init .

# 4. Bring the self-contained stack up (gateway + dashboard + mongo)
#    Waits for health, then prints the dashboard URL.
myai up
#    → Dashboard   http://localhost:3210
#    → Gateway MCP http://localhost:3100/mcp

# 5. Register the repos you want to manage (RAG + directory)
myai scan ~/code --register

# 6. (optional) Generate a brand-new full-stack app from one sentence
myai new-app ~/code/my-idea
```

Open **http://localhost:3210/welcome** — with `MYAI_EDITION=independent` (the wizard's default profile) the page greets you with the local quickstart and one-tap links into the running dashboard. Queue a task from **Work → Queue**; the off-hours runner builds it and surfaces it in **Needs Review** for your `ship it`.

**Bring-your-own credentials.** Set `ANTHROPIC_API_KEY` during `myai init` (or any time in `AI/.env`), or skip it and let the runner use your logged-in Claude CLI. No keys ship in the package. Re-run `myai init . --no-wizard` for a non-interactive scaffold (CI/scripts).

**Tear down / scripted runs:** `myai down` (add `--volumes` to drop the mongo data). `myai init <path> --wizard` forces the wizard even when piped.

---

## 🌱 Add myAI to any repo — one command (greenfield)

> The end-user path. No `AI/` folder, no boilerplate — the package **is** the framework.

```bash
# 0. npm preflight — check + redirect to ~/.local if the prefix isn't writable
p="$(npm config get prefix)"; [ -w "$p" ] || { npm config set prefix "$HOME/.local"; export PATH="$HOME/.local/bin:$PATH"; }

# 1. Install the framework as a global module (once per machine)
npm i -g ai-management

# 2. Initialize any git repo — this is all it takes
cd /path/to/your/repo
myai init
```

Greenfield `myai init` (the **default** for any end-user repo) drops **exactly two
artifacts** and nothing else:

- **`CLAUDE.md`** — a ~30-line kernel (committed). Points identity at your brain,
  points the framework at the installed module (`myai root`), lists the boot
  protocol. No policy bodies, no secrets — the only committed framework file.
- **`.myai-local`** — a gitignored per-repo pointer (namespace id, gateway hint,
  cached identity blurb for degraded boot). The `.gitignore` rule is appended
  automatically; the pointer is never committed.

Agents, skills, hooks, rule bodies, and the PreToolUse safety rails (no push to
`main`, no secret commits, Docker-only npm) all resolve at runtime from the
installed module — a kernel-only repo behaves identically to a scaffolded one.
First-ever `myai init` also bootstraps your brain (`~/.myai/brain`, one per user)
and can wire a private remote so later machines auto-clone it.

Then open the repo in your agent and type `agent mode` — it boots from the brain
via `context_boot`. Re-running `myai init` is always a safe no-op (never clobbers a
user-edited `CLAUDE.md`).

**Verify a kernel-only repo is healthy:**
```bash
myai root/scripts/lint_myai_init.sh /path/to/your/repo   # exit 0 = GREEN
./scripts/health_check.sh /path/to/your/repo             # kernel-only repo → all checks pass
```

> **Migrating an already-scaffolded repo** (one with a committed `AI/` folder)? That
> is a different, reversible track — see [`documentation/MYAI_MIGRATION_GUIDE.md`](./documentation/MYAI_MIGRATION_GUIDE.md).
> Use `myai init --managed` to force the legacy `AI/`-scaffold for operator/fleet repos.

---

## 🧠 The Brain — own your AI's memory

**This is the heart of myAI: git-versioned agent memory that you own.**

Every session your agent learns things — decisions made, gotchas hit, what shipped, what's next. Normally that dies when the chat closes. **The Brain keeps it — in a private git repo you own.**

- **Sessions are commits. `wrap up` is a merge. `main` is the single truth every agent boots from.** A returning agent gets a ~300-token `brain_delta` catch-up diff instead of re-reading everything.
- **It lives at `~/.myai/brain`**, separate from your code, **one per person.** Push it to a private remote, clone it on any machine, `myai backup` / `myai restore` it. No SaaS lock-in.
- **Reading needs no server.** `merge` auto-distills each namespace's boot artifacts as plain files — `brief.md` (~150-token boot brief), `working.md` (~2k working context), `rollup.md` (one line per atom). `git pull` → read files works offline.
- **Conflict-free by design.** Memory is append-only "atoms" — one immutable file each, filenames embed a content hash — so parallel agents on different devices merge without conflict. Re-writing an identical atom is a no-op (dedup by hash); changed content is a NEW atom; history is never edited.
- **Stash crosses devices.** `myai brain stash` freezes in-flight context straight to `main` (not a local ref like `git stash`), so ANY later session on ANY device can `pop` it after a plain pull.

### Why it matters

Your context is the most valuable thing you build with an AI — and today it's trapped in someone else's cloud, gone the moment a chat closes or a subscription lapses. The Brain makes it a portable, versioned asset you carry between machines, tools, and even AI vendors. Switch from Claude to Cursor to Gemini and they all boot from the *same* memory.

### How to use it

The brain is a real private git repo, driven by `myai brain <verb>`:

```
init | status | write | stash | pop | branch | checkout | merge |
log | diff | blame | revert | session start/merge | distill
```

`stash` freezes context on `main` so any later session on any device can `pop` it; `merge` auto-distills the ~150-token boot briefs as plain files. Add `--remote git@yourhost:you/brain.git` on `init` to sync it between machines — it's just git.

**Prove it in 5 minutes** — no Docker, no gateway, no API key required. The scripted walkthrough (`init → work → stash → pop from a second agent → merge → diff`, against a throwaway brain that never touches your real one) ships in the npm package: **[`TRY_BRAIN.md`](./TRY_BRAIN.md)**.

Keyword muscle memory over the gateway's `brain_*` MCP tools: `brain status`, `brain commit`, `brain stash` / `brain pop`, `brain branch` / `brain checkout`, `brain merge` (what `wrap up` calls), `brain log`, `brain diff`, `brain delta` (what `agent mode -min` boots with), `brain blame`, `brain revert`.

---

## 🔌 Plug any agent into your context

**`myai` runs a small LOCAL gateway that exposes your brain, memory, tasks, and repos as tools any agent can call.** On its first handshake the agent calls `context_boot` and answers "who am I working with?" from YOUR context — not a blank slate.

One command wires it up:

```bash
myai plug            # lists every supported agent + its one-liner
myai plug claude     # (or cursor / windsurf / codex / gemini / opencode)
myai plug proof      # live continuity round-trip with NO agent installed
```

Two tiers, so *any* agent connects:

- **Cooperating (MCP) tier** — `claude | cursor | windsurf | codex | gemini | opencode`. These auto-boot on the `initialize` handshake + a `context_boot` recall round-trip, pointed at the local gateway with the local token. Merge, never clobber; idempotent.
- **Wrap-it tier** — `ollama | chatgpt | print`. A context bundle is prepended for a blank agent that can't speak MCP.

### Why it matters

Plugging an agent in means it opens **already knowing you**. Semantic search across everything you've done (`memory_search` / `recall_session`) surfaces the right past decision on demand — **local vectors, your data.** And reading needs no cloud: briefs distill to plain files, so `git pull → read` works offline. Your context becomes a shared substrate that every tool in your kit draws from.

### Non-Claude proof

Real, verified connect configs live in `examples/agents/` — a Gemini CLI + opencode connect config and a raw Ollama shim (`context_boot` → system preamble), verified live against the gateway. Under the hood, `myai plug` routes to `myai connect-agent` (MCP tier) or `myai shim` (wrap-it tier).

---

## 💻 The `myai` CLI

The framework ships an npm CLI — `ai-management` — that wraps the most-used operations behind a single binary (`myai`, aliased `ai-manage`). It is a thin dispatcher: each subcommand shells into the existing `scripts/*.sh` (or `docker compose`), so the bash playbooks remain the single source of truth.

```bash
myai --help          # list all commands
myai doctor          # preflight checks (node, docker, compose, scripts, git)
                     #   --json → {checks:[{label,status,detail}],ok} for CI/scripts
myai init <path>     # initialize the framework into a project   → scripts/myai_init.sh
                     #   DEFAULT = greenfield: drops only a ~30-line kernel CLAUDE.md
                     #   + gitignored .myai-local (no AI/ folder — framework resolves
                     #   from the installed module). --managed forces the legacy AI/
                     #   scaffold (operator/fleet repos; master auto-detected).
                     #   --greenfield to force greenfield. --force overwrites a
                     #   user-edited (non-kernel) CLAUDE.md. Guided first-run wizard on
                     #   a TTY; --no-wizard to skip, --wizard to force.
myai root            # print the installed module path            → scripts/myai_root.sh
                     #   ≈ $(npm root -g)/ai-management. Kernel-only repos
                     #   resolve agents/skills/hooks/rules from here.
myai up              # self-contained stack live on localhost     → scripts/myai_up.sh
                     #   gateway + dashboard + mongo, single-tenant loopback (no auth
                     #   friction), waits for health, prints the dashboard URL.
                     #   Flags: --build, --full, --runner, --no-wait, --timeout <s>
myai down            # stop the stack cleanly (--volumes drops data) → scripts/myai_down.sh
myai status          # inspect the running stack                  → scripts/myai_status.sh
                     #   gateway/dashboard /health, docker compose ps, task-queue counts
                     #   (pending/working/review/blocked/done via the local-token gateway).
                     #   Flags: --json (machine-readable), --repo <name>. Exit 0 = healthy,
                     #   so it doubles as a poll target for scripts.
myai logs [service]  # tail stack logs (docker compose logs -f)   → scripts/myai_logs.sh
                     #   all services or one of gateway | dashboard | mongo.
                     #   Flags: --no-follow (print + exit), --tail <n> (default 100)
myai queue [verb]    # inspect/control the runner task queue       → scripts/myai_queue.sh
                     #   CLI mirror of the dashboard /work orchestration view.
                     #   `queue` / `queue list` [--repo][--status][--priority][--all][--json]
                     #   (done hidden by default); `queue cancel <taskId>` [--reason][--force]
                     #   marks it blocked (reversible — requeue via tasks_update
                     #   {status:pending}); `queue reprioritize <taskId> <P0|P1|P2|P3>`.
myai scan <path>     # spider git repos → register + seed awareness → scripts/myai_scan.sh
                     #   walks <path>, finds every git repo (skips node_modules/vendored),
                     #   upserts each into the gateway app-directory (repos_card) + seeds RAG
                     #   awareness (memory_store), prints a summary table. Idempotent.
                     #   Flags: --register (add to managed_repos.txt), --max-depth <n>,
                     #          --no-rag, --no-cards, --dry-run, --json
myai demo            # seed realistic sample data                 → scripts/myai_demo.sh
                     #   6 tasks (all statuses) · 2 disabled schedules · a 5-day plan ·
                     #   3 repo cards · 3 memory vectors · 8 budget rows — so the
                     #   first-run dashboard is alive, not a wall of empty panels.
                     #   Idempotent; every row is demo-tagged and fully removable.
                     #   Flags: --clean (remove all demo rows), --force (re-seed)
myai new-app <path>  # scaffold a full-stack blueprint app        → scripts/init_blueprint.sh
myai connect <path>  # install the Connect Hub module             → scripts/init_connect.sh
myai plug [agent]    # plug ANY agent into your brain — ONE front door → scripts/myai_plug.sh
                     #   `myai plug` lists every agent + its one-liner; `myai plug <agent>`
                     #   routes to the right tier and forwards extra flags; `myai plug proof`
                     #   runs the live continuity round-trip with NO agent installed.
                     #   Cooperating (MCP) tier: claude|cursor|windsurf|codex|gemini|opencode
                     #   — auto-boot on the `initialize` handshake + `context_boot` recall.
                     #   Wrap-it tier: ollama|chatgpt|print — bundle prepended for a blank
                     #   agent. Under the hood → myai connect-agent / myai shim (below).
myai connect-agent   # cooperating (MCP) tier of `myai plug`        → scripts/myai_connect_agent.sh
                     #   prints/installs MCP config for Claude Code (./.mcp.json), Cursor,
                     #   Windsurf, Codex CLI — pointed at the local gateway with the local
                     #   token — then verifies the hookup live: `initialize` (betaC
                     #   auto-boot rides in on instructions) + a `context_boot` round-trip
                     #   ("who am I working with?" → operator context). Merge, never
                     #   clobber; idempotent. Args: claude|cursor|windsurf|codex|all.
                     #   Flags: --install (write config), --verify (check only), --no-verify
                     #   Non-Claude proof: examples/agents/ — Gemini CLI + opencode
                     #   connect configs and a raw Ollama shim (context_boot → system
                     #   preamble), verified live against the gateway.
myai schedule ...    # queue an autonomous task for the runner    → scripts/schedule_task.sh
myai login           # authenticate against a HOSTED gateway      → scripts/myai_login.sh
                     #   validates a per-tenant API key (myai_live_… / myai_test_…) via
                     #   GET /api/auth/whoami before persisting anything — non-secret
                     #   identity (gatewayUrl/tenantId/org/plan) goes to ~/.myai/config,
                     #   the raw key to ~/.myai/credentials (chmod 600). Distinct from
                     #   `myai config` (raw key setting, no validation) and tenant-key
                     #   rotation (operator CRUD). Flags: --key <apiKey> (or $MYAI_API_KEY,
                     #   or an interactive hidden prompt), --gateway-url <url>, --json.
myai whoami          # show the active org/tenant/plan/quota       → scripts/myai_whoami.sh
                     #   round-trips to the gateway every time (never trusts cached
                     #   identity) so quota numbers are live. Requires `myai login` first.
                     #   Flags: --gateway-url <url>, --json.
myai runner <verb>   # manage the local off-hours runner schedule → scripts/myai_runner.sh
                     #   install [--every-minutes N|--every-hours N] | uninstall | start |
                     #   stop | status (+ next-fire) | logs [-f] [-n N] — launchd (mac) /
                     #   systemd or cron (linux). Distinct from `myai status`/`myai logs`
                     #   (gateway health) — this controls the local worker.
myai brain <verb>    # git-versioned agent memory                 → scripts/myai_brain.sh
                     #   the brain is a real private git repo SEPARATE from code git:
                     #   sessions = commits, wrap up = merge, `main` = the truth every
                     #   agent boots from. Verbs: init | status | write | stash | pop |
                     #   branch | checkout | merge | log | diff | blame | revert |
                     #   session start/merge | distill. `stash` freezes context on main
                     #   so ANY later session on ANY device can `pop` it; `merge`
                     #   auto-distills ~150-token boot briefs as plain files (reading
                     #   needs no server — git pull → read files). 5-minute scripted
                     #   walkthrough: TRY_BRAIN.md (ships in the npm package).
myai memory ...      # portable memory bundle                     → scripts/myai_memory.sh
                     #   export [dir] pulls the corpus (state/handoff/pattern source
                     #   texts) as JSON manifest + markdown; import <dir> re-embeds on
                     #   this gateway with dedup-by-hash.
myai context ...     # FULL portable context bundle                → scripts/myai_context.sh
                     #   export [dir] tars memory corpus + vectors (embeddings) + brain
                     #   atoms + ~/.myai config into ONE versioned, checksummed,
                     #   secret-redacted myai-context-<host>-<ts>.tar.gz; import <arc>
                     #   verifies integrity (CHECKSUMS.sha256) then re-imports — memory
                     #   always (idempotent), brain/config opt-in. import-external <src>
                     #   ingests FROM ChatGPT/Claude export, Obsidian, markdown, or a raw
                     #   vector store (re-embed + dedup-by-hash, tenant-scoped) — the
                     #   bring-your-existing-context on-ramp. Own + download your whole
                     #   context. Superset of memory + backup.
myai backup [dir]    # snapshot brain + config to a dated archive  → scripts/myai_backup.sh
                     #   tars the WHOLE git-versioned brain repo (history intact) plus
                     #   the ~/.myai config files (config, brain.path) into one
                     #   myai-backup-<host>-<ts>.tar.gz. --out <file> for an exact path,
                     #   --quiet to print only the path. No gateway/network needed.
myai restore <arc>   # restore a backup archive                    → scripts/myai_restore.sh
                     #   unpacks brain → THIS machine's resolved brain dir (or --to <dir>)
                     #   + config → ~/.myai. Machine-agnostic (paths re-resolved, brain.path
                     #   repointed). Refuses to clobber a non-empty target without --force
                     #   (existing state moved to .bak-<ts>, never deleted); --dry-run previews.
```

**Docker-only / no host build:** the CLI has zero *required* runtime dependencies. It uses [`commander`](https://www.npmjs.com/package/commander) for help + parsing when installed, and falls back to a built-in parser otherwise — so `myai --help` and `myai doctor` work even before `npm install` runs. Smoke check: `./scripts/smoke-cli.sh` (validates `--help`, `--version`, `doctor`, and `npm pack`).

---

## 📊 Dashboard — your live operations console

`myai up` brings up a **Next.js 15 operations console** at **http://localhost:3210**. It's the human window into everything the framework is doing — no CLI required.

| Path | Page |
|------|------|
| `/` | Status home — gateway health, counts, recent activity |
| `/agents` | Browse all 64 agents |
| `/skills` | Browse all 136 skills with trigger search |
| `/hooks` | Registered hooks + event bindings |
| `/rules` | Governance rules (AI_RULES, routing, design) |
| `/repos` | your managed repos — health grid by workspace |
| `/sessions` | Active + historical gateway sessions |
| `/sona` | SONA analytics (confidence, usage, categories) |
| `/patterns` | SONA pattern browser |
| `/api/health` | Dashboard-side health check |
| `/api/agents/:name` | Agent detail (proxies gateway) |
| `/api/skills/:name` | Skill detail (proxies gateway) |

Plus the operations views the runner and scheduler drive:

- **`/plan`** — every repo's 10-day plan table (Day · Fires UTC→Sydney · Focus · Status).
- **`/schedule`** — Scheduled Runs (with **Repo** column) above the priority-ordered **Up Next** queue + **Needs Review**.
- **`/directory`** — one-point app pointer (localhost/app/api/Vercel/DNS URLs + Mongo + last status); self-updated by each repo on `wrap up`.
- **`/budgets`** — cost/budget dashboard when budget guards are enabled ([see below](#layer-2-cost-aware-llm-routing-gateway--implemented)).
- **`/fleet`** — cross-repo orchestration snapshot; the Fleet Morning Console.

Seed it with realistic sample data so the first run isn't empty: `myai demo` (idempotent, `--clean` to remove).

**Production URL:** `https://ai-management-one.vercel.app/`

---

## 📱 Remote management — drive the fleet from your phone

Work on any repo from your phone, then continue seamlessly from your desktop — and vice versa. Every repo is fully self-contained with state, agents, skills, and documentation, so opening any repo on any device gives you full context immediately.

The remote-fleet tooling lets you see who's live where and open phone-drivable sessions:

| Keyword | What it does |
|---------|--------------|
| `remote status` | Which repos have live claude sessions + profile (anti-duplication view). Runs `./AI/scripts/remote_fleet.sh status`. |
| `remote start [all\|core\|repo…\|--last-start]` | Open a phone-drivable `claude-museum` session per repo (iTerm tab, duplicate-guarded, `--max` RAM cap; records what it launched). |
| `remote stop [repo…\|--last-start]` | Kill museum sessions only — never interactive shells. |

**Anchor rule:** the master-AI session is NEVER stopped — it's the phone's doorway to `remote start` the fleet back (override: `--include-anchor`). `stop --last-start` undoes only the last start's launches; `start --last-start` reopens exactly that recorded set (record never rewritten, so the pair toggles the same set). Repo set: `config/remote_fleet.txt`.

Telegram is wired too — `telegram setup` / `telegram start` connect a bot channel to the gateway. See the full [CLI-Mobile workflow](#cli-mobile-agent-workflow-codeclot) under operator docs for the branch-sync mechanics.

---

## 🤖 Autonomous Runner — work that ships while you sleep

There is **one standard way** to schedule autonomous work in any repo: create **tasks** in the gateway queue, which the **launchd CLI runner** (every few hours, free Fable window, `claude-tech`, subscription-billed, **0 API tokens**) works on a `test` branch and flips to **Needs Review** for your `ship it`. **Never** use gateway cron schedules or Claude Code cloud routines for per-repo work — they fragment the view and/or bill tokens.

> **⏰ Off-hours policy:** autonomous runs fire only when you're not in interactive sessions — **weekdays 6pm–9am Sydney, and all weekend**. The runner no-ops during weekday 9am–6pm (override a one-off with `--force`). Plan fire times on `/plan` are clamped into this band (default 8pm Sydney). Tunable via `WORK_HOURS_START`/`WORK_HOURS_END`.

### Why it matters

Queue the work you'd rather not babysit, walk away, and come back to branches built and waiting for review. Zero API cost when routed through your logged-in CLI subscription, and everything lands on `test` first — nothing autonomous ever touches `main`.

### The keyword to type in ANY repo

```
schedule plan
```

Runs the **mythos-grade planning protocol** (planning only — builds nothing):

1. **Writes `AI/plan/MYTHOS_IMPROVEMENT_PLAN.md`** — an ambitious, opinionated improvement & feature plan: tooling, tracking, service & integration, functionality, UX/web design, user journey, practical use cases.
2. **Posts a 10-day schedule** via the gateway `plan_set` MCP tool → renders as a table on the dashboard **`/plan`** page (Day · Fires UTC→Sydney · Focus · Status), one focus per day (fires ≈9am Sydney).
3. **Schedules the work** — creates session-sized tasks (`./AI/scripts/schedule_task.sh`, `--model claude-fable-5`) the CLI runner executes across the next 10 days.

### Other scheduling keywords

| Keyword | What it does |
|---------|--------------|
| `schedule plan` | Full mythos plan + 10-day dashboard schedule + queued tasks (above). **The one to type in any repo.** |
| `schedule <description>` / `schedule task` | Queue a single autonomous task for this repo (`schedule_task.sh`). |
| `schedule list` / `what's scheduled` | Show this repo's queue (`schedule_task.sh --list`; `--list-all` for the fleet). |

### Installing the runner on a machine (per-machine worker)

The CLI runner is a per-machine *worker* — the shared queue lives in the gateway, but each Mac/Linux box that should work it needs the schedule installed once. One entry point on every platform:

```bash
./scripts/setup_cli_runner_schedule.sh                    # install — fires every 10 minutes
./scripts/setup_cli_runner_schedule.sh --every-minutes 5  # custom cadence
./scripts/setup_cli_runner_schedule.sh --status           # timer state + last session log
./scripts/setup_cli_runner_schedule.sh --uninstall        # remove
```

- **macOS** → a launchd user agent (`com.myai.cli-task-runner`). Keep the box awake on AC power: `sudo pmset -c sleep 0`.
- **Linux / VPS** → the entry point auto-routes (same flags) to `scripts/setup_cli_runner_linux.sh`: a **systemd user timer** (`myai-cli-runner.timer`) when the user manager is reachable, otherwise a **crontab entry** with a managed marker (WSL1, minimal containers, non-systemd distros). Force a backend with `--systemd` / `--cron`. On a headless box run `loginctl enable-linger $USER` once so the timer survives logout — the installer reminds you when lingering is off.
- **Windows** → **best-effort tier**, two paths (full guide: `documentation/WINDOWS_RUNNER.md`). **Recommended: WSL2** — inside WSL2 the entry point routes to the Linux/systemd installer unchanged; add a `myai-wsl-keepalive` logon task so the WSL VM (and its timer) stays up. **Experimental: native Task Scheduler** — `scripts/setup_cli_runner_windows.ps1` registers a `schtasks` job (`myai-cli-task-runner`, same 10-min cadence, mirrored `-Status`/`-Uninstall` verbs) that fires the runner via Git Bash through a hidden-window wrapper; runs only while logged on and isn't CI-tested. Running the bash entry point from Git Bash prints these options and exits.

The cadence installer only controls *when* fires happen; the slot/backoff semantics (up to `MAX_CONCURRENT` = 5 parallel tasks, 30-minute backoff when all slots are busy, weekday 6pm–9am + weekend off-hours guard) live in `cli_task_runner.sh` and are identical on both platforms. Silence a machine that should never be a worker: `touch ~/.ai-cli-runner/.no-runner`.

You can also manage the runner from the CLI directly: `myai runner install | uninstall | start | stop | status | logs`.

Full protocol reference: `documentation/KEYWORDS_REFERENCE.md` → **Scheduling**. Helper scripts: `scripts/schedule_task.sh`, `scripts/repo_card.sh`.

---

## 🔌 MCP servers — plug in tools

MCP (Model Context Protocol) servers extend Claude Code — and any MCP-capable agent — with specialised tools: library docs, browser automation, container management, component browsing, and more. Configs are auto-managed and propagated to all managed repos via `update_all.sh`.

### Installed (No API Key Required)

#### Base — All Projects
These are installed in every managed repo via `templates/mcp.json` → `.mcp.json`.

| Server | Package | Purpose | Tools |
|--------|---------|---------|-------|
| **Context7** | `@upstash/context7-mcp` | Version-specific library docs in-context (Next.js, React, Mongoose, Tailwind, etc.) | `resolve`, `get-library-docs` |
| **shadcn/ui** | `@jpisnice/shadcn-ui-mcp-server` | Browse, search, install shadcn components directly from Claude Code | `browse`, `search`, `install` |
| **Playwright** | `@playwright/mcp` | E2E browser testing — navigate pages, click elements, fill forms, assert content, take screenshots. Use for testing Vercel preview URLs before merging PRs | `navigate`, `click`, `fill`, `screenshot`, `expect`, +20 more |
| **Dropbox** | `https://mcp.dropbox.com/mcp` (remote) | Read, search, create files in Dropbox — OAuth auto-handled | `list`, `search`, `read`, `create` |
| **GitHub** | `@modelcontextprotocol/server-github` | Repo, issue, PR, branch, release management against the repo's `origin` remote. Needs `GITHUB_PERSONAL_ACCESS_TOKEN` env (one-time: `export GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token)`) | `create_issue`, `create_pull_request`, `list_commits`, `search_repositories`, +20 more |
| **Vercel** | `https://mcp.vercel.com` (remote) | Deployment status, env vars, log streaming — OAuth-scoped per Vercel account, sees all your projects | `list_deployments`, `get_deployment`, `list_env_vars`, `read_logs`, +more |
| **myai** | Local gateway (`localhost:3100`) | MCP interface to the myAI gateway (when Docker is running) | Varies by gateway version |

> **Back-compat note:** this server's `.mcp.json` key was renamed from `ai-framework` to `myai` (task-887c7fcb, 2026-07-24) to match the repo/package/CLI name. Existing installs pick up the new key on next `myai init`/`myai mcp sync` or a fresh `.mcp.json` propagation; if Claude Code shows the server as disconnected after pulling this change, restart Claude Code so it re-reads `.mcp.json`. Tool calls are unaffected — only the connection label changed, not `brain_*`/other tool names.

#### Conditional — Auto-Detected by `update_all.sh`
These are merged into `.mcp.json` only when the project matches the detection condition.

| Server | Package | Condition | Purpose | Tools |
|--------|---------|-----------|---------|-------|
| **Chrome DevTools** | `@anthropic-ai/chrome-devtools-mcp-server` | Has `next.config.*`, `vercel.json`, or `src/app/layout.tsx` | Browser console logs, network requests, screenshots, performance profiling | `console`, `network`, `screenshot`, `evaluate` |
| **Docker** | `docker-mcp` | Has `docker-compose.yml` | Container logs, exec into containers, manage containers. Uses `{folderName}-*` naming convention per AI_RULES | `sandbox_exec`, `run_js`, `mcp-exec`, `mcp-find`, `search_npm_packages` |
| **OpenAPI** | `openapi-mcp-server` | Has `src/app/api/`, `src/routes/`, or `routes/` | Exposes API endpoints as MCP tools from OpenAPI spec. Claude can discover and call your API directly | Auto-generated from OpenAPI paths |

#### User-Level — Installed per Machine
These are installed via Claude Code plugins or browser extensions, not managed by `update_all.sh`.

| Server | Source | Purpose | Tools |
|--------|--------|---------|-------|
| **Claude in Chrome** | Chrome browser extension | Full browser automation — navigate, click, fill forms, read pages, record GIFs, execute JavaScript, read console/network | `navigate`, `read_page`, `form_input`, `javascript_tool`, `gif_creator`, `tabs_create_mcp`, `read_console_messages`, `read_network_requests`, +10 more |
| **Google Drive** | Claude Code OAuth integration | Read and access Google Drive files | `authenticate`, `complete_authentication` |

### Planned (API Key Required)

Add these by setting the API key in each project's `.env`. Once available, add to `templates/mcp.json` (all repos) or project-specific `.mcp.json`.

| Server | Package | Purpose | Priority |
|--------|---------|---------|----------|
| **Brave Search** | `@anthropic-ai/brave-search-mcp-server` | Web search from Claude sessions | High |
| **Figma** | `@anthropic-ai/figma-mcp-server` | Read designs, components, variables | High |
| **Sentry** | `@sentry/mcp-server` | Error tracking, issue management | High |
| **MongoDB Atlas** | `@anthropic-ai/mongodb-mcp-server` | Direct Atlas queries and management | Medium |
| **Upstash** | `@upstash/mcp-server` | Serverless Redis, Kafka, QStash | Low |
| **Notion** | `@anthropic-ai/notion-mcp-server` | Pages, databases, blocks access | Low |
| **Slack** | `@anthropic-ai/slack-mcp-server` | Channel messaging, workflows | Low |

Full details and setup instructions: `plan/MCP_SERVERS.md`

### How MCP Configs Are Managed

```
templates/mcp.json          ← Base config (myai, Context7, shadcn, Playwright, Dropbox, GitHub, Vercel) → all repos
templates/mcp-web.json      ← Chrome DevTools overlay → merged if Next.js/Vercel detected
templates/mcp-docker.json   ← Docker overlay → merged if docker-compose.yml detected
```

**Propagation flow:**
1. Edit templates in this master repo
2. Run `./scripts/update_all.sh`
3. Script copies base to `<repo>/.mcp.json`, then merges overlays based on detection
4. Uses `jq` (preferred) or `python3` fallback for JSON merging
5. Claude Code reads `.mcp.json` on session start — servers are available immediately

**Adding a new MCP server to all repos:**
1. Add the server block to `templates/mcp.json`
2. Run `./scripts/update_all.sh`
3. All your managed repos get it on next sync

**Adding per-project only:**
1. Edit `<project>/.mcp.json` directly
2. `update_all.sh` won't overwrite project-specific additions (it merges, not replaces)

### On `agent mode` — MCP Awareness

When `agent mode` runs in any repo, it reports which MCP servers are active by reading `.mcp.json`. This ensures the agent knows what tools are available before dispatching work.

---

## 🔎 RAG & memory search

Semantic search across everything you've ever done — **local vectors, your data, no cloud round-trip.** When you `myai scan ~/code --register`, the framework embeds each repo's state, handoff, and archive into the gateway's central vector store. From then on, any agent can pull the *right* past decision on demand instead of you re-explaining it.

Two search surfaces, exposed as both REST endpoints and MCP tools:

| Tool | What it does |
|------|--------------|
| `memory_search` | Semantic search across all repos' vectors |
| `recall_session` | Semantic recall over the session corpus (state + handoff + archive); ranked blocks, `since`/`repo` filters |
| `memory_store` | Embed + store a chunk (dedupes by content hash) |
| `memory_context` | Pre-built context block (handoff + state + patterns) |
| `memory_stats` | Vector counts per repo / source |
| `memory_reindex` | Re-embed a repo's corpus into the central store |

REST equivalents live on the gateway's `:3200` surface (`POST /api/memory/search`, `POST /api/vectors/search`, `GET /api/vectors/stats`, `POST /api/vectors/index`) — see [Gateway Routes](#gateway-routes--endpoints).

When the `RAG_RECALL=1` flag is set and the session-start hook reports `RAG RECALL: ON`, `agent mode` prefers semantic `recall_session` over plain grep for looking up older sessions. Managed repos use the master gateway over the network — they don't run their own vector store, so all embeddings flow through one place. `wrap up` calls `memory_reindex` to keep the corpus current.

You can also carry your corpus between machines or import an existing one: `myai memory export/import` (corpus only) and `myai context export/import` (full bundle incl. vectors + brain), plus `myai context import-external` to ingest FROM a ChatGPT/Claude export, Obsidian, markdown, or a raw vector store — the bring-your-existing-context on-ramp.

---

## 🤝 Multi-agent handoff

The file system is the shared memory, so **handing off between agents, sessions, and devices is always safe.** Switch from Claude to Gemini mid-project, pick up tomorrow on a different machine, or recover instantly when an agent hits a rate limit — the next agent reads the state and continues from exactly where the last one stopped.

### When to hand off

- **End of day** — save state so tomorrow's agent (same or different) picks up cleanly
- **Credit exhaustion** — agent hits token/API limit mid-session, switch to another
- **Specialist swap** — e.g. Gemini for document writing, Claude for code generation
- **Any time** — the file system is the shared memory, so handoff is always safe

### Save state — tell the current agent

```markdown
handoff
```
Or the full version:
```markdown
Save state and prepare for handoff. Update AI/state/STATE.md with current progress and blockers. Write AI/state/AI_AGENT_HANDOFF.md with clear instructions for the next agent including what's done, what's in progress, and what to do next.
```

### Pickup — start the next agent

If the agent has an instruction file (CLAUDE.md, GEMINI.md, etc.), just type:
```
agent mode
```

If the agent is new and doesn't have its instruction file yet, use:
```markdown
Read AI/state/STATE.md and AI/state/AI_AGENT_HANDOFF.md to sync state. Read AI/documentation/AI_RULES.md for tech mandates and AI/documentation/MULTI_AGENT_ROUTING.md for routing. Report what's done, in progress, and next priority. Update STATE.md after every task.
```

### Mid-session credit exhaustion

**The problem:** AI agents (especially Claude) hit API rate limits mid-session with zero warning. The session dies, context is lost, no handoff is saved. You wait hours.

**The solution: Session Usage Guard** automatically detects approaching limits and forces a clean handoff before the session dies. See [Hooks & the Session Usage Guard](#-hooks--the-session-usage-guard) below for full details.

**Manual handoff** (if usage guard hasn't triggered yet):
1. Tell it: `wrap up` (saves state + handoff)
2. Open the next agent (e.g. switch from Claude to Gemini)
3. Tell it: `agent mode` (reads state and continues)

The handoff files capture exactly where you left off — the new agent picks up from the same point.

### The "Start Work" prompt (everyday multi-agent mode)

*Use this prompt **every time** you open an AI agent in a project that has the `AI/` framework. It synchronizes state, activates all 64 specialist subagents, and dispatches work in parallel lanes automatically.*

```markdown
You are operating in multi-agent mode with 64 specialist subagents available.

**Step 1 — Synchronize state:**
Read the following files in order:
1. `AI/state/STATE.md` — current project progress, blockers, and last stopping point
2. `AI/state/AI_AGENT_HANDOFF.md` — specific instructions from the previous session
3. `AI/documentation/AI_RULES.md` — global tech mandates (Docker, Next.js, MongoDB, Render, Vercel, GitHub Actions)
4. `AI/documentation/MULTI_AGENT_ROUTING.md` — routing reference for all specialists

**Step 2 — Assess and report:**
Based on STATE.md, tell me:
- What was completed last session
- What is currently in progress or blocked
- What the next priority is

**Step 3 — Dispatch specialists in parallel:**
Based on the current project state and next priority, identify which parallel lanes apply and dispatch the relevant specialists simultaneously:
- Lane A (Frontend): `frontend-specialist` + `ui-ux-specialist`
- Lane B (Backend): `api-specialist` + `database-specialist`
- Lane C (Infrastructure): `devops-specialist` + `security-specialist`
- Lane D (Async, always): `documentation-specialist` + `solution-architect` + `project-manager`
- Cross-lane: `tech-lead` (reviews) + `qa-specialist` (tests)

Only sequence work when a specialist's output is a required input for another. Parallel is the default.

**Step 4 — Log and maintain state:**
After every completed task, autonomously update `AI/state/STATE.md` and log actions to `AI/logs/claude_log.md` (or `AI/logs/gemini.md` / `AI/logs/copilot.md`). Do not wait for me to ask.
```

### **Lightweight version** *(for quick sessions or follow-up prompts)*
```markdown
Read AI/state/STATE.md and AI/state/AI_AGENT_HANDOFF.md to sync state. Check AI/documentation/MULTI_AGENT_ROUTING.md and dispatch the relevant specialist agents in parallel for the next priority. Update STATE.md after every task without being asked.
```

### `agent mode -a` — auto-mode flag

Run `agent mode -a` (or `--auto`) instead of `agent mode` to combine the full startup with autonomous-execution mode in one keyword. The agent does standard `agent mode` (project identity, git sync, multi-machine check, state read, status report, lane dispatch) and then automatically activates **YOLO god** as the final step.

From that point: no questions, no permission prompts, just maximum-velocity execution against the priorities reported in the status step. All YOLO safety rails preserved (no push to main, no secret commits, no destructive ops without explicit ask, 4h hard cap).

Same effect as typing `agent mode` then `yolo god` separately — just one keyword.

---

## 🐳 Local Docker stack

`myai up` brings up a **self-contained, single-tenant stack on localhost** — gateway + dashboard + Mongo — waits for health, and prints the dashboard URL. No auth friction (loopback-scoped), no external services. Everything runs on your machine; your data never leaves it.

The stack is **memory-capped** so it stays light and predictable — see [Docker Memory Limits](#docker-memory-limits-per-machine-tuning) for defaults (~2 GB reserved, ~390 MB in practice) and how to tune per machine. Four localhost surfaces come up together:

| Port | Protocol | Audience | Purpose |
|------|----------|----------|---------|
| `:3100` | JSON-RPC (HTTP) | LLM agents (Claude Code, Cursor, etc.) | MCP tool server |
| `:3200` | HTTP REST JSON | Humans, dashboards, CI scripts | REST API |
| `:3201` | WebSocket | Browsers, streaming UIs, Telegram bot | Real-time channel |
| `:3210` | HTTPS/HTTP | Humans | Next.js operations dashboard |

Manage it all from the CLI: `myai up` / `myai down` (`--volumes` drops data) / `myai status` / `myai logs [service]`. Full route/endpoint reference is in [Under the hood → Gateway Routes](#gateway-routes--endpoints).

---

## 🚀 Quick-to-production — `make prod`

The `make prod` keyword automates production provisioning for any project with the AI framework. Describe nothing extra — it detects your stack, provisions only what's missing, and wires branching + CI + hosting in one shot.

### How It Works

```
You: "make prod"

Step 0 — Check existing config (ALWAYS first):
  ├── .vercel/project.json exists?  → Already on Vercel
  ├── render.yaml exists?           → Already on Render
  ├── mongodb+srv:// in env?        → Already on Atlas
  ├── test branch exists?           → Already has branching
  └── If all configured → verify health → done (no re-provisioning)

Step 1 — Set up branching strategy:
  ├── Create test branch from main
  ├── Copy CI workflows (.github/workflows/ci.yml + merge-gate.yml)
  ├── Set branch protection (main: PR + CI, test: CI)
  └── Add vercel.json for dual-branch deploys

Step 2 — Detect project type & provision:
  ├── next.config.ts found          → Vercel deployment
  ├── express/fastify in deps       → Render deployment
  └── Mongoose models / MONGODB_URI → MongoDB Atlas

Step 3 — Provision only what's missing:
  ├── Vercel: link project, set env vars (Production + Preview), deploy
  ├── Atlas: create DB user, build connection string
  ├── Render: create web service, set env vars
  └── Generate .vercelignore / render.yaml

Step 4 — Verify:
  ├── Push test commit to test branch → CI passes
  ├── Vercel preview URL loads
  ├── curl /api/health → {"status":"ok","db":"connected"}
  └── Update state files with production + preview URLs
```

### Usage

```bash
# In any project with the AI framework:
# Just type "make prod" to your AI agent

# Or run the script directly:
./scripts/make_prod.sh /path/to/project [project-name]
```

### What Gets Created

| Service | Config File | Env Vars Set |
|---------|-------------|-------------|
| **Vercel** | `.vercel/project.json`, `.vercelignore` | `MONGODB_URI`, `JWT_SECRET`, `NODE_ENV` |
| **MongoDB Atlas** | Connection string in env | `MONGODB_URI` |
| **Render** | `render.yaml` | `MONGODB_URI`, `JWT_SECRET`, `NODE_ENV`, `PORT` |

### Key Behaviour

- **Idempotent:** Running `make prod` on an already-deployed project just verifies health — it won't re-provision or overwrite existing config
- **Partial setup:** If Vercel is configured but Atlas isn't, only Atlas gets provisioned
- **Git auto-deploy:** If Vercel has git integration, deploying is just `git push`

### Branching Strategy — Production Safety

**No wrong code reaches production.** Every repo uses two always-building branches:

| Branch | Purpose | Auto-deploys to | Protection |
|--------|---------|-----------------|------------|
| `main` | Production | Vercel prod URL | PR required, CI must pass |
| `test` | Staging | Vercel preview URL | CI must pass, direct push OK |

```
1. Push to test     →  git push origin test
2. CI runs          →  lint, type-check, test (automatic)
3. Preview deploys  →  Vercel generates preview URL (automatic)
4. User tests       →  AI asks user to verify preview URL
5. Create PR        →  gh pr create --base main --head test
6. AI reviews PR    →  code review + merge gate check
7. Merge            →  gh pr merge --merge
8. Prod deploys     →  Vercel auto-deploys to production (automatic)
9. Notify           →  AI confirms "Production deployment complete"
```

**Emergency hotfix:**
```bash
git checkout -b hotfix/critical-fix main
# fix...commit...push
gh pr create --base main --head hotfix/critical-fix
# After merge: sync test branch
git checkout test && git merge main && git push origin test
```

**CI pipeline (per repo)** — every push to `main` or `test` runs:
- **Lint** — ESLint
- **Type-check** — TypeScript compiler
- **Test** — Vitest/Jest with MongoDB service
- **Deploy Check** — full production build (PRs to main only)
- **Merge Gate** — only `test` or `hotfix/*` branches can PR to `main`

**Files added per repo:**

| File | Purpose |
|------|---------|
| `.github/workflows/ci.yml` | CI pipeline |
| `.github/workflows/merge-gate.yml` | Enforce test→main flow |
| `vercel.json` | Enable dual-branch deploys |

Also available: `make preview` (set up the test→preview pipeline for a specific repo).

---

## ⭐ Blueprint — from idea to app in 4 steps

> **Zero config. Zero boilerplate. Just describe what you want to build.**
>
> The Powerhouse Blueprint gives you the full engineering stack — 64 AI agents, 136 skills, CI/CD, database, error monitoring, design system — all pre-wired and ready. You don't pick agents, you don't configure tools, you don't set up pipelines. You just talk about your app.

### The 4 Steps

```
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  STEP 1   Open this repo in Claude                              │
│           cd ~/path/to/ai_management && claude                  │
│                                                                 │
│  STEP 2   Run the blueprint command                             │
│           init blueprint ~/path/to/<your-app-name>              │
│                                                                 │
│  STEP 3   Open the new app in Claude                            │
│           cd ~/path/to/<your-app-name> && claude               │
│           then type: agent mode                                 │
│                                                                 │
│  STEP 4   Describe your app                                     │
│           "Build a task management app with team collaboration"  │
│           "Build an e-commerce platform with Stripe payments"    │
│           "Build a real-time chat app with AI moderation"        │
│                                                                 │
│  That's it. The AI builds it.                                   │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

### What happens behind the scenes

You don't need to know any of this — it just works. But here's what the blueprint wires up for you automatically:

| Layer | What you get | You configure |
|-------|-------------|---------------|
| **AI Brain** | 64 specialist agents, 136 skills, MCP servers, hooks, SONA pattern memory | Nothing — auto-routed by your prompt |
| **App Stack** | Next.js 15 (App Router) + TypeScript strict + Tailwind v4 + shadcn/ui | Nothing — ready to build on |
| **Database** | MongoDB in Docker (local) + Atlas-ready for prod | Just swap `MONGODB_URI` for production |
| **AI Integration** | `@anthropic-ai/sdk` with prompt caching, sample AI feature | Nothing — imported and ready |
| **Error Monitoring** | Sentry browser + server + edge (graceful when DSN absent) | Add Sentry DSN when ready |
| **CI/CD** | 4 GitHub Actions: lint, merge gate, Claude review, Copilot review | Nothing — runs on push |
| **Design System** | Tailwind v4 + shadcn/ui + Google Stitch MCP for AI-driven UI | Nothing — just describe your UI |
| **Dev Environment** | `./dev` script (up / stop / reset / logs / shell / test / tsc) | Nothing — Docker handles it all |
| **Deployment** | Vercel-ready + `BLUEPRINT_HOOKUP.md` for 5-min production wireup | Follow the hookup guide |
| **Keywords** | `agent mode` (+ `-a` for auto-mode), `ship it`, `wrap up`, `yolo god`, `check bugs`, `office mode` | Just type them |

### Why this matters

Traditional setup: create repo → install deps → configure TypeScript → set up Tailwind → add shadcn → configure ESLint → write Dockerfile → set up docker-compose → create CI workflows → configure Sentry → set up database → write CLAUDE.md → configure MCP servers → set up agents → **then** start building. That's hours of boilerplate.

**With the blueprint: 4 steps, then you're building your app.** The AI already knows how to route your requests to the right specialist, which tools to use, and how to ship your code safely through CI.

### Alternative paths

**One-command scaffold:**
```bash
myai new-app ~/code/my-idea
```

**GitHub Template (skip step 1+2):**
```bash
gh repo create knofler/<name> --template knofler/todo-blueprint --private --clone
cd <name> && cp .env.example .env.local && ./dev
```

**Script with GitHub + Vercel flags:**
```bash
./scripts/init_blueprint.sh ~/path/to/<name> \
    --gh-create knofler/<name> --gh-private --vercel
```

**Canonical reference:** [`plan/POWERHOUSE_BLUEPRINT.md`](./plan/POWERHOUSE_BLUEPRINT.md)
**Template repo:** [`knofler/todo-blueprint`](https://github.com/knofler/todo-blueprint)

---

## 💡 Jam — ideate before you build

Not every session should start with code. Type `jam` (or `jam <idea>`) and the agent flips from executor to **thought-partner**: it explores the idea *with* you, pushes back, weighs options and tradeoffs, and asks the sharpening questions — a real conversation, not a multiple-choice interrogation.

- **It's the one explicit exception to zero-prompt/YOLO mode** — in a jam, questions and dialogue *are* the work. No code, edits, or commits happen during the jam.
- **Persistent mode** — it holds until you say `build it` or `jam done`.
- **On convergence** it writes a brief to `AI/plan/jam/<slug>.md` and registers it as a plan (visible on the dashboard `/plan`), then hands you a decision point: **schedule it** (queue for the runner, or `agent mode` to build now, or `init blueprint` for a new app), **more jam** (keep refining), or **park it**.

**Why it matters:** the cheapest place to fix a bad idea is before a single line is written. Jam gives you a structured brainstorm that ends in a real, registered plan — so the thinking isn't lost.

Full protocol: `documentation/KEYWORDS_REFERENCE.md` → "Jam".

---

## 🏗️ Architecture — how agents coordinate

The framework uses **parallel dispatch lanes** so multiple specialists work simultaneously without blocking each other. All coordination happens through shared state files — no direct agent-to-agent messaging needed.

### Directing a specific agent

Each agent is a specialist with a defined domain. You can activate one by describing a task in its area, or by explicitly naming it.

**Claude Code** (auto-discovered from `.claude/agents/`):
```
# Implicit — Claude Code routes automatically based on keywords:
"Design the MongoDB schema for the users collection"
→ Activates: database-specialist

# Explicit — name the agent directly:
"As the security-specialist, audit the authentication flow in src/middleware/auth.ts"
```

**Gemini / Copilot** (manual role adoption):
```
"Adopt the role defined in AI/agents/api-specialist.md for this session.
Now implement the /api/v1/users endpoint with validation and error handling."
```

**Multi-agent in one prompt** (dispatch several at once):
```
"Dispatch these specialists in parallel:
- frontend-specialist: Create the dashboard page at src/app/dashboard/page.tsx
- api-specialist: Implement GET /api/v1/dashboard/stats
- database-specialist: Add an aggregation pipeline for dashboard metrics"
```

### Invoking a skill manually

Skills are repeatable playbooks that produce consistent, standards-compliant output. Each skill has **trigger keywords** — use them naturally in your prompt, or invoke by name.

**By trigger keyword** (Claude Code auto-matches):
```
"Write a Dockerfile for the API service"
→ Triggers: dockerfile-create skill

"Set up rate limiting on the auth endpoints"
→ Triggers: rate-limit-setup skill

"Create the schema for the orders collection"
→ Triggers: schema-design skill
```

**By explicit name**:
```
"Run the api-contract skill for the payments service"
"Execute the test-strategy skill for this project"
"Use the owasp-audit skill to review our security posture"
```

**Gemini / Copilot** (reference the skill file directly):
```
"Follow the playbook in AI/skills/schema-design/SKILL.md to design the products collection schema."
```

### How agents coordinate & break down work

#### 1. Task Arrives
You describe a feature (e.g., "Build a user registration system with email verification").

#### 2. Parallel Dispatch
The framework identifies which specialists are needed and assigns them to lanes:

```
Lane A (Frontend):    frontend-specialist → registration form + verification page
                      ui-ux-specialist    → form design, validation UX, accessibility

Lane B (Backend):     api-specialist      → POST /api/auth/register, GET /api/auth/verify
                      database-specialist → User schema, email verification tokens

Lane C (Infra):       devops-specialist   → environment variables for email service
                      security-specialist → password hashing, token expiry, rate limiting

Lane D (Async):       documentation-specialist → API docs, README update
                      solution-architect       → ADR for auth approach
                      product-manager          → acceptance criteria
                      tech-ba                  → requirements traceability

Cross-Lane:           tech-lead      → reviews all outputs for consistency
                      qa-specialist  → writes unit, integration, and E2E tests
```

#### 3. Sequencing Rules
Lanes run in parallel, but **within a lane**, work sequences when one specialist's output feeds another:

- `database-specialist` designs the schema → `api-specialist` implements endpoints using that schema
- `api-specialist` finalizes the API contract → `frontend-specialist` integrates against it
- All implementation done → `qa-specialist` writes tests → `tech-lead` reviews

**Rule:** Only sequence when a specialist's output is a required input for another. Parallel is always the default.

#### 4. State Coordination
All agents read and write to the same state files — this is how they stay in sync without direct communication:

| File | Purpose | Who Writes |
|------|---------|-----------|
| `AI/state/STATE.md` | Current progress, blockers, next steps | All agents, after every task |
| `AI/state/AI_AGENT_HANDOFF.md` | Context for the next agent/session | Outgoing agent at session end |
| `AI/logs/claude_log.md` | Timestamped action log | Claude agents |
| `AI/logs/gemini.md` | Timestamped action log | Gemini agents |
| `AI/logs/copilot.md` | Timestamped action log | Copilot agents |

**Protocol:**
1. **Session start:** Read `STATE.md` + `AI_AGENT_HANDOFF.md` to sync
2. **After every task:** Update `STATE.md` autonomously (don't wait to be asked)
3. **Session end:** Update `STATE.md` + write `AI_AGENT_HANDOFF.md` + log to agent log

#### 5. File Ownership
Each lane owns specific directories to avoid merge conflicts:

```
Lane A owns: src/app/, src/components/, src/styles/
Lane B owns: src/routes/, src/models/, src/services/, src/middleware/
Lane C owns: docker-compose.yml, Dockerfile, .github/, render.yaml
Lane D owns: AI/, README.md, docs/
Cross-lane:  tests/, src/types/ (shared contracts)
```

### Worked Example: "Add a search feature"

```
You: "Add full-text search to the products catalog"

Step 1 — Dispatch parallel:
  database-specialist → MongoDB text index + aggregation pipeline  (Lane B)
  solution-architect  → ADR: text search vs Atlas Search vs Algolia (Lane D)
  product-manager     → acceptance criteria for search UX            (Lane D)

Step 2 — After schema ready, sequence:
  api-specialist      → GET /api/v1/products/search endpoint         (Lane B)

Step 3 — After API ready, parallel:
  frontend-specialist → search bar component + results page          (Lane A)
  ui-ux-specialist    → search UX: debounce, loading states, empty   (Lane A)
  documentation-specialist → API docs for search endpoint            (Lane D)

Step 4 — After implementation, parallel:
  qa-specialist       → unit tests + integration tests + E2E         (Cross)
  security-specialist → input sanitization, query injection review   (Lane C)
  tech-lead           → cross-lane coherence review                  (Cross)

Step 5 — All update STATE.md with their completed work.
```

### How it's delivered to projects

When you run `./scripts/init_ai.sh [project]`, everything gets copied automatically:

```
[target-project]/
├── AI/
│   ├── .claude/
│   │   ├── agents/ → ../agents/   ← Symlink, Claude Code auto-discovers
│   │   └── skills/ → ../skills/   ← Symlink, Claude Code auto-discovers
│   ├── agents/                     ← 64 agent definitions
│   ├── skills/                     ← 60 skill playbooks
│   ├── documentation/              ← AI_RULES, routing, guides
│   ├── state/                      ← STATE.md, AI_AGENT_HANDOFF.md
│   └── logs/                       ← claude_log.md, gemini.md, copilot.md
└── CLAUDE.md                       ← Routing rules for Claude Code
```

### Parallel dispatch lanes

```
Lane A: frontend-specialist + ui-ux-specialist         (src/app/, src/components/)
Lane B: api-specialist + database-specialist           (src/routes/, src/models/)
Lane C: devops-specialist + security-specialist        (docker-compose.yml, .github/)
Lane D: documentation + solution-architect + pm + ba   (AI/, README.md) — always parallel
Cross:  tech-lead (reviews all) + qa-specialist (tests all)
```

### Using agents with different AI tools

**Claude Code** — auto-discovered from `.claude/agents/` and `.claude/skills/` (after init):
```
Just use Claude Code normally — agents and skills auto-activate based on trigger keywords.
```

**Gemini / Copilot** — use the plain prompts in `AI/agents/`:
```
"Adopt the role defined in AI/agents/frontend-specialist.md for this session."
```

See `AI/agents/README.md` for tool-specific instructions and `AI/documentation/MULTI_AGENT_ROUTING.md` for full routing reference.

---

## 📚 Skills — repeatable playbooks

Each specialist agent has 3-5 **skills** — repeatable playbooks that trigger automatically when your prompt matches their keywords. Skills are auto-discovered from `AI/.claude/skills/` (Claude Code) or `AI/skills/` (all tools), so you get consistent, standards-compliant output every time.

| Agent | Skills |
|-------|--------|
| API Specialist | `api-contract`, `endpoint-implementation`, `middleware-setup`, `swagger-openapi`, `render-deploy-api` |
| Database Specialist | `schema-design`, `migration-script`, `seed-data`, `aggregation-pipeline` |
| DevOps Specialist | `docker-compose-setup`, `dockerfile-create`, `github-actions-pipeline`, `env-strategy`, `health-check-setup`, `make-prod` |
| Documentation Specialist | `readme-scaffold`, `api-docs-write`, `adr-write`, `changelog-update` |
| Frontend Specialist | `nextjs-page-create`, `react-component-build`, `api-integration`, `state-management`, `vercel-deploy-frontend` |
| Product Manager | `feature-spec`, `user-story-write`, `mvp-definition`, `backlog-prioritize` |
| Project Manager | `session-start`, `milestone-plan`, `blocker-escalation`, `status-report`, `session-close` |
| QA Specialist | `test-strategy`, `unit-test-write`, `integration-test-write`, `e2e-test-write`, `coverage-enforce` |
| Security Specialist | `auth-flow-review`, `owasp-audit`, `rate-limit-setup`, `secrets-audit`, `security-headers` |
| Solution Architect | `system-design`, `tech-evaluation`, `coherence-review`, `tech-debt-flag` |
| Tech BA | `requirements-elicit`, `data-flow-diagram`, `gap-analysis`, `requirements-traceability` |
| Tech Lead | `code-review`, `standards-enforcement`, `cross-specialist-integration`, `feature-signoff` |
| UI/UX Specialist | `design-system-setup`, `component-spec`, `accessibility-audit`, `ux-flow-doc`, `tailwind-config-extend` |

See `skills/README.md` for the full catalog with trigger keywords and invocation docs. Browse them live on the dashboard at `/skills`.

---

## 🎭 The specialist agents

This framework includes **64 specialist subagents** that work in parallel lanes to dramatically reduce project setup and feature development time. Describe a task and the right specialist picks it up automatically.

| Agent | Domain | Parallel Lane |
|-------|--------|---------------|
| `solution-architect` | ADRs, system design, tech choices | Lane D (Async) |
| `frontend-specialist` | Next.js, React, Vercel | Lane A |
| `api-specialist` | Node.js/Python APIs, REST/GraphQL | Lane B |
| `database-specialist` | MongoDB, Mongoose, Atlas | Lane B |
| `devops-specialist` | Docker, GitHub Actions, CI/CD | Lane C |
| `ui-ux-specialist` | Design system, Tailwind, accessibility | Lane A |
| `security-specialist` | OWASP, auth, secrets | Lane C |
| `documentation-specialist` | README, API docs, changelogs | Lane D (Async) |
| `product-manager` | Feature specs, user stories, roadmap | Lane D (Async) |
| `qa-specialist` | Testing strategy, unit/integration/E2E | Cross-Lane |
| `tech-ba` | Requirements, data flows, functional specs | Lane D (Async) |
| `tech-lead` | Code review, standards, cross-lane coherence | Cross-Lane |
| `project-manager` | Delivery, milestones, blockers | Lane D (Async) |

Browse the full roster (grouped by category) on the dashboard `/agents` page, or type `more agents` in any session. See [Architecture](#-architecture--how-agents-coordinate) for how they coordinate.

---

## 🪝 Hooks & the Session Usage Guard

Lifecycle hooks fire automatically on session start, before/after tool calls, and at session close — enforcing safety rails, checkpointing state, and preventing the single worst failure mode of AI coding: **losing context when an agent hits a rate limit mid-session.**

### Session Usage Guard — never lose context again

**The problem:** Claude Code (and other AI agents) hit API rate limits mid-session with zero warning. The session dies instantly — no state saved, no handoff, no way to continue. You wait hours and lose all context.

**The solution:** The Usage Guard tracks session capacity and forces a clean wrap-up **before** hitting the wall.

#### How It Works

Two metrics tracked simultaneously (the **higher** percentage wins):

| Metric | What it measures | Default limit |
|--------|-----------------|---------------|
| **Elapsed time** | Clock time since session start | 240 minutes (4 hours) |
| **Weighted actions** | Tool calls weighted by cost | 300 (Bash/Edit/Write=1.0, Read/Glob/Grep=0.3) |

#### Three Escalation Levels

```
0%─────────────────80%──────────90%──────95%────100%
                    │            │        │       │
                    │            │        │       └─ Claude's rate limit (CRASH — no handoff)
                    │            │        │
                    │            │        └─ 🔴 EMERGENCY: Heavy tools BLOCKED
                    │            │           Only AI_AGENT_HANDOFF.md writes allowed
                    │            │           Claude writes minimal handoff, then stops
                    │            │
                    │            └─ 🔴 RED: Mandatory wrap up
                    │               Claude stops all work, runs full wrap-up
                    │               commit → push → STATE.md → handoff → done
                    │
                    └─ 🟡 YELLOW: Start wrapping up
                       Finish current task, don't start new work
                       Budget remaining actions for wrap-up ceremony
```

**Why the 95% block?** Claude's own rate limit is a hard wall — instant death, nothing saved. The 95% block is a controlled landing: it forces Claude to spend its last ~5% budget **only on writing your handoff**, not on random commands. Without it, Claude might try to "finish one more thing" and crash into the real wall mid-sentence.

#### What Happens at Each Level

**At 80% — Yellow Warning:**
- Claude announces remaining budget to you
- Finishes current task but won't start new work
- Prioritizes: commit → push → state update → handoff

**At 90% — Red Warning:**
- Claude stops all work immediately
- Runs full `wrap up` ceremony (STATE.md, AI_AGENT_HANDOFF.md, commit, push)
- Tells you: "Continue with Gemini/Copilot using AI_AGENT_HANDOFF.md"

**At 95% — Emergency:**
- Bash, Edit, Write, Agent tools are **BLOCKED** (exit code 2)
- Read, Glob, Grep still work (Claude needs to read files for context)
- **Only exception:** writes to `AI_AGENT_HANDOFF.md` are allowed
- Claude writes minimal handoff: what was done, what's in progress, what's next, blockers
- Tells you to commit/push manually, then switch agents

#### After Usage Guard Triggers

1. Claude saves `AI_AGENT_HANDOFF.md` with full context
2. You commit and push if Claude couldn't (at 95%, Bash is blocked):
   ```bash
   git add -A && git commit -m "chore: emergency handoff" && git push origin test
   ```
3. Open another agent (Gemini, Copilot, new Claude session after cooldown)
4. Tell it: `agent mode` — it reads the handoff and continues

#### Configuration

Thresholds are configurable per-repo in `config/session-limits.json` (or `AI/config/session-limits.json` in managed repos):

```json
{
  "session_duration_minutes": 240,
  "max_weighted_actions": 300,
  "action_weights": {
    "Bash": 1.0, "Edit": 1.0, "Write": 1.0,
    "Read": 0.3, "Glob": 0.3, "Grep": 0.3,
    "Agent": 1.0, "default": 0.5
  },
  "warn_at_percent": [80, 90, 95],
  "block_at_percent": 95,
  "block_tools": ["Bash", "Edit", "Write", "Agent"],
  "allow_through_tools": ["Read", "Glob", "Grep"]
}
```

**Tuning tips:**
- If sessions consistently die before 4 hours, reduce `session_duration_minutes`
- If you do heavy work (lots of Bash/Edit), reduce `max_weighted_actions`
- Per-repo overrides: edit the file in the target repo — `update_all.sh` won't overwrite it

#### If You Get Locked Out (95% Block Active)

If the usage guard blocks your tools during testing or a false positive:

```bash
# Run this in the Claude prompt with ! prefix:
! bash hooks/session/12-usage-guard-init.sh

# Or in a separate terminal:
cd /path/to/your/repo
bash hooks/session/12-usage-guard-init.sh    # master repo
bash AI/hooks/session/12-usage-guard-init.sh # managed repo
```

This resets the session timer and action counter. The block lifts immediately.

**Starting a new Claude session also resets the guard** — the `12-usage-guard-init.sh` hook fires on every SessionStart.

#### Under the Hood

| Component | File | Purpose |
|-----------|------|---------|
| Config | `config/session-limits.json` | Thresholds + weights |
| Session init | `hooks/session/12-usage-guard-init.sh` | Creates `state/.session-metrics` on session start |
| Tracker | `hooks/pre-tool/10-usage-guard.sh` | Runs before EVERY tool call, increments counters, warns/blocks |
| Dashboard | `hooks/stop/03-session-dashboard.sh` | Shows Usage % in traffic-light dashboard |
| Protocol | `CLAUDE.md` (Usage Guard Protocol section) | Tells Claude what to do at each threshold |

The `state/.session-metrics` file is ephemeral (gitignored) and looks like:
```
started=2026-04-05T10:00:00Z
started_epoch=1775383200
duration_minutes=240
max_weighted_actions=300
action_count=142
weighted_actions=98.7
warnings_sent=,80
```

---

## 🔑 Keywords

Short phrases you can type instead of long prompts. The AI agent recognizes these and executes the full workflow automatically.

### Project keywords (any repo with the AI/ framework)

These work in **any project** that has the AI framework installed.

| Keyword | What It Does |
|---------|-------------|
| `hello` | Show all available keywords and their usage as a table |
| `start work` | Read STATE.md + AI_AGENT_HANDOFF.md, assess status, report what's done / in-progress / blocked, identify next priority |
| `agent mode` | **Full multi-agent activation.** Git sync, multi-machine check, Docker naming check, mobile branch merge, read all 4 context files, load SONA patterns, report status, check Connect Hub, **report available MCP servers** (reads `.mcp.json`), dispatch all 5 parallel lanes. Auto-update state after every task |
| `ship it` | **Safe deploy via test branch.** Commit → push to `test` → CI passes → preview deploys → user tests → PR to `main` → AI reviews → merge → prod deploys → notify user → update state. **Does NOT run update_all** — that's master-repo only |
| `agent mode -min` | **Lightweight session start (<1 min).** Pull + read handoff ACTION + STATE top block + schedule banner + report. Skips the full maintenance sweep |
| `agent mode -resume` | **Join the last scheduled/headless runner session for this repo** and continue its work |
| `remote status` / `remote start [repo…\|--last-start]` / `remote stop [repo…\|--last-start]` | **Fleet remote sessions.** Runs `./AI/scripts/remote_fleet.sh <action>` — see who's live where, open phone-drivable claude-museum sessions (duplicate-guarded), stop museum sessions only. Anchor rule: the master-AI doorway session is never stopped (override `--include-anchor`); `stop --last-start` undoes only the last start's launches; `start --last-start` reopens exactly that set (record never rewritten) |
| `schedule plan` | **Mythos plan + 10-day schedule → ship → wrap.** Writes `AI/plan/MYTHOS_IMPROVEMENT_PLAN.md` + `AI/plan/schedule.json`, posts the 10-day schedule to dashboard `/plan` (via `push_schedule.sh`), queues tasks for the off-hours CLI runner, then auto-runs `ship it` + `wrap up -u`. Works from CLI or mobile (mobile commits the artifact; a CLI `agent mode -a` ingests it). |
| `schedule <desc>` / `schedule list` | Queue one autonomous task for this repo / list the queue (`AI/scripts/schedule_task.sh`). |
| `wrap up` / `wrap up -u` | **Session close.** Runs `schedule plan` **first**, then updates STATE.md + AI_AGENT_HANDOFF.md + log, traffic-light dashboard, WRAPPED-UP banner. **`-u` (urgent)** skips `schedule plan` for a fast close. |
| `status` | Read STATE.md and give a quick summary: what's done, what's in progress, what's blocked |
| `review` | Dispatch tech-lead for code review + qa-specialist for test coverage check on recent changes |
| `plan [feature]` | Dispatch solution-architect + product-manager + tech-ba to break down a feature into specs, stories, and an ADR before any code is written |
| `jam` / `jam <idea>` | Collaborative ideation mode — brainstorm *before* building. Persistent until `build it` / `jam done`. See [Jam](#-jam--ideate-before-you-build) |
| `scaffold [thing]` | Dispatch the relevant specialists to generate boilerplate: `scaffold api`, `scaffold page [name]`, `scaffold schema [name]`, `scaffold docker`, `scaffold tests` |
| `audit` | Dispatch security-specialist (OWASP audit) + qa-specialist (coverage check) + tech-lead (standards review) in parallel |
| `handoff` | Prepare full handoff: update STATE.md, write detailed AI_AGENT_HANDOFF.md, log session summary — ready for a different AI agent to pick up |
| `connect setup` | **Integrate Connect Hub.** Read `AI/documentation/CONNECT_HUB.md`, fix imports, update middleware, add nav item, type check, test. Files must already be copied by master repo. |
| `check bugs` | Pull open bugs from Connect Hub DB. List by severity. Suggest which to fix first |
| `fix bug [id]` | Pull bug from DB, set status to "working", analyse, implement fix on test branch, create PR, update status to "solved/deployed" |
| `check features` | Pull open feature requests from DB. List by priority and votes. Suggest which to build |
| `build feature [id]` | Pull feature from DB, set status to "working", implement on test branch, create PR, merge, update status to "deployed" |
| `triage` | Pull all "reported" bugs and features. AI analyses each: set severity/priority, detect duplicates, assign to specialist agent, update status to "triaged" |
| `show urls` | Show production and preview URLs for this project |
| `make preview` | Set up test→preview pipeline (test branch, CI, branch protection) |
| `make prod` | **Productionise with branching.** Set up test branch + CI + Vercel/Render/Atlas. Check existing config first |
| `ai tools` | **Fleet inventory.** Show 5 agents, 5 skills, 5 MCP tools, and gateway routes. See [`ai tools`](#ai-tools--fleet-inventory-command) for full reference |
| `more agents` / `more skills` / `more mcp` / `more routes` | Expand each list fully |
| `ai tools help` | Usage block |
| `yolo [minutes]` | **Timed autonomous mode.** No permission prompts or clarifying questions for N minutes. Safety rails still enforced |
| `yolo god` | **Full autonomous mode.** No questions until plan complete or next commit — whichever first |
| `yolo off` | Deactivate YOLO mode immediately |

Master-repo-only keywords (`sync all`, `health check`, `add repo`, `agent mode -resume all` / `/fleet`, and the `init` agent generators) are documented under [operator docs](#master-repo-keywords-this-repo-only).

### YOLO mode — autonomous execution

YOLO mode tells the AI agent to stop asking for permission and just execute. Two flavours:

- **`yolo 10`** — timed: no questions for 10 minutes, then reverts to normal
- **`yolo god`** — until the next `git commit` succeeds or the current plan is fully completed

**Safety rails are always enforced** even in YOLO mode:
- Never push directly to `main`
- Never commit secrets
- Never delete branches without recovery path

Under the hood: `scripts/yolo.sh` writes `state/.yolo` with mode and expiry. The `11-yolo-status.sh` session hook checks and displays status on every session start, auto-clearing expired timers.

### How keywords differ by context

```
In ANY repo (master or project):
  "ship it" → push to test → CI → preview → user tests → PR → merge → prod deploy

In master repo (ai_management/) additionally:
  "ship it" → ...all the above... + sync ALL managed repos via update_all.sh
```

**NEVER push directly to `main`.** The `ship it` workflow always goes through the `test` branch first. The agent knows which context it's in by reading `CLAUDE.md` at project root.

---

# 🔬 Under the hood (deep dive)

*For those who want the technical depth: gateway internals, cost-aware routing, memory tuning, and the mandates every agent enforces. Ordinary users can skip this — the pillars above are all you need to be productive.*

## Gateway Routes & Endpoints

When the Docker stack is up (`docker compose up -d` / `myai up`), the framework exposes four distinct surfaces on localhost:

| Port | Protocol | Audience | Purpose |
|------|----------|----------|---------|
| `:3100` | JSON-RPC (HTTP) | LLM agents (Claude Code, Cursor, etc.) | MCP tool server — how any LLM calls gateway tools |
| `:3200` | HTTP REST JSON | Humans, dashboards, CI scripts | REST API — read agents, skills, sessions, memory |
| `:3201` | WebSocket | Browsers, streaming UIs, Telegram bot | Real-time bi-directional channel |
| `:3210` | HTTPS (via Vercel) or HTTP (local) | Humans | Next.js operations dashboard UI |

### HTTP REST API — `:3200`

All endpoints return JSON. Hit with `curl`, `fetch()`, Postman, etc.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Uptime + MongoDB connection status |
| GET | `/status` | Gateway summary: agents, skills, hooks, rules, sessions, LLM config |
| GET | `/api/agents?category=&search=` | List all agents (filter by category or free-text) |
| GET | `/api/agents/:name` | Full agent definition with instructions |
| GET | `/api/skills?search=&agent=` | List all skills |
| GET | `/api/skills/:name` | Full skill playbook |
| GET | `/api/hooks` | All registered hooks with events + priority |
| GET | `/api/rules?category=` | All governance rules (AI_RULES, routing, etc.) |
| GET | `/api/rules/:name` | Full rule content |
| GET | `/api/repos` | All managed repos grouped by workspace |
| GET | `/api/channels` | Registered channel adapters (Telegram, Discord) |
| POST | `/api/memory/search` | Hybrid SONA pattern search (body: `{query, tags?, topN?}`) |
| POST | `/api/memory/context` | LLM-ready context block (body: `{query, tags?, maxTokens?}`) |
| POST | `/api/vectors/search` | Vector RAG search (body: `{query, repo?, source?, tags?, limit?}`) |
| GET | `/api/vectors/stats` | Total vector count |
| POST | `/api/vectors/index` | Re-index memory (body: `{scope: "master" \| "all"}`) |
| POST | `/api/sessions` | Create a session (body: `{agentName, metadata?}`) |
| GET | `/api/sessions` | List active sessions |
| GET | `/api/sessions/:id` | Session detail with last 20 messages |
| DELETE | `/api/sessions/:id` | Close a session |
| POST | `/api/sessions/:id/messages` | Send a message and get response (body: `{content, metadata?}`) |
| GET | `/health/deep` | Deep health probe — mongodb, llm, scheduler, channels, agents, memory |
| GET | `/api/openapi.json` | **Full OpenAPI 3.1 spec** for this API (machine-readable) |
| GET | `/api/docs` | **Interactive API reference** rendered from the spec (self-contained, offline) |
| GET | `/api/schedules?enabled=&kind=` | List autonomous schedules |
| POST | `/api/schedules` | Create a schedule (body: `{name, cronExpr, kind, target, message, enabled?}`) |
| GET | `/api/schedules/:id` | Schedule detail |
| PATCH | `/api/schedules/:id` | Update a schedule (cron revalidated, nextRun recomputed) |
| DELETE | `/api/schedules/:id` | Delete a schedule |
| POST | `/api/schedules/:id/run` | Run a schedule immediately |
| GET | `/api/tasks?repo=&status=&priority=` | List task queue |
| GET | `/api/tasks/next` | Highest-priority pending task + queue summary |
| POST | `/api/tasks` | Create a task (body: `{repo, title, ...}`) |
| PATCH | `/api/tasks/:id` | Update a task |
| GET | `/api/fleet` | Fleet overview — cross-repo orchestration snapshot |
| POST | `/api/dispatch` | Trigger a dispatch cycle (admin: `X-Admin-Token`) |
| GET | `/api/budgets/status` | Budget status (admin: `X-Admin-Token`) |
| GET | `/api/budgets/breakdown?from=&to=` | Spend breakdown (admin) |
| GET | `/api/budgets/usage?provider=&limit=` | Usage records, cursor-paginated (admin) |
| POST | `/api/notifications` | Send notification to channels (body: `{message, channels?, level?, title?}`) |
| GET | `/api/notifications?limit=` | Recent notification history |
| POST | `/api/webhooks/github` | GitHub webhook receiver (auto-creates tasks, sends alerts) |
| GET | `/api/health/alerts?run=` | Health alerting status + latest check result |

**Quick try:**
```bash
curl http://localhost:3200/health
curl http://localhost:3200/status
curl 'http://localhost:3200/api/agents?category=core' | jq
open http://localhost:3200/api/docs        # browsable API reference
```

### WebSocket — `:3201`

Persistent bi-directional connection for streaming. Server sends `{type: "event", data: {event: "connected"}}` on open; keeps connection alive with ping frames every 30 s.

| Client → Server | Required fields | Response |
|-----------------|-----------------|----------|
| `{type: "ping"}` | — | `{type: "pong"}` |
| `{type: "agent.list", id?}` | — | Agents list in `data.agents` |
| `{type: "agent.detail", id?, agentName}` | `agentName` | Full agent in `data` |
| `{type: "session.list", id?}` | — | Sessions list in `data.sessions` |
| `{type: "session.create", id?, agentName, content?, metadata?}` | `agentName` | New session + first response; broadcasts `session.created` to others |
| `{type: "session.message", id?, sessionId, content, metadata?}` | `sessionId`, `content` | Response routed through agent |
| `{type: "session.close", id?, sessionId}` | `sessionId` | `{data: {status: "closed"}}` |

**Quick try:**
```bash
npm i -g wscat
wscat -c ws://localhost:3201
> {"type":"ping"}
> {"type":"agent.list"}
```

### MCP Tool Server — `:3100`

JSON-RPC 2.0 over HTTP. This is the endpoint other LLMs (Claude Code in any repo, via `.mcp.json`) call to use gateway tools.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | MCP server health |
| GET | `/mcp` | Debug — list tool names and count |
| POST | `/mcp` | JSON-RPC 2.0 envelope |

**JSON-RPC methods (via POST `/mcp`):**
- `initialize` — handshake, returns server info + capabilities
- `notifications/initialized` — client acknowledgement
- `tools/list` — return all 44 tool definitions
- `tools/call` — invoke a tool (params: `{name, arguments}`)
- `ping` — keepalive

**124 MCP tools** (representative subset below — see [`runtime/src/mcp/tools.ts`](runtime/src/mcp/tools.ts) for the full set incl. `memory_reindex`, `schedules_*` incl. `schedules_seed`, `budgets_*`, `agents_invoke`, `skills_invoke`, `morning_sweep`, `evening_sweep`, `dispatch_cycle`, `fleet_overview`, `standing_agents_status`, `notifications_*`, `health_alerts_*`):

| Category | Tool | Purpose |
|----------|------|---------|
| Memory | `memory_search` | Semantic search across all repos' vectors |
| Memory | `recall_session` | Semantic recall over the session corpus (state+handoff+archive); ranked blocks, `since`/`repo` filters |
| Memory | `memory_store` | Embed + store a chunk (dedupes by content hash) |
| Memory | `memory_context` | Pre-built context block (handoff + state + patterns) |
| Memory | `memory_stats` | Vector counts per repo / source |
| State | `state_read` | Read STATE.md or AI_AGENT_HANDOFF.md |
| State | `state_update` | Replace or append a markdown section by heading |
| Tasks | `tasks_list` | Filter queue by repo / status / priority / agent |
| Tasks | `tasks_create` | New task (repo, title, priority, source, …) |
| Tasks | `tasks_update` | Change status, add PR URL, attach notes |
| Tasks | `tasks_next` | Highest-priority pending (P0 first, then oldest) |
| Repos | `repos_list` | Managed repos from `managed_repos.txt` with health flags |
| Repos | `repos_status` | Git branch, uncommitted count, ahead/behind, file mtimes |
| Repos | `repos_priority` | Ranked by open tasks + stale handoff + missing AI |
| Inventory | `agents_list` | All 64 agents (filter by category) |
| Inventory | `skills_list` | All 136 skills (filter by agent) |

**Quick try:**
```bash
# List tools
curl -s http://localhost:3100/mcp | jq

# Call a tool
curl -sX POST http://localhost:3100/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call",
       "params":{"name":"repos_priority","arguments":{}}}' | jq
```

### Dashboard UI — `:3210`

Next.js 15 operations console. See the [Dashboard pillar](#-dashboard--your-live-operations-console) for the full page list. **Production URL:** `https://ai-management-one.vercel.app/`

---

## Cost Management — two-layer defence

The framework has **two layers** protecting you from excessive costs.

### Layer 1: Session Usage Guard (Active — All Repos)

Prevents mid-session context loss by detecting approaching API rate limits. See [Hooks & the Session Usage Guard](#-hooks--the-session-usage-guard) above.

| Threshold | Action | Result |
|-----------|--------|--------|
| **80%** | Yellow warning | Finish task, start wrapping up |
| **90%** | Red warning | Mandatory `wrap up` — commit, push, handoff |
| **95%** | Emergency block | Heavy tools blocked, only handoff writes allowed |

**Config:** `config/session-limits.json` (master) or `AI/config/session-limits.json` (managed repos)

**If locked out at 95%:**
```bash
# In Claude prompt:
! bash hooks/session/12-usage-guard-init.sh          # master repo
! bash AI/hooks/session/12-usage-guard-init.sh       # managed repo

# Or in a separate terminal:
cd /path/to/repo && bash hooks/session/12-usage-guard-init.sh
```
Resets the timer and action counter immediately. New sessions also auto-reset.

### Layer 2: Cost-Aware LLM Routing (Gateway — Implemented)

Routes LLM tasks to the cheapest capable provider, plus **Phase 5b budget guards** (opt-in, default off): hard-cap blocks at monthly/daily/per-channel thresholds, soft-cap auto-downgrade (Opus→Sonnet→Haiku), and a `/budgets` dashboard. See `plan/PHASE_5B_BUDGET_GUARDS.md` for full design.

**Enable budget guards** (opt-in, set in `/tmp/.myai-host-env`):
```
BUDGETS_ENABLED=1
BUDGET_MONTHLY_HARD_USD=50          # default $50
BUDGET_DAILY_HARD_USD=5             # default $5
BUDGET_PER_CHANNEL_MONTHLY_USD=20   # optional
BUDGET_DOWNGRADE_OPUS=0.8           # downgrade Opus→Sonnet at 80% MTD
BUDGET_DOWNGRADE_SONNET=0.9         # downgrade Sonnet→Haiku at 90% MTD
BUDGET_BYPASS_CHATS=ops_chat_id     # comma-separated, ops-only
```
Then `docker compose up -d --build gateway`. Visit `http://localhost:3210/budgets` for the dashboard.

```
Task arrives
    │
    ▼
┌─────────────────────────┐
│ Tier 0: Skip-LLM        │  Templates, grep, file ops — no AI needed ($0)
└──────────┬──────────────┘
           │ needs reasoning
           ▼
┌─────────────────────────┐
│ Tier 1: Local CLI        │  Claude Code, Gemini CLI, Copilot ($0)
└──────────┬──────────────┘
           │ timed out or unavailable
           ▼
┌─────────────────────────┐
│ Tier 2: Budget Cloud     │  DeepSeek V3, Gemini Flash (~$0.001/req)
└──────────┬──────────────┘
           │ needs premium quality
           ▼
┌─────────────────────────┐
│ Tier 3: Premium Cloud    │  Claude Sonnet, GPT-4o (~$0.01/req)
└──────────┬──────────────┘
           │ needs best-in-class
           ▼
┌─────────────────────────┐
│ Tier 4: Ultra            │  Claude Opus, GPT-4 Turbo (~$0.05/req)
└─────────────────────────┘
```

**Provider Costs (as of March 2026):**

| Provider | Model | Input/1M tokens | Output/1M tokens | Tier |
|----------|-------|-----------------|-------------------|------|
| Local CLI | Claude/Gemini/Copilot | $0 | $0 | 1 |
| DeepSeek | V3 | $0.27 | $1.10 | 2 |
| Google | Gemini Flash | $0.075 | $0.30 | 2 |
| Anthropic | Haiku 4.5 | $0.80 | $4.00 | 2 |
| OpenAI | GPT-4o mini | $0.15 | $0.60 | 2 |
| Anthropic | Sonnet 4.6 | $3.00 | $15.00 | 3 |
| OpenAI | GPT-4o | $2.50 | $10.00 | 3 |
| Anthropic | Opus 4.7 | $15.00 | $75.00 | 4 |

**Budget Guards:**

| Guard | Trigger | Action |
|-------|---------|--------|
| Session | Cost > $1.00 | Warn, suggest cheaper tier |
| Single request | Cost > $0.50 | Require confirmation |
| Daily | Cost > $5.00 | Block premium/ultra, force budget tier |
| Monthly | Cost > $50.00 | Block all cloud, force local CLI only |

**Complexity Estimator** — routes tasks by actual need:

| Signal | Low (Tier 1-2) | Medium (Tier 2-3) | High (Tier 3-4) |
|--------|----------------|-------------------|-----------------|
| Files touched | 1-2 | 3-5 | 6+ |
| Cross-lane | No | Partial | Full cross-cutting |
| Reasoning depth | Pattern match | Multi-step | Architecture decision |
| Context needed | Current file | Module | Full codebase |

Full details: `documentation/COST_AWARE_ROUTING.md`

---

## Docker Memory Limits (per-machine tuning)

The Docker stack is memory-capped via `docker-compose.yml` and **every limit is env-overridable**, so the same repo works fine on a 16 GB home Mac and a 64 GB office Mac without editing committed config.

### Defaults (sized for 16 GB RAM host)

| Container | `mem_limit` | `mem_reservation` | Typical actual use |
|-----------|-------------|-------------------|--------------------|
| `myai-gateway` | **1 GB** | 256 MB | ~250 MB (ONNX embedding model + Node) |
| `myai-dashboard` | **512 MB** | 128 MB | ~45 MB (Next.js standalone) |
| `myai-mongo` | **512 MB** | 128 MB | ~95 MB idle, more as vector index grows |
| **Total reserved** | **~2 GB** | **~512 MB** | ~390 MB in practice |

That's ~12 % of a 16 GB machine — leaves plenty of headroom for browser + IDE + Claude Code.

### Override on beefier machines

Add to the repo's `.env`:
```bash
# Office Mac — 64 GB
GATEWAY_MEM_LIMIT=4g
GATEWAY_MEM_RESERVATION=1g
DASHBOARD_MEM_LIMIT=1g
MONGO_MEM_LIMIT=2g              # room for larger vector index / session history
MONGO_MEM_RESERVATION=512m
```

Then `docker compose up -d` (no `--build` needed — limits re-apply on container recreate).

### Verify

```bash
docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}"
```

The `MEM USAGE` column shows `used / limit` — the limit part should match your configured caps (e.g. `1GiB`, `512MiB`), not the full Docker VM size.

### Why this matters

Without `mem_limit`, each container inherits the Docker Desktop VM's ceiling (7.65 GB by default on macOS) — so `docker stats` shows each container as if it could consume all of it. That's not what's actually used, but it's confusing and makes capacity planning impossible. The limits above make real usage visible and predictable.

---

## Technical Mandates (The Rules)

All agents MUST strictly adhere to these standards:
- **Containerization:** Always use **Docker** + **Docker Compose**.
- **No Local npm:** NEVER run `npm install`, `npm ci`, `npx`, or `node` on the host. Always `docker compose exec app <command>`.
- **Frontend:** Always use **Next.js** + **Tailwind CSS v4** + **shadcn/ui**.
- **Design System:** Utility-first Tailwind classes only. Design tokens in `globals.css` via `@theme`. shadcn components in `src/components/ui/`. No CSS modules, no styled-components, no inline styles. See `documentation/DESIGN_SYSTEM.md`.
- **Hosting:** **Render.com** (API) & **Vercel** (Frontend).
- **Database:** **MongoDB**.
- **CI/CD:** **GitHub Actions**.
- **Branching:** Two branches per repo: `main` (production) + `test` (staging). Never push directly to `main`.
- **API Docs:** Any project with API endpoints MUST have: OpenAPI 3.0 spec at `/api/openapi.json` + Scalar interactive docs at `/docs` + OpenAPI MCP server. Templates: `templates/api/`. See `documentation/AI_RULES.md`.
- **Docs:** Every repo must have detailed READMEs and code comments explaining the "why".

### Design System Quick Reference

| Concept | Standard |
|---------|----------|
| CSS framework | Tailwind CSS v4 (CSS-first `@theme` config) |
| Component library | shadcn/ui (copy-paste, owned source code) |
| Design tokens | `globals.css` `@theme` block — brand colors, fonts, spacing |
| Class merging | `cn()` from `@/lib/utils` (tailwind-merge + clsx) |
| Component variants | class-variance-authority (CVA) |
| Component location | shadcn: `src/components/ui/` / Custom: `src/components/` |
| Responsive | Mobile-first: default → `md:` → `lg:` |
| Dark mode | `dark:` prefix, tokens in CSS config |
| Install component | `docker compose exec app npx shadcn@latest add button` |

Full guide: `documentation/DESIGN_SYSTEM.md` | Template files: `templates/design/`

---

# 🛠️ For framework operators / self-hosters

*This section is operator-facing — the plumbing for running myAI as the master repo of a managed fleet. If you're a consumer of the package, you can safely skip it.*

## CLI-Mobile Agent Workflow (codeclot)

Work on any repo from your phone, then continue seamlessly from your desktop — and vice versa. Every repo is fully self-contained with state, agents, skills, and documentation.

### How It Works

```
┌──────────────────────────┐                    ┌──────────────────────────┐
│    MOBILE SESSION        │                    │    CLI SESSION            │
│    (phone/tablet/browser)│                    │    (desktop/laptop)       │
├──────────────────────────┤                    ├──────────────────────────┤
│                          │                    │                          │
│  agent mode              │                    │  agent mode              │
│  ├─ git fetch origin     │                    │  ├─ git fetch origin     │
│  ├─ pull latest main ◄───┼── latest code ─────┤  ├─ pull current branch  │
│  ├─ read STATE.md    ◄───┼── latest context ──┤  ├─ find codeclot*       │
│  ├─ read HANDOFF     ◄───┼── latest handoff ──┤  ├─ merge codeclot*      │
│  └─ checkout codeclot    │                    │  └─ delete codeclot*     │
│                          │                    │                          │
│  Work: code, fix, plan   │                    │  Work: code, fix, plan   │
│                          │                    │                          │
│  wrap up                 │                    │  ship it                 │
│  ├─ commit ALL to        │                    │  ├─ push to test         │
│  │  codeclot branch      │                    │  ├─ CI passes            │
│  ├─ push codeclot ───────┼── mobile work ────►│  ├─ PR to main           │
│  └─ state + handoff      │                    │  ├─ merge to main        │
│     saved in codeclot    │                    │  └─ state on main ───────┼──► next mobile
│                          │                    │                          │
│  NEXT MOBILE SESSION     │                    │  wrap up                 │
│  agent mode → pull main  │                    │  ├─ state committed      │
│  → ALL code + context    │                    │  └─ pushed to main       │
│    instantly available   │                    │                          │
└──────────────────────────┘                    └──────────────────────────┘
```

### Quick Reference

| Action | Mobile | CLI |
|--------|--------|-----|
| Start work | `agent mode` (pulls `main`) | `agent mode` (merges `codeclot*`) |
| Save work | `wrap up` (pushes `codeclot`) | `ship it` (pushes `test` → `main`) |
| Working branch | `codeclot` | `test` |
| State sync direction | Pulls from `main` | Pushes to `main` via PR |

### Session Detection

| Signal | Type | Branch |
|--------|------|--------|
| hostname = `vm` | Mobile | `codeclot` |
| `CODECLOT_OVERRIDE=1` | Forced mobile | `codeclot` |
| Any other hostname | CLI | `test` |

### Branch Names (Both Patterns)

Mobile branches come in two forms — CLI `agent mode` checks both:

| Source | Branch Pattern | Example |
|--------|---------------|---------|
| Manual codeclot | `codeclot` or `codeclot/<timestamp>` | `codeclot/20260405-1430` |
| Claude Code web (auto) | `claude/agent-mode-*` or `claude/*` | `claude/agent-mode-lF3SR` |

### Concurrent Mobile Sessions

```
Session 1 → codeclot
Session 2 → codeclot/20260405-1430
Session 3 → claude/agent-mode-xY7qR  (auto-created by Claude Code web)

CLI agent mode → merges ALL, deletes each after merge
```

### Critical: Mobile MUST Pull Main First

**The most important step in mobile `agent mode` is `git checkout main && git pull origin main`.** Without this, mobile works on stale code and stale state. CLI pushes everything to `main` via PR — mobile must pull to get it.

### Key Points

- **Mobile** pulls from `main` (gets all CLI work + state), works on `codeclot` branch
- **CLI** merges `codeclot*` branches (gets all mobile work), ships via `test` → `main`
- Every repo has STATE.md, HANDOFF, logs, agents, skills — fully self-contained
- Just type `agent mode` on any device, any repo — full context immediately

Full documentation: `documentation/CLI_MOBILE_WORKFLOW.md`

---

## Master Repo Keywords (this repo only)

| Keyword | What It Does |
|---------|-------------|
| `hello` | Show all available keywords and their usage as a table |
| `agent mode` | **Full multi-agent activation.** Git sync, multi-machine check, Docker naming check, mobile branch merge, read all 4 context files, load SONA patterns, report status, check Connect Hub, **report available MCP servers** (reads `.mcp.json`), dispatch all 5 parallel lanes (frontend, backend, infra, async, cross-lane). Auto-update state after every task |
| `ship it` | **Safe deploy via test branch.** Commit → push to `test` → CI passes → preview deploys → user tests → PR to `main` → AI reviews → merge → prod deploys → notify user → update state → sync all managed repos |
| `agent mode -min` | **Lightweight session start (<1 min).** Pull + read handoff ACTION + STATE top block + schedule banner + report. Skips the full maintenance sweep — use full `agent mode` before shipping or after a machine switch |
| `agent mode -resume` | **Join the last scheduled/headless runner session for this repo** — read its log, cross-check the task queue + commits, report a JOIN summary, continue as that agent |
| `agent mode -resume all` / `/fleet` | **Fleet Morning Console.** Sweep every managed repo's overnight work, show a decision table, drive ship/fix/merge/wrap-up per repo from this terminal — live on dashboard `/fleet` |
| `remote status` / `remote start [all\|core\|repo…\|--last-start]` / `remote stop [repo…\|--last-start]` | **Fleet remote sessions (works in EVERY repo).** `status` = which repos have live claude sessions + profile (anti-duplication view). `start` = open a phone-drivable claude-museum session per repo (iTerm tab, duplicate-guarded, `--max` RAM cap; records what it launched). `stop` = kill museum sessions only, never interactive shells. **Anchor rule:** the master-AI session is NEVER stopped — it's the phone's doorway to `remote start` the fleet back (override: `--include-anchor`). **`stop --last-start`** = undo the last start: stops only the sessions that run launched, already-live ones untouched. **`start --last-start`** = reopen exactly that recorded set (duplicate-guarded; never rewrites the record, so the pair toggles the same set; no record = clean error). Repo set: `config/remote_fleet.txt` |
| `schedule plan` | **Mythos plan + 10-day schedule → ship → wrap.** Writes `plan/MYTHOS_IMPROVEMENT_PLAN.md` + `plan/schedule.json`, posts the 10-day schedule to dashboard `/plan`, queues tasks for the off-hours CLI runner, then auto-runs `ship it` + `wrap up -u`. See [Autonomous Runner](#-autonomous-runner--work-that-ships-while-you-sleep). |
| `schedule <desc>` / `schedule list` | Queue one autonomous task for this repo / list the queue (`schedule_task.sh`). |
| `wrap up` / `wrap up -u` | **Session close.** Runs `schedule plan` **first**, then session-close (state/handoff/log), rotate, App Directory card, traffic-light dashboard, `update_all` + README refresh, WRAPPED-UP banner. **`-u` (urgent)** skips `schedule plan`, `update_all`, and the README refresh. |
| `init [path]` | Run `./scripts/init_ai.sh [path]` to bootstrap the AI framework into a new project |
| `init connect [path]` | **Install Connect Hub module** into a project. Copies templates + instruction doc. Local agent uses `connect setup` to integrate. |
| `sync all` | Run `./scripts/update_all.sh` to push latest framework to all managed repos (without committing master) |
| `health check` | Run `./scripts/health_check.sh` to verify compliance across all managed repos |
| `add repo [path]` | Add a new project path to `config/managed_repos.txt` and run init + sync on it |
| `init [agent]` | Generate an agent's instruction file. e.g. `init copilot`, `init gemini`, `init all`. Reads paths from `config/agent_paths.conf` |
| `show urls` | Show all deployment URLs across all managed repos (production + preview) |
| `make preview` | Set up test→preview pipeline for a specific repo |
| `make prod` | **Productionise with branching.** Set up `test` branch + CI + branch protection + Vercel/Render/Atlas provisioning. Check existing config first — skip what's already done |
| `ai tools` | **Fleet inventory.** Show 5 agents, 5 skills, 5 MCP tools, and all 4 gateway route surfaces. Reads live from `:3100` / `:3200` when the gateway is up, otherwise falls back to source files. See [`ai tools`](#ai-tools--fleet-inventory-command) |
| `more agents` | Expand to the full 57-agent list grouped by category |
| `more skills` | Expand to the full 135-skill list with triggers |
| `more mcp` / `more mcp tools` | Expand all 15 MCP tool definitions with input schemas |
| `more routes` | Expand every HTTP, WebSocket, MCP, and dashboard route |
| `ai tools help` / `help ai tools` | Usage block for the `ai tools` command |
| `yolo [minutes]` | **Timed autonomous mode.** No permission prompts or clarifying questions for N minutes. Safety rails still enforced |
| `yolo god` | **Full autonomous mode.** No questions until plan complete or next commit — whichever first |
| `yolo off` | Deactivate YOLO mode immediately |

---

## `ai tools` — Fleet Inventory Command

Type `ai tools` in any CLI session to get a compact snapshot of everything the framework currently exposes: agents, skills, MCP tools, and gateway routes. The agent prints **5 of each** by default — ask for more with the sub-commands below.

### Default behaviour

```
ai tools
```

Outputs four blocks (5 rows each):
1. **Agents** — name, category, one-line description
2. **Skills** — name, description, trigger keywords
3. **MCP tools** — name, category, purpose
4. **Gateway routes** — one row per protocol surface (`:3100`, `:3200`, `:3201`, `:3210`)

Every block ends with a `… N more — run "more <type>" to see all` hint.

### Sub-commands

| Command | Action |
|---------|--------|
| `ai tools` | Show 5 of each category |
| `more agents` | Dump all 64 agents grouped by category |
| `more skills` | Dump all 136 skills |
| `more mcp tools` or `more mcp` | Dump all 124 MCP tools with full input schemas |
| `more routes` | Dump all HTTP + WS + MCP + dashboard routes (same as the Gateway Routes section above) |
| `ai tools help` or `help ai tools` | Print this usage block |

### Help output

```
ai tools — Fleet inventory

USAGE
  ai tools              Show 5 agents, 5 skills, 5 MCP tools, all route surfaces
  more agents           Expand the full 57-agent list
  more skills           Expand the full 135-skill list
  more mcp              Expand all 15 MCP tool definitions
  more routes           Expand every HTTP/WS/MCP/dashboard route
  ai tools help         This help

SOURCES
  Agents     → .claude/agents/  (loaded on gateway startup)
  Skills     → .claude/skills/  (auto-discovered)
  MCP tools  → runtime/src/mcp/tools.ts  +  live at http://localhost:3100/mcp
  Routes     → runtime/src/core/server.ts, ws/handler.ts, mcp/handler.ts, dashboard/src/app

NOTES
  Runs against the live gateway when it's up (reads :3100 and :3200).
  Falls back to reading the source files if the gateway is down.
  Full reference lives in the "Gateway Routes & Endpoints" section of this README.
```

---

## Bootstrap & integrate (legacy operator flow)

### Step 1: Bootstrap a New Project
*Use this when you are in the `ai_management` repository and want to copy the framework to a new or existing project folder.*

**Copy-Paste Prompt for the AI Agent:**
```markdown
Run the following script to copy the AI framework to my project:
./scripts/init_ai.sh [PATH_TO_YOUR_PROJECT]

Ensure all AI management folders and standard templates (.gitignore, .dockerignore, .env.example) are copied and initialized. 
Once completed, ask me if this is a "New Project" or an "Existing Project", and then output the appropriate "Step 2" prompt from your instructions so I can copy and paste it into my next agent.
```

### Step 2: Initialize or Integrate

Once the files are copied, open your **Target Project** in your AI agent and use one of the following prompts:

**Option A: New Project (Starting from scratch)**
```markdown
Initialize the AI Management Folder for this project. Use the standards defined in 'AI/documentation/global_ai_management_prompt.md'. Ensure the './AI' directory is created with all subdirectories. Initialize the project as a Git repository following the mandated tech stack: Docker, Next.js, MongoDB, Render.com, and GitHub Actions.
```

**Option B: Existing Project (Migration)**
```markdown
I am integrating this existing repository into the Global AI Management Framework. Please execute the steps in 'AI/documentation/INTEGRATION_GUIDE.md' sequentially to migrate existing folders, logs, and state into the standardized framework while enforcing global tech mandates. Be sure to use `glob` to scan the ENTIRE workspace recursively to find scattered documentation and logs.
```

---

## Introduce a new AI agent

When you want to use a new AI coding tool with this framework:

```bash
# From any project with the AI framework:
init copilot        # Tell your AI agent
init gemini         # Or run the script directly:
./AI/scripts/introduce_agent.sh copilot

# From the master repo:
./scripts/introduce_agent.sh gemini
./scripts/introduce_agent.sh all    # All 8 agents
```

Agent file paths are defined in `config/agent_paths.conf` — same for every repo.

### Supported Agents

| Agent | Instruction File | Auto-Discovery |
|-------|-----------------|----------------|
| `claude` | `CLAUDE.md` | Claude Code reads at startup |
| `gemini` | `GEMINI.md` | Gemini CLI reads at startup |
| `copilot` | `.github/copilot-instructions.md` | GitHub Copilot reads at startup |
| `cursor` | `.cursor/rules/myai.mdc` | Cursor reads at startup |
| `windsurf` | `.windsurfrules` | Windsurf IDE reads at startup |
| `cline` | `.clinerules` | Cline reads at startup |
| `aider` | `CONVENTIONS.md` + `.aider.conf.yml` | Aider reads at startup |
| `agents-md` | `AGENTS.md` | Cross-tool standard (Linux Foundation) |

### Examples

```bash
init copilot       # Generates .github/copilot-instructions.md
init cursor        # Generates .cursor/rules/myai.mdc
init gemini        # Generates GEMINI.md
init all           # All 8 agents at once
```

### What the Script Does

Each generated file contains the same core instructions:
- Session start protocol (read state files)
- 64 specialist agents and their domains
- Quick keywords (`hello`, `agent mode`, `ship it`, etc.)
- State management rules (autonomous updates)
- Critical project rules (Docker, pipeline relay, timeouts)

The file is formatted for the target agent's auto-discovery mechanism. Once generated, the agent reads it automatically — no manual prompting needed.

### Adding a Completely New Agent

If a new AI coding tool comes out that isn't in the list:

1. Find out what instruction file it reads (check its docs)
2. Add a `generate_[name]()` function to `scripts/introduce_agent.sh`
3. Run `./scripts/update_all.sh` to push to all managed repos

The core instructions are defined once inside the script — adding a new agent is just a new output format for the same content.

---

## Powerhouse Workspace Integration

The framework integrates with a portable, AI-agnostic knowledge base at `~/your-knowledge-base/` (the "central context layer" — survives Anthropic account / subscription / device / tool changes). 17 keywords route from this CLI to that folder via the auto-memory pointer:

| Keyword | What it does |
|---------|--------------|
| `office mode` | Bootstrap the Powerhouse workspace — read INDEX/MASTER_MEMORY/HANDOFF, report status across all captured projects |
| `office status` | Just the status snapshot (capture state per project) |
| `who is <name>` | Look up `_master/people.md` + cross-project mention count |
| `recall <topic>` | Full-text search across every captured `PROJECT_SUMMARY/*.md` |
| `chase list` / `who do I owe?` | Aggregate blockers + in-flight items, optionally grouped by external counterparty |
| `meeting prep <person>` | Bundle every fact about a person + their open threads into a prep doc |
| `draft email to <person>` | 3 labelled variants in your voice, no em dashes, R. sign-off |
| `review vendor doc <path>` | Observation → Proposal/Question/Request → Owner format |
| `morning brief` / `weekly sweep` | Curated digests at different cadences |
| `intake <project>` / `capture <project>` / `refresh <project>` | Version a new summary / print the capture prompt / print the refresh prompt |
| `style check <path>` | Mechanical scan for em dashes + banned filler (auto-fix available with `--fix`) |
| `migrate bundle` | Package latest-summary-per-project for upload into a new Claude.ai account |

Full reference: `~/your-knowledge-base/KEYWORDS.md`. Type any keyword from any CLI Claude session — no need to `cd` first.

---

## AgentFlow — local development with AI agents

AgentFlow ([knofler/agentFlow](https://github.com/knofler/agentFlow)) is the AI-Driven Project Delivery Platform built on this framework. It lives in its own standalone repo and runs in Docker with support for both **cloud AI APIs** and **locally installed CLI tools** (Claude Code, Gemini CLI, GitHub Copilot, Aider).

### Standard Start (Cloud AI only)

```bash
cd ~/code/agentFlow
docker compose up -d
```

Open http://localhost:3400. Add API keys in **Settings > AI Providers**.

### Power User Start (Local CLI + Cloud AI)

```bash
cd ~/code/agentFlow
./dev
```

The `./dev` command starts a bridge server on your host machine alongside Docker. This gives the app access to your locally installed AI tools — **zero API cost** for tasks routed through them.

```
 Your Machine                          Docker Container
+---------------------------+         +----------------------+
|                           |  HTTP   |                      |
|  Bridge Server (:3401)    | <------ |  AgentFlow App       |
|  Spawns: claude, gemini   |         |  localhost:3400      |
|  Uses YOUR subscriptions  |         |                      |
+---------------------------+         +----------------------+
```

### `./dev` Commands

| Command | What It Does |
|---------|-------------|
| `./dev` | Start everything (bridge + Docker) |
| `./dev stop` | Stop everything |
| `./dev status` | Show running services + detected CLI tools |
| `./dev doctor` | Check prerequisites on this machine |
| `./dev restart` | Full restart |
| `./dev logs` | Tail bridge server logs |

### Prerequisites per Machine

| Required | Optional (enables local agents) |
|----------|---------------------------------|
| Docker | Claude Code (`claude`) |
| Node.js | Gemini CLI (`gemini`) |
| | GitHub Copilot (`gh` + extension) |
| | Aider (`aider`) |

### Agent Assignment

In **Settings > Local Agents**, assign which AI agent handles each task type:

| Task Type | Description |
|-----------|-------------|
| Code Generation | Writing code, scaffolding, implementations |
| Document Writing | BRDs, TRDs, plans, documentation |
| Code Review | PR reviews, bug finding, suggestions |
| Architecture | System design, ADRs, tech decisions |
| General | Chat, brainstorming, Q&A |

Each dropdown has two groups:
- **Local CLI (no API cost):** Claude Code, Gemini CLI, GitHub Copilot
- **Cloud API (uses tokens):** Anthropic, OpenAI, Google, DeepSeek, Ollama

**Auto-Fallback:** If the assigned agent fails, the next available agent picks up automatically.

### Services

| Service | URL |
|---------|-----|
| App | http://localhost:3400 |
| Bridge Server | http://127.0.0.1:3401 |
| MongoDB | localhost:27051 |
| Mongo Express | http://localhost:8081 |

### Full Documentation

See the [AgentFlow repo docs](https://github.com/knofler/agentFlow/blob/main/docs/AI_PROVIDERS.md) for complete provider setup, API endpoints, architecture, troubleshooting, and FAQ.

---

## Master Repo Structure

```text
.
├── CLAUDE.md                       # Claude Code instruction file (auto-read)
├── GEMINI.md                       # Gemini CLI instruction file (auto-read)
├── README.md                       # This file
├── .claude/
│   ├── agents/ → ../agents/        # Symlink — Claude Code auto-discovers agents
│   └── skills/ → ../skills/        # Symlink — Claude Code auto-discovers skills
├── agents/                         # 64 agent definitions (all tools)
├── skills/                         # 60 skill playbooks (skills/*/SKILL.md)
├── state/
│   ├── STATE.md                    # Current progress & blockers
│   └── AI_AGENT_HANDOFF.md         # Instructions for the next agent
├── logs/
│   ├── claude_log.md               # Claude agent log
│   ├── gemini.md                   # Gemini agent log
│   └── copilot.md                  # Copilot agent log
├── documentation/
│   ├── AI_RULES.md                 # Global tech mandates + multi-agent protocol
│   ├── Instruction.md              # Workflow and usage guide
│   ├── global_ai_management_prompt.md
│   ├── INTEGRATION_GUIDE.md        # Migration guide for existing repos
│   └── MULTI_AGENT_ROUTING.md      # Routing reference for all specialists
├── architecture/                   # System design & ADRs
├── design/                         # UI/UX specs & assets
├── plan/                           # Roadmaps & feature plans
├── scripts/
│   ├── init_ai.sh                  # Bootstrap a new project
│   ├── update_all.sh               # Sync framework to all managed projects
│   ├── health_check.sh             # Verify compliance across all repos
│   ├── introduce_agent.sh          # Generate instruction files for AI agents
│   └── make_prod.sh                # Production deployment automation
├── templates/
│   ├── CLAUDE_TEMPLATE.md          # Copied as CLAUDE.md to target projects
│   ├── api/                        # API docs templates (openapi-spec.ts, docs-route.ts)
│   ├── design/                     # Design system templates (postcss, globals.css, utils.ts)
│   ├── mcp.json                    # Base MCP config (all repos)
│   ├── mcp-web.json                # Chrome DevTools overlay (web projects)
│   ├── mcp-docker.json             # Docker overlay (Docker projects)
│   └── mcp-api.json                # OpenAPI overlay (API projects)
└── config/
    └── managed_repos.txt           # List of managed projects
```

> **Running `init_ai.sh` / `update_all.sh` / `health_check.sh` on Windows?**
> Best-effort, CI-tested tier via Git Bash or WSL2 — full guide:
> [`documentation/WINDOWS_FRAMEWORK_SCRIPTS.md`](./documentation/WINDOWS_FRAMEWORK_SCRIPTS.md).
> (For the autonomous CLI runner on Windows, see `documentation/WINDOWS_RUNNER.md` instead.)

### Instruction Files Generated per Project

When `introduce_agent.sh` runs (or `init_ai.sh` / `update_all.sh`), these files are created in the target project:

```text
project-root/
├── CLAUDE.md                       # Claude Code
├── GEMINI.md                       # Gemini CLI
├── AGENTS.md                       # Cross-tool standard (Linux Foundation)
├── CONVENTIONS.md                  # Aider
├── .github/copilot-instructions.md # GitHub Copilot
├── .cursor/rules/myai.mdc  # Cursor
├── .windsurfrules                  # Windsurf
├── .clinerules                     # Cline
├── .aider.conf.yml                 # Aider config
└── AI/                             # Framework directory (same in all projects)
```

---

## 📚 Docs, comparisons & hands-on guides

The full **documentation site** is auto-built from `docs/` (zero-dependency generator, no framework) and deployed to GitHub Pages: **<https://knofler.github.io/ai_management/>**. Start there for the [Quickstart](./docs/quickstart.md), [Concepts](./docs/concepts.md), and the auto-generated CLI / MCP-tool references.

| Guide | What it covers |
|-------|----------------|
| 📊 **[Comparison hub](./docs/compare.md)** | An **honest** map of myAI vs [Mem0](./docs/compare-mem0.md) / [Zep](./docs/compare-zep.md) / [Ruflo](./docs/compare-ruflo.md) / [Composio](./docs/compare-composio.md) / [Langfuse](./docs/compare-langfuse.md) — summary matrix + per-tool pages. Most are **complementary**, not rivals: run myAI next to whichever you already use. |
| 🧪 **[Try myAI in ~10 min](./TRY_MYAI.md)** | Install the CLI from a local build, scaffold a throwaway project, bring the stack up on free ports, tear it down — a real cold-start test that never touches a live stack. |
| 🧠 **[Try the Brain in ~5 min](./TRY_BRAIN.md)** | Prove git-versioned agent memory by hand: init → work → stash → pop from a second agent → merge → diff. No gateway, no Docker, no API key. |

---

## 🔗 Connect Hub — Help Desk, Bug Reports, Feature Requests

A portable module that adds `/connect` routes to any Next.js app with AI-integrated bug tracking and feature management. Users report bugs and request features; your AI agent triages, fixes, and ships them — updating status on the live pages automatically.

### How to Install

**Step 1 — From master repo** (you or the master AI agent):
```bash
./scripts/init_connect.sh /path/to/project
```
This copies 15 template files (3 models, 8 API routes, 4 pages) + the instruction doc `AI/documentation/CONNECT_HUB.md`.

**Step 2 — In the target project** (local AI agent):
```
connect setup
```
The local agent reads `AI/documentation/CONNECT_HUB.md` and follows Steps 1-8: fix imports, update middleware, add nav item, type check, test.

### What Gets Installed

| Category | Files | Location |
|----------|-------|----------|
| Models | BugReport, FeatureRequest, HelpArticle | `src/models/` |
| API | bugs CRUD, features CRUD+vote, help+feedback, context | `src/app/api/connect/` |
| Pages | Dashboard, bug form+list, feature form+list, help FAQ | `src/app/connect/` |
| Docs | Integration instructions | `AI/documentation/CONNECT_HUB.md` |

### AI Agent Keywords (after installed)

| Keyword | What happens |
|---------|-------------|
| `connect setup` | Local agent integrates the module (imports, middleware, nav, type check) |
| `check bugs` | Pull open bugs from DB, list by severity, suggest fix order |
| `fix bug [id]` | Pull bug, implement fix, push to test, PR, update DB status to deployed |
| `check features` | Pull feature requests from DB, list by priority + votes |
| `build feature [id]` | Pull feature, implement, push to test, PR, update DB status to deployed |
| `triage` | AI analyses all "reported" items, sets severity/priority, assigns agents |

### Bug & Feature workflows

```
User reports bug via /connect/bug → saved to DB (status: reported)
→ AI agent: "check bugs" → lists all open bugs
→ AI agent: "fix bug [id]" → pulls from DB, implements fix, creates PR
→ PR merged → AI updates DB (status: deployed) → reflected on /connect/bug page
```

```
User requests feature via /connect/feature → saved to DB (status: reported)
→ AI agent: "check features" → lists all requests by priority/votes
→ AI agent: "build feature [id]" → pulls from DB, implements, creates PR
→ PR merged → AI updates DB (status: deployed) → reflected on /connect/feature page
```

**Status lifecycle:** `reported → triaged → working → solved → deployed` (or `rejected`/`duplicate`). **AI can also auto-detect bugs** during code review and create reports with `reportedBy: "ai"`.

### Feature/Bug Lifecycle — Who Does What

| Step | Who | What happens |
|------|-----|-------------|
| User submits feature/bug on prod | User | Status: `reported` in MongoDB |
| You say `check features` or `check bugs` | AI | Queries DB, shows the list |
| You say `build feature [id]` or `fix bug [id]` | AI | Status → `working`, AI implements on `test` branch |
| You test on preview URL | User | Verify it works on Vercel preview |
| You say `merge it` | AI | Merge test → main, status → `deployed` |

**Key rules:**
- Features/bugs are submitted to the **same MongoDB** (Atlas) whether from prod or preview
- Code always goes through `test` first — the status only becomes `deployed` after merge to `main`
- The AI agent updates the DB status at each step — the `/connect` pages reflect current status automatically
- Status lifecycle: `reported` → `triaged` → `working` → `solved` → `deployed` (or `rejected`/`duplicate`)

Full integration guide with DB queries, status lifecycle, and troubleshooting: `AI/documentation/CONNECT_HUB.md`

---

## 🔧 Maintenance & contributing

To update the global standards, modify `documentation/AI_RULES.md` in this repository and push to GitHub:
`git@github.com:knofler/ai_management.git`

Every change goes through the branching workflow: push to `test` → CI → PR to `main` → merge. Never push directly to `main`. See [Branching Strategy](#branching-strategy--production-safety).

**License:** MIT. This framework is designed to be shareable and operator-agnostic — the dashboard is data-driven and never hardcodes any one operator's repos.
