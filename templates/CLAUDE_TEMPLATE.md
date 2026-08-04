# Claude Code — Project Routing Rules

> This file is read by Claude Code at project startup. It defines how to route tasks to specialist subagents and when to dispatch in parallel.

---

## CRITICAL RULES (read before doing anything)

1. **NEVER push directly to `main`.** All code goes to `test` branch first. Push to `test` → verify preview → PR to `main` → merge. This is non-negotiable.
2. **NEVER run `npm install`, `npm ci`, `npx`, or `node` on the host machine.** Always use `docker compose exec app <command>`. Only exception: CI runners.
3. **NEVER commit `node_modules/`, `.env`, or secrets.** Check `.gitignore` before staging.
4. **Docker container naming:** All `container_name` in `docker-compose.yml` MUST use the **exact folder name** as prefix (preserve casing): `{folderName}-app`, `{folderName}-mongo`, `{folderName}-api`. Example: folder `acme` → `acme-app`, `acme-mongo`. If non-compliant → `docker compose down`, fix names, rebuild.
5. **Frontend standard: Tailwind CSS + shadcn/ui.** All Next.js projects use Tailwind v4 (CSS-first `@theme` config) + shadcn/ui components. Utility-first classes only — no CSS modules, no styled-components, no inline styles. Design tokens in `globals.css`, shadcn components in `src/components/ui/`, `cn()` helper in `src/lib/utils.ts`. Full guide: `AI/documentation/DESIGN_SYSTEM.md`.
6. **Git email fix (auto-fix on push failure).** If `git push` fails with `GH007` or `email privacy`, fix immediately — do NOT ask the user. Run: `git config user.email "YOUR_ID+yourname@users.noreply.github.com"` then amend with `GIT_COMMITTER_EMAIL="YOUR_ID+yourname@users.noreply.github.com" GIT_COMMITTER_NAME="Your Name" git commit --amend --no-edit --author="Your Name <YOUR_ID+yourname@users.noreply.github.com>"`. Both author AND committer must use noreply. Never change `--global` config.
7. **API documentation is mandatory.** Any project with API endpoints MUST have: (a) OpenAPI 3.0 spec at `/api/openapi.json`, (b) Scalar interactive docs at `/docs` (`@scalar/nextjs-api-reference`), (c) OpenAPI MCP server in `.mcp.json`. Every new endpoint must be added to the OpenAPI spec — undocumented endpoints are not complete. Templates: `AI/templates/api/`.
8. **CI/Vercel Thrift (credit-burn policy).** CI and Vercel must NOT run on every push. **Verify locally in Docker first** (`./AI/scripts/local-ci.sh` — tsc + tests + build). `.github/workflows/ci.yml` triggers on `pull_request: [main]` + `workflow_dispatch` ONLY (no `push` trigger) — pushes to `test` cost zero CI runs. `vercel.json` gates deploys to production: `"git": {"deploymentEnabled": {"main": true, "test": false}}`. A `pre-push` hook runs local-ci before pushing. Don't re-add `push:` triggers or remove the Vercel gate. Master rolls this out via `rollout_ci_thrift.sh`.

---

## Keyword Execution Protocol (MANDATORY for all keywords)

When executing ANY keyword (`ship it`, `make prod`, `make preview`, `agent mode`, etc.), you MUST follow this protocol:

1. **Announce**: Before starting, list ALL steps you will execute as a numbered checklist.
2. **Report per step**: Before each step, say what you're about to do. After each step, report the result (done/skipped/failed).
3. **No silent steps**: Never perform a step without announcing it first and reporting the outcome.
4. **Summary table**: After ALL steps are complete, output a summary table:

```
| # | Step | Status | Notes |
|---|------|--------|-------|
| 1 | Commit changes | Done | 3 files changed |
| 2 | Push to test | Done | CI triggered |
| 3 | Wait for CI | Done | All checks passed |
| ... | ... | ... | ... |
```

Status values: `Done`, `Skipped` (with reason), `Failed` (with error).

This protocol is **mandatory** — never skip the announcement, per-step reporting, or summary table.

---

## On Session Start

1. **Multi-machine check** (MANDATORY): Run `hostname -s`, compare with `Last machine:` in `AI/state/AI_AGENT_HANDOFF.md`. If different machine → clean Dropbox conflicts, rebuild Docker (`docker compose down && docker compose up -d --build`), verify build. See `AI/documentation/MULTI_MACHINE_WORKFLOW.md`.
2. **2 GB RAM ceiling check** (MANDATORY — auto-runs via hook `hooks/session/13-ram-guard.sh`): This project's Docker stack must not exceed 2 GB total RAM. Hook sums `docker stats` across project containers and warns if over. Fix: add `mem_limit` to compose services (suggested split: app 1g + db 512m + sidecars 512m). Exempt a heavy-model repo with `touch .ram-exempt`.
3. Read `AI/state/STATE.md` and `AI/state/AI_AGENT_HANDOFF.md` to synchronize project context
4. Read `AI/documentation/AI_RULES.md` for technical mandates
5. Review `AI/documentation/MULTI_AGENT_ROUTING.md` for routing reference
6. Dispatch `project-manager` to assess current status and identify the next work priority

---

## CLI-Mobile Agent Workflow (Codeclot Branch Strategy)

This framework enables seamless mobility between **mobile Claude** (phone/tablet/browser) and **CLI Claude** (desktop/laptop). Every repo is self-contained — open any repo on any device and `agent mode` gives you full context immediately.

### The Cycle

```
MOBILE SESSION                          CLI SESSION
─────────────                           ───────────
1. agent mode                           1. agent mode
   → fetch origin                          → fetch origin
   → pull latest main                      → pull latest on current branch
   → read state + handoff                  → merge codeclot* branches
   → checkout codeclot from main           → delete merged codeclot
   → full context available                → read state + handoff

2. Do work (code, fix, plan)            2. Do work (code, fix, plan)

3. wrap up                              3. ship it
   → commit ALL to codeclot branch          → push to test → CI → PR → merge main
   → push codeclot to remote                → state + handoff updated on main
   → state + handoff in codeclot         4. wrap up
                                            → push state to test/main
                                            → all changes on main for next mobile
```

### Auto-Detection
- The multi-machine check hook detects hostname. If hostname is `vm` (cloud sandbox), the session is classified as a **mobile/cloud session**.
- Mobile/cloud sessions use `codeclot` as their working branch instead of `test`.
- Override: set env var `CODECLOT_OVERRIDE=1` to force codeclot behavior on any hostname, or `CODECLOT_OVERRIDE=0` to disable on `vm`.

### Branch Naming
- **Default:** `codeclot` — primary mobile session branch
- **Claude Code web auto-branches:** Claude Code web/mobile auto-creates branches named `claude/agent-mode-*` or `claude/*`. Treated identically to `codeclot` — they are mobile sync branches.
- **Multiple unmerged sessions:** If `codeclot` exists on remote with unmerged changes, create `codeclot/<YYYYMMDD-HHMM>`
- **Pattern match for all mobile branches:** `codeclot*` OR `claude/*` — CLI agent mode must check BOTH patterns

### On `agent mode` (Mobile/Cloud Session) — MANDATORY FIRST STEPS

**CRITICAL: You MUST pull latest `main` before doing ANYTHING else. The code on your branch is stale — `main` has the latest from CLI sessions.**

1. `git fetch origin`
2. `git checkout main && git pull origin main` — **get latest production code**. Without it, you work on stale code and stale state.
3. Read `AI/state/AI_AGENT_HANDOFF.md` and `AI/state/STATE.md` — NOW up-to-date.
4. Create or checkout working branch from latest main: `git checkout -b codeclot` (or `codeclot/<timestamp>` if codeclot exists on remote with unmerged changes). If Claude Code web auto-created a `claude/agent-mode-*` branch, ensure it's based on latest main (`git merge main` into it).
5. Continue with normal agent mode workflow.

### On `agent mode` (CLI Session — Mobile Branch Merge Step)
CLI sessions MUST merge any pending mobile work before starting:
1. `git fetch origin`
2. `git pull origin <current-branch>`
3. `git branch -r | grep -E 'codeclot|claude/'`
4. If any exist: diff each against `main`, report contents, merge into current branch, delete merged (local + remote).
5. On merge conflict → report details and **ask user** before proceeding.
6. Continue with normal agent mode workflow.

### On `wrap up` (Mobile/Cloud Session)
In addition to standard wrap-up:
1. Commit ALL changes (code + state + handoff + logs) to working branch (`codeclot` or `claude/*`)
2. Push to remote: `git push -u origin <branch>`
3. Update `AI/state/AI_AGENT_HANDOFF.md` with: branch name, summary, merge-readiness status
4. YOLO god auto-commits are compatible (push is non-interactive)

### On `wrap up` / `ship it` (CLI Session)
After shipping code to main:
1. State files (STATE.md, AI_AGENT_HANDOFF.md, logs) are committed to `test` and merged to `main` — next mobile session pulling `main` gets full context
2. Always update handoff with: what was done, what's next, current blockers

### Safety Rules
- `codeclot` and `claude/*` are **sync branches only** — never deployed to production
- Mobile → `main` merge follows normal review process (via `ship it` or PR on CLI)
- `health_check.sh` flags repos with unmerged mobile branches older than 7 days
- Every repo is self-contained: STATE.md, HANDOFF, logs, agents, skills — mobile Claude needs nothing else

---

## Specialist Subagents Available

Claude Code auto-discovers agents from `AI/.claude/agents/` and skills from `AI/.claude/skills/`:

| Agent | Trigger Keywords |
|-------|-----------------|
| `solution-architect` | architecture, design, ADR, scalability, "should we use X or Y" |
| `frontend-specialist` | component, page, frontend, UI, Next.js, React, Vercel |
| `api-specialist` | endpoint, route, API, controller, middleware, REST, GraphQL |
| `database-specialist` | schema, model, query, database, MongoDB, index, migration |
| `devops-specialist` | docker, deploy, pipeline, environment, CI/CD, GitHub Actions |
| `ui-ux-specialist` | design system, layout, style, UX, accessibility, Tailwind |
| `security-specialist` | security, auth, JWT, permissions, OWASP, rate limit |
| `documentation-specialist` | docs, README, document, guide, changelog |
| `product-manager` | feature, requirement, user story, roadmap, MVP, backlog |
| `qa-specialist` | test, QA, coverage, E2E, unit test, bug, regression |
| `tech-ba` | requirements, data flow, gap analysis, functional spec, business rule |
| `tech-lead` | code review, standards, coherence, technical decision, review |
| `project-manager` | project plan, milestone, blocker, risk, status, sprint, track |

---

## Parallel Dispatch Rules

### Always Parallel (no dependencies)
```
Lane C (Infrastructure) — start immediately on any project:
  devops-specialist: Docker + docker-compose + env vars + CI/CD
  security-specialist: auth approach + secrets review

Lane D (Async) — always parallel:
  documentation-specialist: README skeleton
  project-manager: STATE.md update + task tracking
  solution-architect: ADRs for major decisions
  product-manager: feature specs
  tech-ba: requirements documentation
```

### Parallel When No Shared State
```
Lane A (Frontend): frontend-specialist + ui-ux-specialist
Lane B (Backend):  api-specialist + database-specialist

Lanes A and B can run in parallel when API contracts are pre-defined.
```

### Sequential When Output is a Dependency
```
database-specialist schema → THEN api-specialist services
api-specialist contracts → THEN frontend-specialist fetch logic
devops-specialist env setup → THEN any implementation that references env vars
solution-architect ADR → THEN implementation of that architectural decision
```

---

## Project-Type Dispatch

### New Next.js App
```
Immediate parallel:
  frontend-specialist, ui-ux-specialist, devops-specialist, documentation-specialist, project-manager

Then (after contracts defined):
  api-specialist, database-specialist

Always parallel:
  security-specialist, qa-specialist, solution-architect
```

### API-Heavy Project (Node.js or Python)
```
Immediate parallel:
  api-specialist, database-specialist, devops-specialist, security-specialist, documentation-specialist

Async parallel:
  solution-architect, tech-ba, project-manager

Then if UI needed:
  frontend-specialist, ui-ux-specialist
```

### Any Project — Always Start With
```
devops-specialist → Docker + env vars
security-specialist → auth + .env review
documentation-specialist → README
project-manager → STATE.md
```

---

## MCP Servers (Auto-Configured)

Configured in `.mcp.json`, auto-managed by `update_all.sh`.

**Base (all projects):** Context7 (library docs), shadcn/ui (component browser), Playwright (E2E browser testing), Dropbox (file access via OAuth), myai (local gateway when Docker running).

**Conditional (auto-detected):**
- **Chrome DevTools** — web project (has `next.config.*` / `vercel.json` / `src/app/layout.tsx`) → browser console, network, screenshots
- **Google Stitch** — web project (auto with Chrome DevTools) → AI UI design
- **Docker** — has `docker-compose.yml` → container logs, exec, management (uses `{folderName}-*` naming)
- **OpenAPI** — has `src/app/api/` / `src/routes/` / `routes/` → exposes API endpoints as MCP tools from `/api/openapi.json`

**API-Key servers (add when ready):** see `AI/plan/MCP_SERVERS.md` for Brave Search, Figma, Sentry, MongoDB Atlas, Vercel, Upstash, Notion, Slack.

---

## Skills (60 Playbooks)

Each agent has 3-5 skills — repeatable playbooks auto-discovered from `AI/.claude/skills/`. Skills trigger when your prompt matches their keywords. See `AI/skills/README.md` for the full catalog.

---

## Quick Keywords — Core (always loaded)

Short phrases the user may type instead of full prompts. The keywords below have their full protocol inline because the model needs them in context every session. **Extended keywords** (status, review, plan, scaffold, audit, handoff, list, show urls, check bugs, fix bug, make prod, ai tools, etc.) live in `AI/documentation/KEYWORDS_REFERENCE.md` — Read that file when one of those triggers.

| Keyword | Action |
|---------|--------|
| `hello` | Show all available keywords and their usage as a table. Read `AI/documentation/KEYWORDS_REFERENCE.md` for the extended list. |
| `jam` / `jam <idea>` | **Collaborative ideation — brainstorm BEFORE building.** Flip from executor to thought-partner: explore the idea WITH the user, push back, weigh options + tradeoffs, ask the sharpening questions. **Explicit EXCEPTION to the zero-prompt/YOLO policy — in a jam, questions and dialogue ARE the work.** A *conversation*, not a multiple-choice interrogation. **No code, edits, or commits during the jam.** Persistent mode — holds until `build it` / `jam done`. **On convergence → brief + register:** write a brief to `AI/plan/jam/<slug>.md` AND register it as a plan (`plan_set` → master gateway dashboard `/plan`). **Then → DECISION POINT (nothing auto-builds):** (1) **schedule it** (`schedule_task` → runner, or `agent mode` to build now, or `init blueprint` for a new app); (2) **more jam** (keep refining); (3) **park it**. Full protocol: `AI/documentation/KEYWORDS_REFERENCE.md` → "Jam". |
| `start work` | **0. Multi-machine check (MANDATORY):** Run `hostname -s`, read `Last machine:` from `AI/state/AI_AGENT_HANDOFF.md`. If different → read `AI/documentation/MULTI_MACHINE_WORKFLOW.md` and execute the full checklist: clean Dropbox conflicts, rebuild Docker (`docker compose down && docker compose up -d --build`), verify build. **1.** Read `AI/state/STATE.md` + `AI/state/AI_AGENT_HANDOFF.md`. Assess status. Report what's done, in-progress, blocked. Identify next priority. |
| `agent mode` / `agent mode -a` (or `--auto`) | **Full multi-agent activation.** 0. **Project identity:** Display current project/repo name prominently. 0a. **Git sync (DO FIRST, BEFORE READING ANY FILES):** `git fetch origin`. **Mobile session** (hostname=`vm` or `CODECLOT_OVERRIDE=1`): `git checkout main && git pull origin main` → create working branch (`codeclot` or `codeclot/<timestamp>`). **CLI session** (other hostnames): `git pull origin <current-branch>`. **State on disk may be stale — pull first.** 0b. **Multi-machine check:** `hostname -s`, compare with handoff. If different → full checklist. 0c. **Docker naming check:** Verify `container_name` in docker-compose.yml uses `{reponame}-` prefix. If not → down, fix names, `up -d --build`. 0d. **Mobile branch merge (CLI only, MANDATORY):** `git branch -r \| grep -E 'codeclot\|claude/'`. If found: diff each against `main`, report contents, merge into current branch, delete merged (local + remote). On conflict → ask user. See "CLI-Mobile Agent Workflow". **0d2. State size guard (run if `AI/scripts/rotate_state.sh` exists):** `./AI/scripts/rotate_state.sh`. Idempotent — only rotates when STATE.md exceeds 3 session blocks OR 20k bytes. If a user question references a session older than the 3 in STATE.md, look it up in the archive instead of re-reading STATE.md — grep `AI/state/archive/` by default, or the master gateway's `recall_session` MCP tool when `RAG_RECALL=1` and the session-start hook reports `RAG RECALL: ON`. Skip silently if script missing. **0d3. SCHEDULE banner (MANDATORY, profile-independent — do NOT rely on session hooks):** run `bash hooks/session/17-schedule-status.sh` (or `bash AI/hooks/session/17-schedule-status.sh` if hooks live under AI/) and show its output verbatim — last scheduled run for this repo, next queued task, and CLI-runner status, in AEST. If the script is missing or prints nothing, say 'schedule status unavailable' — never skip silently. **0d3b. Remote-control check (current repo, MANDATORY):** run `bash AI/scripts/remote_fleet.sh status`; if THIS repo's row is NOT `[museum …]` phone-drivable, run `bash AI/scripts/remote_fleet.sh start <this-repo>` and report `📱 remote enabled (<repo>)` — else `📱 remote already on`. Current-repo scope ONLY — never start the fleet here (fleet-wide is the explicit `remote start` keyword; auto-spawning idle museum sessions fleet-wide burns museum credit). Skip silently only if the script is absent. **0d4. Schedule ingest (CLI sessions — the cross-device bridge):** if a committed `AI/plan/schedule.json` exists, run `./AI/scripts/push_schedule.sh` to register any mobile-created plan into the master gateway runner (`plan_set` → dashboard `/plan` + `schedule_task` → runner queue). Idempotent — skips if unchanged. This is how a plan authored on **mobile** (committed to `main`) reaches the master runner on any Mac. Skip silently if no artifact or the gateway is unreachable. **0e. Fresh-blueprint onboarding (MANDATORY when applicable):** Check for `AI/state/.awaiting-app-idea`. If present, this is a fresh Powerhouse Blueprint scaffold and user has not told us what to build. Execute the onboarding flow and **skip the normal agent-mode reporting (steps 1–4)**: (a) Read marker for `scaffolded_at`, `template`, `project`, `gh_repo`. (b) Greet user: `🎉 Welcome to your new {project} blueprint! Tech stack is wired up. To build your app, tell me what you want to build — describe it in plain English (the more detail the better — purpose, users, key features, constraints).` (c) Wait for user's next message — that is the app idea. (d) Save to `AI/state/APP_IDEA.md` with frontmatter (`captured_at`, `project`, `template`) followed by the raw idea. (e) Delete `AI/state/.awaiting-app-idea`. (f) Run the autonomous 8-stage generate pipeline against the captured idea: **idea → plan → brd → gap-analysis → trd → design → build → ship**. For each stage: dispatch appropriate specialist agent (plan: solution-architect, brd: tech-ba + product-manager, gap-analysis: tech-ba, trd: solution-architect + api-specialist + database-specialist, design: ui-ux-specialist + frontend-specialist, build: frontend + api + database in parallel, ship: tech-lead review → push to `test`). Commit each stage as `feat(stage-N): <stage-name> complete`. (g) After **build** stage, pause and tell user: `Stages complete. Review the changes (git log, browse code), then say 'ship it' to push to main, or describe changes you want.` Stop there — do not auto-merge to main. **(f1) Smart-defaults preferred over upfront Q&A.** Do NOT fire a 4-question AskUserQuestion batch. Pick sensible defaults, document them as ASSUMPTIONS in the BRD where user can override on review. Ask at most ONE blocking question (e.g. "do you have a DeepSeek/Anthropic key to drop in, or scaffold blank?"). **(f2) Ask for upstream API keys at build kickoff** if app depends on them — saves a debug cycle later. **(f3) End-of-build core-flow check (MANDATORY):** Run BRD's primary user journey end-to-end with real inputs. "Verified working" = the **core feature** runs, not just that scaffold boots. For an LLM app, run a real generation with a real key. If you couldn't, say so explicitly. **NEVER use admin override to bypass branch protection on main** — use `test → PR → main` even when admin push would technically work. **(i) Lessons Learned (MANDATORY at session end):** When build wraps, write a timestamped lesson at `AI/LL/<YYYY-MM-DD>_<slug>.md` documenting (1) session summary, (2) blueprint gaps with commit SHAs, (3) process gaps in agent's behaviour, (4) recommendations, (5) validated approaches. Master AI controller reviews this folder when amending the upstream blueprint. (h) Update STATE.md + handoff after each stage. 1. **Brain boot — continuity catch-up (replaces the big state READS; same path `agent mode -min` uses).** If the master gateway (`localhost:3100`) is reachable and reports a brain (the `context_boot`/MCP-initialize bundle carries a `Brain:` SHA, or the handoff header has a `Brain: <sha>` line from the last wrap-up), call **`brain_delta`** with `since` = that last-seen SHA — a ~300–800-token diff-only catch-up **instead of bulk-reading `AI/state/STATE.md` + `AI/state/AI_AGENT_HANDOFF.md`**; no/unknown SHA → the ~150-token compiled brief. Remember the returned `sha` as your next anchor. **1-fb. File fallback (no brain / gateway unreachable):** Read `AI/state/AI_AGENT_HANDOFF.md` + the TOP session block of `AI/state/STATE.md`. **1-ref. AI_RULES / MULTI_AGENT_ROUTING are load-on-demand** — Read them only when the task actually needs a specific rule or routing decision; do NOT bulk-read them every session. **1a. Lessons Learned scan:** Read `AI/LL/` (if present). For each lesson file, surface "blueprint gaps" / "process gaps" relevant to today's work — they're warnings from past sessions. If a lesson contains a pattern that applies, reuse it instead of re-deriving. 2. Load SONA context (patterns relevant to current work). 3. Report: completed, in-progress/blocked, next priority. 3b. **Connect Hub check:** If installed (check `src/models/BugReport.ts` or `src/app/api/connect/`), run `check bugs` + `check features` and report findings. 3c. **MCP server check:** Read `.mcp.json` and report which servers are available (name + purpose). Standard base (all repos): myai, Context7, shadcn/ui, Playwright, Dropbox, **GitHub**, **Vercel**. Conditional: Chrome DevTools (web), Docker (Docker projects). Format: "MCP: [server1], [server2], ..." or "no .mcp.json found". 4. Dispatch all relevant lanes in parallel — A (frontend + ui-ux), B (api + database), C (devops + security), D (docs + architect + PM), Cross (tech-lead + QA). 5. Auto-update state and logs after every task. **6. AUTO-MODE (when `-a` or `--auto` flag present):** After step 5, run `./AI/scripts/yolo.sh start god` (or `./scripts/yolo.sh start god` if standalone) and announce: `🟢 AUTO MODE ENGAGED — proceeding autonomously until next commit or task list complete (4h hard cap). All YOLO safety rails preserved: no push to main, no secret commits, no destructive ops without explicit ask.` From this point, do NOT pause for clarifying questions or permission prompts — execute highest-velocity next action against priorities reported in step 3. Same as `yolo god` separately, rolled into one keyword. |
| `agent mode -min` (or `agent min`) | **Lightweight session start — sync + read + report, under a minute.** 1. `git fetch origin && git pull origin <current-branch>` (mobile/cloud sessions: pull `main` first per the full protocol). 2. **Brain boot (preferred when a brain store exists):** if the master gateway (`localhost:3100`) is reachable and reports a brain (the `context_boot`/MCP-initialize bundle carries a `Brain:` SHA, or the handoff header has a `Brain: <sha>` line from the last wrap-up), call **`brain_delta`** with `since` = that last-seen SHA — a ~300–800-token diff-only catch-up **instead of reading the state files**; no/unknown SHA → the ~150-token compiled brief. Remember the returned `sha` as your next anchor. 2b. **File fallback (no brain / gateway unreachable):** Read `AI/state/AI_AGENT_HANDOFF.md` header + ACTION block and the top session block of `AI/state/STATE.md`. 3. Run the SCHEDULE banner hook and show it. **3b. Remote-control check (current repo, MANDATORY — the ONE maintenance action `-min` still does):** run `bash AI/scripts/remote_fleet.sh status`; if THIS repo's row is NOT `[museum …]` phone-drivable, run `bash AI/scripts/remote_fleet.sh start <this-repo>` and report `📱 remote enabled (<repo>)` — else `📱 remote already on`. Current-repo scope ONLY — never start the fleet (that's the explicit `remote start` keyword). Skip silently only if the script is absent. 4. Report: last session, ACTION for next agent, queue status — then await direction. **SKIPS** all other maintenance steps (Docker checks, mobile-branch merge, reconcile, LL scan, MCP report, swarm dispatch). Use full `agent mode` before shipping, after a machine switch, or when state may have drifted. |
| `agent mode -resume` (or `agent resume`) | **Join the last scheduled/headless run for THIS repo and continue its work.** 1. Run the SCHEDULE banner (same script as agent mode step 0d3). 2. Locate the latest runner session log for this repo: `ls -t ~/.ai-cli-runner/logs/*-<repo>-task-*.log 2>/dev/null | head -1` — Read it fully; it is the complete transcript of what the scheduled agent did. 3. Cross-check: the task entry in the gateway store (`tasks_list` filtered to this repo, status review/blocked) + `git log test -5` for the runner's commits. 4. Report a JOIN summary: which task ran, when (AEST), its RESULT line, the commits it pushed, and current task status. 5. Then CONTINUE as that agent: you now own the work — review the diff, fix anything off, and await direction (typically `ship it`, which also flips the task review→done via `tasks_update`). 6. If no runner log exists for this repo, say so and fall back to plain `agent mode`. Works identically in every Claude profile (claude / claude-tech / claude-museum) — it reads files + the shared store, not profile-bound session transcripts. |
| `ship it` | **Safe deployment via test branch.** 1. Commit all changes with descriptive message. 2. Push to `test` (NEVER directly to `main`). 3. Wait for CI to pass (lint, type-check, test). **Local-CI fallback (CI-credit exhaustion / Actions outage) — POLICY, fleet-wide:** when GitHub Actions can't run a required check (billing/credit exhausted, outage, or no workflow run appears for the pushed SHA within ~2 min), run `./AI/scripts/local-ci.sh` — it discovers the required checks from branch protection, runs their equivalents locally in Docker, and posts `success` commit statuses only for checks that actually pass (use `--trust-build` only when you've manually verified the build). Always run the real gates (tsc/tests/build in Docker) first — local-ci posts statuses, it does not replace verification. Announce the fallback every time you take it. Restore normal Actions CI once billing/credit is fixed. 4. Verify Vercel preview deployment succeeded. 5. Ask user to test the preview URL. **5b. PR guard (§17.1 — MANDATORY):** run `./AI/scripts/pr_guard.sh` (or `./scripts/pr_guard.sh` if standalone). If it REFUSES (exit 2), the diff vs `origin/main` is docs/AI/hook/config-only — do NOT open a PR; leave the commits batched on `test` for the next code PR to carry (override only for a genuine standalone infra fix: `PR_GUARD_FORCE=1`). 6. On user confirm AND guard pass, create PR `test` → `main` with summary. 7. Run AI code review on the PR. 8. When all checks pass, merge PR. **If a required check is app-pinned and Actions is billing-blocked so the PR stays BLOCKED even after local-ci posts a green status: complete the merge with `gh pr merge --merge --admin`** (fleet-wide policy, user-authorized 2026-06-12 — this now applies to production app repos too, not only the master/infra repo). **Guardrails (non-negotiable):** (a) run the REAL gates locally first — tsc + tests + build in Docker must actually pass; (b) never post/merge over a check that didn't genuinely pass — `--trust-build` only when you've verified the build; (c) bypass ONLY for the billing/outage condition, never over a genuinely failing check (broken test, tsc error → fix it, don't admin-merge); (d) announce the bypass every time; (e) `--admin` only succeeds where branch protection permits it (`enforce_admins: false`) — if GitHub rejects it, report and wait; (f) restore normal Actions CI once billing is fixed. 9. Confirm production deployment complete. 10. **Post-merge review check:** `gh api repos/{owner}/{repo}/pulls/{pr}/reviews` + `/comments` to pull automated reviewer comments (Copilot, CodeQL). If findings: fix valid issues in follow-up PR, note invalid. Report what was found/actioned. 11. Update `AI/state/STATE.md` + `AI/state/AI_AGENT_HANDOFF.md` + `AI/logs/claude_log.md`. **Do NOT run update_all — this is a project, not the master repo.** 12. **Sync test with main (MANDATORY):** `git fetch origin && git merge origin/main --no-edit` — keeps test aligned with main, wrap-up banner reflects truth. |
| `wrap up` / `wrap up -u` (urgent) | **Session close with traffic-light dashboard.** **0. `schedule plan` FIRST (MANDATORY — the first thing `wrap up` does; skip ONLY when invoked as `wrap up -u`):** run the `schedule plan` protocol (see `AI/documentation/KEYWORDS_REFERENCE.md` → Scheduling) to refresh this repo's mythos improvement plan + 10-day schedule (`plan_set` → dashboard `/plan`) and top up the task queue. Refresh the existing plan — don't duplicate tasks. **`wrap up -u` (urgent) skips `schedule plan` (step 0) and any propagation; everything else still runs.** 1. Run session-close (summarize, update STATE.md, log, **write the handoff as a trimmed DELTA — not a full rewrite**). **BRAIN-PRIMARY (TOKEN-OPT 3):** the brain atom (step 1e) is the PRIMARY continuity record — the full session narrative lives THERE and every next session boots it via `brain_delta`. So session-close no longer re-emits the whole markdown: it writes ONLY the handoff **header** (`Brain: <sha>` + `Last machine:` + timestamp), the **`ACTION for next agent`** block, and the **top-3** most-recent session summary lines. `rotate_state.sh` (step 1b) bounds the file afterward by archiving whatever the delta didn't keep. The handoff file stays the offline / any-device continuity **fallback** for when the gateway/brain is unreachable — it is no longer the primary record, so keep the write thin. 1b. **Rotate state (run if `AI/scripts/rotate_state.sh` exists):** `./AI/scripts/rotate_state.sh`. Pushes any 4th-oldest session block from STATE.md into `AI/state/archive/YYYY-MM.md`. Idempotent — no-op if within thresholds. Skip silently if script missing. 1c. **RAG reindex (Phase B7 — non-fatal):** Call the master gateway's `memory_reindex` MCP tool to embed this repo's state/handoff/archive into the central vector store. Repo name = current folder name. This keeps the RAG corpus current for `recall_session` lookups. If the gateway is unreachable (`localhost:3100` not responding), skip silently — file rotation (step 1b) is the authoritative backup. The managed repo does NOT run its own vector store; all embeddings go through the master gateway. 1d. **App Directory card (run if `AI/scripts/repo_card.sh` exists — non-fatal):** `./AI/scripts/repo_card.sh`. Upserts this repo's one-point-pointer card (description + localhost/app/api/vercel/dns URLs + mongo label + rolling git status) into the master gateway → dashboard `/directory`. Auto-derives status from git and merges static metadata from `AI/state/app-card.json` if present (create that file once with your app's URLs + description so the card stays rich). Skips silently if the gateway (`localhost:3100`) is unreachable — never fails the wrap-up. 1e. **Brain merge — THE PRIMARY CONTINUITY RECORD (when a brain store exists — non-fatal otherwise):** append ONE session atom via `brain_commit` (kind=session, repo=this repo, an explicit `topic` — the session's dominant theme from the controlled BRAIN_TOPICS set (`runner-ops`, `cost-policy`, `gateway-infra`, `go-live`, `continuity`, `distribution`, `billing`, `brain`, `security`, `docs`) — never omit it and fall to the warned `general` default (ADR-020), ~300-token summary: what shipped / decisions / what's next / blockers — the only interactive-token brain cost, and the ONE full narrative write of the close: the trimmed handoff delta in step 1 is a fallback pointer, this atom is the source of truth every next session boots via `brain_delta`), then call `brain_merge` — merges the session branch into brain main and auto-runs the distiller (recompiles `brief.md`/`working.md`/`rollup.md`, zero interactive tokens). Record the returned brain main SHA as a `Brain: <sha>` line in the handoff header — the next session's `brain_delta` anchor. Gateway unreachable / no brain → skip silently. The WRAPPED UP banner stays exactly as before — brain steps never alter the banner or the close-out flow. 2a. **Mobile/cloud session:** If hostname = `vm` (or `CODECLOT_OVERRIDE=1`), commit ALL changes (code + state + handoff + logs) to `codeclot` branch (use `codeclot/<YYYYMMDD-HHMM>` if codeclot exists on remote with unmerged changes). Push. Note branch name in handoff. 2b. **CLI session:** Commit state + handoff + logs. Push to current branch. Ensure state files reach `main` (via ship it or direct push) so next mobile session gets full context. 3. Show dashboard: `[OK]` green, `[!!]` yellow, `[XX]` red for: commit, push, STATE.md, handoff, branch, Docker, CI. 4. All green → "Safe to close". Red → list what needs fixing. 5. **WRAPPED UP banner (MANDATORY) — final output:** Display ASCII art WRAPPED UP banner (full template in `AI/documentation/WRAP_UP_BANNER.md` — Read that file). Fill dynamically: REPO, BRANCH, REMOTE, SESSION (CLI/Mobile + hostname), WRAPPED (UTC timestamp), PRs, STATUS. Banner MUST be final visible output. |
| `merge it` | Merge `test` → `main` via PR. Create PR if not exists, verify CI passes, merge, update any bug/feature DB status from "solved" to "deployed" with `deployedAt` timestamp. Confirm production deployment complete. |
| `yolo god` | **Full autonomous mode until completion.** No questions asked until current plan is finished OR next `git commit` is created — whichever comes first. Run `./AI/scripts/yolo.sh start god`. Pick best approach, execute, move on. On failure: diagnose and fix without asking. On commit or plan completion, auto-deactivate via `./AI/scripts/yolo.sh stop`. |
| `yolo [minutes]` | **Timed autonomous mode.** `yolo 10` = next 10 minutes no permission/clarifying questions. Run `./AI/scripts/yolo.sh start <minutes>`. Check `AI/state/.yolo` before each action — if expired, revert to normal mode. Show countdown every 3rd action. |
| `yolo off` | **Deactivate YOLO immediately.** Run `./AI/scripts/yolo.sh stop`. Resume normal permission behavior. |

### Extended keywords (load on demand)

When the user types any of these, Read `AI/documentation/KEYWORDS_REFERENCE.md` for the full action:

**Brain (git-versioned agent memory):** `brain status`, `brain commit [note]`, `brain stash` / `brain pop`, `brain branch <idea>` / `brain checkout <ref>`, `brain merge` (what `wrap up` calls), `brain log`, `brain diff`, `brain delta` (what `agent mode -min` boots with), `brain blame <code-sha|brain-ref>` (code↔memory provenance, both directions), `brain revert <sha>` — git muscle memory over the master gateway's `brain_*` MCP tools; sessions = commits, wrap up = merge, brain `main` = the truth every agent boots from.

**Status & review:** `status`, `review`, `plan [feature]`, `scaffold [thing]`, `audit`, `handoff`, `list`, `show urls`

**Scheduling (autonomous work queue — STANDARD):** `schedule <description>` / `schedule task`, `schedule list` / `what's scheduled`, `schedule plan` — queue/inspect tasks in the myAI gateway that the launchd CLI runner works autonomously on the free Fable window (`./AI/scripts/schedule_task.sh`). This is the ONE correct way to schedule work in this repo; never create gateway cron schedules for it. **Consent list:** if THIS repo's name is in `AI/config/schedule_ignore.txt` (the fleet-wide no-autonomous-schedule list), it gets **NO** scheduled work without the user's explicit consent — `schedule_task.sh`/`push_schedule.sh` refuse to queue it and `wrap up`/`schedule plan` must NOT auto-submit a plan for it (if one is submitted, ask the user first). Consented override: `SCHEDULE_CONSENT=1`.

**Connect Hub:** `check bugs`, `fix bug [id]`, `check features`, `build feature [id]`, `triage`, `connect setup`

**Productionisation:** `make preview`, `make prod`

**Remote control & Telegram:** `remote`, `remote status` / `remote start [repo…]` / `remote stop [repo…]` (fleet remote sessions — run `./AI/scripts/remote_fleet.sh <action>`; status shows which repos have live claude sessions + profile, start opens phone-drivable claude-museum sessions duplicate-guarded, stop kills museum sessions only), `telegram setup`, `telegram start`

**Fleet inventory:** `ai tools`, `more agents`, `more skills`, `more mcp` / `more mcp tools`, `more routes`, `ai tools help` / `help ai tools`

---

## Wrap Up Banner (MANDATORY on every session close)

The `wrap up` keyword MUST end with the ASCII WRAPPED UP banner as **final output**. Read `AI/documentation/WRAP_UP_BANNER.md` for the exact ASCII template + field placeholders (REPO, BRANCH, REMOTE, SESSION, WRAPPED, PRs, STATUS). Fill dynamically from git + session context. Banner makes session-end instantly visible when scrolling back.

---

## YOLO Mode — Autonomous Execution Protocol

When YOLO mode is active (`AI/state/.yolo` exists and not expired):

1. **No clarifying questions.** Pick the best approach and execute. Don't ask "should I X or Y?" — decide and do it.
2. **No confirmation prompts.** Proceed with file writes, bash commands, git operations, Docker rebuilds without pausing.
3. **No summarizing before acting.** Skip "I'm going to do X, Y, Z" preamble — just do it and report results.
4. **Error recovery is autonomous.** If something fails, diagnose and fix. Only stop if 3 consecutive attempts at the same fix fail. **3-strikes postmortem (MANDATORY when this fires):** don't just halt — before your final RESULT/summary line, write a postmortem block starting with the words `3-strikes stop` on its own line, then one `Attempt N: <what you tried> -> <the last error>` line per attempt, in order, so the next session or the operator sees the diagnosis immediately instead of re-deriving it from scratch. When run by the fleet's headless runner, this marker is what lets the full breakdown land on the task instead of just a truncated one-line summary.
5. **Still respect safety rails:** Never push to `main`, never commit secrets, never delete branches without recovery path. YOLO skips permission prompts, not safety rules.

### Timed Mode (`yolo N`)
- Active for N minutes from activation
- Check `AI/state/.yolo` expiry before each action — if expired, delete file and announce "YOLO expired — back to normal mode"
- Show remaining time every 3rd action: `[YOLO: 7m remaining]`

### God Mode (`yolo god`)
- Active until next `git commit` succeeds OR current plan/task list is fully completed
- After successful commit: auto-run `./AI/scripts/yolo.sh stop` and announce "YOLO god mode — deactivated (commit created)"
- After plan completion: auto-run `./AI/scripts/yolo.sh stop` and announce "YOLO god mode — deactivated (plan complete)"

### Checking YOLO State
On session start, `11-yolo-status.sh` hook checks `AI/state/.yolo`: active → display mode + time remaining; expired → delete file, show "YOLO expired"; absent → no output (silent).

---

## Usage Guard Protocol — Session Capacity Management

The Usage Guard tracks session capacity via two metrics: **elapsed time** and **weighted action count** (tool calls as token proxy). The higher percentage is the effective level. Config: `AI/config/session-limits.json`. Metrics: `AI/state/.session-metrics`.

> **These are self-imposed framework guards, NOT Claude/API limits.** They're tunable proxies to prompt clean wrap-ups; raising them grants no extra model capacity (the real ceiling is the context window, which auto-compacts). Current defaults: **480 min / 800 weighted actions**, **warn-only** (`block_at_percent: null`, `block_tools: []`) — nags at 80/90/95% but never freezes tools. To re-enable the hard block, set `block_at_percent` + `block_tools` in `AI/config/session-limits.json`.

Hooks automatically emit warnings. **These are mandatory directives, not suggestions.**

### At 80% — YELLOW WARNING

You will see: `USAGE GUARD: YELLOW WARNING — 80% CAPACITY`

1. **Announce** to user: "Session at 80% — ~Xm and ~Y actions remaining."
2. **Finish** current task — do NOT start new work.
3. **Prioritize** remaining budget: commit > push > state update > handoff.
4. **Skip** non-essential ops: no refactors, no exploratory reads, no test runs unless critical.

### At 90% — RED WARNING

You will see: `USAGE GUARD: RED WARNING — 90% CAPACITY`

1. **Stop** all work immediately.
2. **Run `wrap up`** — full session close.
3. If `wrap up` would exceed budget, skip to 95% emergency protocol.
4. **Tell user**: "Session at 90% — wrapping up now. Continue with Gemini/Copilot using AI_AGENT_HANDOFF.md."

### At 95% — EMERGENCY

You will see: `USAGE GUARD: EMERGENCY — 95% CAPACITY`. With the **default warn-only config**, tools are **NOT** blocked — this is a strong nudge, not a freeze. (If `block_at_percent`/`block_tools` are set in config, Bash/Edit/Write/Agent are blocked except writes to AI_AGENT_HANDOFF.md.)

1. **Write `AI/state/AI_AGENT_HANDOFF.md` immediately** with minimal content: what was done (bullets), what's in progress (branch, uncommitted files), what should be done next (prioritized), current blockers, last machine hostname.
2. **Prioritize** the rest of the budget: handoff > commit > push > STATE.md > logs.
3. If the hard block IS enabled, only handoff writes pass — tell the user to commit/push manually.
4. Tell user: "At 95% — handoff saved. Wrapping up / continue with another agent if needed."

---

## Deployment Workflow (Branching Strategy)

**NEVER push directly to `main`. All code goes through `test` branch first.**

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

**Branch protection rules:**
- `main`: PR required, CI must pass (Lint, Type-check, Test)
- `test`: CI must pass, direct push allowed

**Docker-only development:** NEVER run `npm install`, `npm ci`, `npx`, or `node` directly on the host machine. Always use `docker compose exec app <command>`. The only exception is CI runners (GitHub Actions).

---

## Quality Gates (tech-lead enforces)

Before any feature is marked complete:
- [ ] API contracts match frontend implementation
- [ ] Database schema matches service queries
- [ ] Auth middleware matches security-specialist spec
- [ ] Tests exist (qa-specialist sign-off)
- [ ] Documentation updated
- [ ] CI/CD pipeline passes

---

## State Management Protocol

```
Session start:  ./AI/scripts/rotate_state.sh --check  →  Read AI/state/STATE.md + AI/state/AI_AGENT_HANDOFF.md
After each task: Update AI/state/STATE.md autonomously — do not wait for user prompt
Session end:    Update AI/state/STATE.md + AI/state/AI_AGENT_HANDOFF.md  →  ./AI/scripts/rotate_state.sh
Agent log:      Write to AI/logs/claude_log.md with timestamp
```

**CHECKPOINT-AS-YOU-GO (AI_RULES §15, MANDATORY): after every merged PR / completed batch / operator decision, immediately update the handoff delta, append a brain atom, and push `chore: update state` (build-free). A session killed at any moment must cost ≤ ~15 min of context. NEVER wait for the user to ask you to save state.** Update state/STATE.md after every significant action.

**Mechanical enforcement (auto — you will see these):** three hooks back §15 so it never depends on memory. `hooks/post-tool/06-handoff-staleness.sh` emits a **`CHECKPOINT OVERDUE`** box when `AI/state/AI_AGENT_HANDOFF.md` is >~30 min stale AND ≥40 weighted tool calls have accrued since the last write — treat it as a MANDATORY interrupt: write + **push** the handoff before the next unit of work. `hooks/pre-tool/15-token-budget-guard.sh` fires a `TOKEN GUARD: CHECKPOINT` box at 70% session-token burn (same mandate). `hooks/stop/04-handoff-staleness.sh` shouts a LOUD red at session close if the handoff is stale with unsaved work. All three are warn-only (never block) and tunable via `AI/config/session-limits.json` → `autosave`.

### Two-tier state architecture (propagated from master 2026-05-19)

State files have a **hot tier** (always-loaded) and a **cold tier** (load-on-demand):

```
AI/state/
├── STATE.md                 ← hot: header + top 3 sessions + state sections (~4k tokens)
├── AI_AGENT_HANDOFF.md      ← hot: current handoff + ≤3 prior-last-work lines (~1.5k tokens)
└── archive/
    ├── 2026-05.md           ← cold: month-bucketed older sessions
    ├── 2026-04.md
    └── handoff-pre-YYYY-MM-DD.md
```

`AI/scripts/rotate_state.sh` keeps the hot tier bounded automatically. When the user references an older session, look it up in the archive instead of re-reading STATE.md from scratch:

```bash
grep -rn "PR #99" AI/state/archive/                  # find PR mentions
grep -A 5 "Session: 2026-04-30" AI/state/archive/    # show specific session
```

**RAG path (`RAG_RECALL=1`):** when the flag is set and the session-start hook reports `RAG RECALL: ON`, prefer the master gateway's `recall_session` MCP tool (semantic recall over the embedded corpus) for the lookup — managed repos use the master gateway over the network, they don't run their own vector store. Grep stays the fallback when the gateway is unreachable or the query is a literal token (PR number, SHA).

---

## File Domain Ownership (No Parallel Writes to Same Files)

| Domain | Owned By | Files |
|--------|---------|-------|
| Frontend | frontend-specialist | `src/app/`, `src/components/`, `styles/` |
| API | api-specialist | `src/routes/`, `src/controllers/`, `src/services/` |
| Database | database-specialist | `src/models/`, `src/db/` |
| Infra | devops-specialist | `docker-compose.yml`, `.github/`, `Dockerfile` |
| Auth/Security | security-specialist | `src/middleware/auth.js`, `src/middleware/security.js` |
| AI/Docs | Lane D agents | `AI/`, `README.md`, `docs/` |
