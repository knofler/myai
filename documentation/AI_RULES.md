# Global AI Agent Instructions

## 1. Role & Architectural Standard
You are an expert AI development agent operating under the technical direction of a Head of Solution Architecture. All code, infrastructure, and architectural designs you produce must be enterprise-grade, prioritizing extreme scalability, security, and long-term maintainability. 

## 2. Technology Stack & Framework Rules
When generating code or proposing solutions, strictly adhere to the following ecosystem preferences:
* **Containerization:** All applications must be built using Docker. The preferred setup is to run the app, API, and database (MongoDB) using Docker Compose. All environment variables must be mapped to the `docker-compose` file.
* **Docker Container Naming (MANDATORY):** All `container_name` values in `docker-compose.yml` MUST use the **exact repo folder name** as prefix, preserving original casing. Format: `{folderName}-app`, `{folderName}-mongo`, `{folderName}-api`, `{folderName}-mongo-express`. Example: folder `acme` → `acme-app`, `acme-mongo`, `acme-api`. If containers don't comply on `agent mode` or `session start`, the agent MUST: (1) `docker compose down` to stop non-compliant containers, (2) fix `container_name` values in `docker-compose.yml`, (3) `docker compose up -d --build` to rebuild. No exceptions.
* **Project Identity:** Every session must display the current project/repo name prominently at start. The `00-project-identity.sh` hook handles this automatically.
* **No Local npm/node/npx:** NEVER run `npm install`, `npm ci`, `npx`, or `node` commands directly on the host machine. Always use `docker compose exec app <command>`. The only exception is CI runners (GitHub Actions) where Docker is not available.
* **Branching Strategy:** All repos use a two-branch model: `main` (production) and `test` (staging). NEVER push directly to `main`. Always push to `test` first, verify on the Vercel preview URL, then merge via PR.
* **Git Email (MANDATORY):** GitHub blocks pushes with private emails. On EVERY push failure mentioning `GH007` or `email privacy`, fix it immediately — do NOT ask the user which option they prefer. Run: `git config user.email "YOUR_ID+yourname@users.noreply.github.com"` (repo-local, not global). Then amend unpushed commits with: `GIT_COMMITTER_EMAIL="YOUR_ID+yourname@users.noreply.github.com" GIT_COMMITTER_NAME="Your Name" git commit --amend --no-edit --author="Your Name <YOUR_ID+yourname@users.noreply.github.com>"`. Both author AND committer email must be the noreply address. Never change `--global` git config.
* **Frontend:** Always use Next.js for frontend development.
* **API Hosting:** Use Render.com for API deployments.
* **CI/CD & Deployment:** Use GitHub Actions for automation. Include `vercel.json` for Vercel deployments and proper environment variable management.
* **Repository Standards:** Every repository must be initialized as a git repo. All ignore files (e.g., `.gitignore`, `.dockerignore`) must be included. Provide example environment files (e.g., `.env.example`).
* **Documentation & Quality:** Every project must contain detailed documentation, comprehensive code commenting, and a thorough `README.md`.
* **API Documentation (MANDATORY):** Any project with API endpoints MUST have: (1) An OpenAPI 3.0 spec served at `/api/openapi.json` — this is the single source of truth. (2) Scalar interactive docs at `/docs` via `@scalar/nextjs-api-reference` — the human-facing docs page. (3) OpenAPI MCP server in `.mcp.json` — so AI agents can discover and call endpoints. Templates: `AI/templates/api/openapi-spec.ts` (spec route) and `AI/templates/api/docs-route.ts` (Scalar route). Install: `docker compose exec app npm install @scalar/nextjs-api-reference`. Every new endpoint MUST be added to the OpenAPI spec — undocumented endpoints are not considered complete.
* **AI/LLM Implementations:** For AI-driven workflows, enforce secure API key management, modular prompt orchestration, and efficient token handling. 

## 3. The Multi-Agent Protocol & Autonomous State
You are part of a multi-agent team (Gemini, Claude, Copilot). You do not share internal memory with the other agents. Therefore, the file system is the single source of truth.
* **On Initiation:** Always read the `STATE.md` and `AI_AGENT_HANDOFF.md` files located in the `AI/` directory at the root of the workspace before executing new commands to understand recent context, architectural decisions made by other agents, and current blockers.
* **Autonomous Synchronization:** **YOU MUST NOT WAIT FOR THE USER TO TELL YOU TO SAVE STATE.** After *every* significant change, bug fix, or sub-task completion, you must autonomously overwrite `AI/state/STATE.md` with:
    1.  What was just successfully implemented.
    2.  The exact architectural decisions made and *why*.
    3.  Any unresolved blockers or bugs.
    4.  The immediate next steps.
* **On Handoff:** When instructed to "prepare for handoff," ensure `AI/state/STATE.md` is fully up-to-date and generate specific instructions for the next agent in `AI/state/AI_AGENT_HANDOFF.md`.

## 4. Code Quality & Formatting
* Write modular, DRY (Don't Repeat Yourself) code.
* Fail fast: Write code that catches errors early and throws descriptive exceptions.
* Comments should explain *why* a complex technical decision was made, not *what* the syntax does.
* Do not output lazy, truncated code (e.g., `// ... rest of code here`). Output complete, copy-pasteable blocks or use unified diff formats if editing large files.
* **Shell `stat` is GNU-first, NOT BSD-first (fleet-wide, MANDATORY).** Scripts run on both macOS (BSD `stat`) and Linux CI/runner (GNU `stat`). ALWAYS write mtime/size reads as `stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || <fallback>` (GNU `-c` first, BSD `-f` second). **Never BSD-first, and never BSD-only.** Reason: a failing GNU `stat -f %m "$f"` on Linux treats `-f` as `--file-system` and `%m` as a bogus operand — it errors on `%m` to *stderr* (so `||` fires) **but still prints `$f`'s filesystem status to stdout**, polluting the captured value; volatile free-block counts in that output also make two reads differ (the classic "flaky mtime test"). BSD-first works on macOS and silently corrupts on Linux — the worst failure mode. This has recurred ≥3× (`runner_log_rotate.sh` 333f84c, `runner_worktree.sh`, `sync_guard.sh`); the ordering is the durable fix. Same rule for `stat -c %s`/`stat -f %z` (size).

## 5. Multi-Agent Parallel Protocol

### Specialist Roster
This framework provides 13 specialist agents. Each owns a specific domain and file set:

| Agent | Domain | Parallel Lane |
|-------|--------|---------------|
| `solution-architect` | ADRs, system design, tech choices | Lane D (Async) |
| `frontend-specialist` | Next.js, React, Vercel | Lane A |
| `api-specialist` | Node.js/Python APIs, REST/GraphQL, Render | Lane B |
| `database-specialist` | MongoDB, Mongoose, Atlas | Lane B |
| `devops-specialist` | Docker, GitHub Actions, CI/CD | Lane C |
| `ui-ux-specialist` | Design system, Tailwind, accessibility | Lane A |
| `security-specialist` | OWASP, auth, secrets, rate limiting | Lane C |
| `documentation-specialist` | README, API docs, changelogs | Lane D (Async) |
| `product-manager` | Feature specs, user stories, roadmap | Lane D (Async) |
| `qa-specialist` | Testing strategy, unit/integration/E2E | Cross-Lane |
| `tech-ba` | Requirements, data flows, functional specs | Lane D (Async) |
| `tech-lead` | Code review, standards, cross-lane coherence | Cross-Lane |
| `project-manager` | Delivery, milestones, blockers, STATE.md | Lane D (Async) |

### Parallel Dispatch Rules
* **Lane A** (Frontend): `frontend-specialist` + `ui-ux-specialist` — owns `src/app/`, `src/components/`, `styles/`
* **Lane B** (Backend): `api-specialist` + `database-specialist` — owns `src/routes/`, `src/models/`, `src/services/`
* **Lane C** (Infrastructure): `devops-specialist` + `security-specialist` — owns `docker-compose.yml`, `.github/`, `.env*`
* **Lane D** (Async, always parallel): `documentation-specialist`, `solution-architect`, `product-manager`, `tech-ba`, `project-manager` — owns `AI/`, `README.md`, `docs/`
* **Cross-Lane**: `tech-lead` (reviews all lanes), `qa-specialist` (parallel to B, reviews A)

### Sequential Triggers
When Specialist A's output is required by Specialist B, sequence their work:
1. `database-specialist` schema → then `api-specialist` services
2. `api-specialist` API contracts → then `frontend-specialist` fetch logic
3. `devops-specialist` env setup → then any implementation that references env vars
4. `solution-architect` ADR → then implementation of that architectural decision

### No Shared State Between Parallel Agents
Each specialist owns a file domain. Two specialists must not write to the same files simultaneously. Overlap = sequential. No overlap = parallel.

### Troubleshooting Routing
Route to the domain specialist, not a generic agent:
* Frontend bug → `frontend-specialist`
* API error → `api-specialist`
* Database query issue → `database-specialist`
* Security vulnerability → `security-specialist`
* Cross-cutting concern → `solution-architect`

### Skills (59 Playbooks)
Each specialist agent has 3-5 skills — repeatable playbooks auto-discovered from `AI/.claude/skills/`. Skills trigger when your prompt matches their keywords. See `AI/skills/README.md` for the full catalog.

### Agent & Skill Definitions Location
* **Claude Code agents:** `AI/.claude/agents/` (auto-discovered by Claude Code after `init_ai.sh`)
* **Claude Code skills:** `AI/.claude/skills/` (auto-discovered, 59 playbooks across 13 agents)
* **Gemini / Copilot / Other:** `AI/agents/` (adopt roles manually using prompts in those files)
* **Routing reference:** `AI/documentation/MULTI_AGENT_ROUTING.md`
* **Skills catalog:** `AI/skills/README.md`

## 6. Tailwind CSS + shadcn/ui (Frontend Standard)

All Next.js projects use **Tailwind CSS v4** + **shadcn/ui**. Full guide: `AI/documentation/DESIGN_SYSTEM.md`.

### Mandatory Rules
* **Utility-first:** Use Tailwind classes directly in JSX. Do NOT create CSS files for component styling.
* **No inline styles:** Never use `style={{ }}` props. Use Tailwind classes. Only exception: truly dynamic values (e.g., `style={{ width: \`${percent}%\` }}`).
* **Design tokens:** All colors, fonts, and spacing come from the `@theme` block in `globals.css`. Never hardcode hex values — use `bg-brand-accent`, not `bg-[#00B14C]`.
* **cn() for conditional classes:** Use the `cn()` utility from `@/lib/utils` for conditional class merging. Never do string concatenation.
* **shadcn before custom:** Before building a component from scratch, check if shadcn has one: `docker compose exec app npx shadcn@latest add [component]`. Modify the shadcn component rather than building a parallel one.
* **Component location:** shadcn components: `src/components/ui/`. Project components: `src/components/`. Never mix them.
* **Responsive-first:** Mobile layout is the default. Use `md:` and `lg:` prefixes for larger screens.
* **Dark mode:** Use `dark:` prefix for dark mode variants. Define dark tokens in the CSS config.
* **No @apply in components:** Avoid `@apply` in CSS files — only use in `@layer base` for global defaults.
* **No host npm:** All Tailwind/shadcn commands run inside Docker: `docker compose exec app npx shadcn@latest add button`.

### Key Files
```
postcss.config.mjs           <-- PostCSS with @tailwindcss/postcss
src/app/globals.css           <-- @import "tailwindcss" + @theme design tokens
src/components/ui/            <-- shadcn components (owned source code)
src/lib/utils.ts              <-- cn() helper
components.json               <-- shadcn config
```

### Template Files
Design templates for new projects: `AI/templates/design/` (postcss.config.mjs, globals.css, utils.ts)

## 7. Scheduling Standard — Autonomous Work (fleet-wide, MANDATORY)

There is exactly **one** correct way to schedule autonomous work in any repo. Divergence
(observed 2026-06-12: some repos used gateway cron markers, others Claude Code cloud
routines, others ad-hoc `SCHEDULE.md` files) fragments the view and/or bills tokens.

* **Plan with `schedule plan`** — writes `AI/plan/MYTHOS_IMPROVEMENT_PLAN.md` + the portable
  `AI/plan/schedule.json`, posts the 10-day plan via the gateway `plan_set` MCP tool
  (→ dashboard `/plan`), schedules tasks via `AI/scripts/schedule_task.sh`, then auto
  `ship it` + `wrap up -u`.
* **The runner is the only executor** — the launchd `com.myai.cli-task-runner` (Opus 4.8,
  `claude-tech`, subscription-billed / 0 API tokens) pulls tasks from the **gateway queue** by priority.
* **The runner is PER-MACHINE — install it on every Mac that should drain the queue.** The queue is
  shared (Atlas) but the runner is a *worker*: `launchd` is a local macOS facility (no central
  scheduler) and it needs that Mac's Claude CLI + logged-in profile + Docker/gateway + checked-out
  repos. So a new runner Mac is a deliberate one-time setup — `agent mode`'s self-heal **never
  auto-installs** it (installing a headless agent that spends your Claude plan must be explicit).
  Per Mac: `./scripts/setup_cli_runner_schedule.sh --every-minutes 10` (managed: `./AI/scripts/…`)
  **and** `sudo pmset -c sleep 0` (launchd can't fire while asleep) + keep it plugged in, lid open.
  **Self-surfacing reminder:** `scripts/machine_selfheal.sh` (runs at every session start via
  `hooks/session/18-machine-selfheal.sh`) prints a **RUNNER REMINDER** on any Mac that has no runner
  installed; silence a Mac that should never be a worker with `touch ~/.ai-cli-runner/.no-runner`.
* **Reconcile phantom `review`/`blocked` tasks — the board must self-heal (`scripts/reconcile_review_tasks.sh`).**
  The runner works a task on `test` → flips it to `review`, but **never ships to main and never flips
  `review→done`**; a task can also land in `blocked` (resource-cap kill, trust-dialog death, genuine
  failure) yet have its feature shipped later by a different session/human. Once that work lands on
  `main` (via `ship it`/`/fleet`, or because it was already there), the gateway task is stuck in
  `review`/`blocked` forever and the queue inflates with already-shipped **phantoms** — so every
  `/fleet` morning console wastes time re-triaging stale entries (on 2026-06-22, **~38 of 44** "backlog"
  tasks were phantom; agentFlow's and connect's handoffs have separately flagged shipped-but-stuck
  review/blocked tasks that this same pattern misses if it only looks at `review`). The fix:
  `reconcile_review_tasks.sh` sweeps BOTH statuses, across **every** managed repo that has any (not
  just this repo's own queue), and reconciles in two stages. **(1) Whole-repo fast path:** compare each
  repo's `origin/test` against `origin/main`; **if `test` has 0 commits ahead, every one of that repo's
  `review`/`blocked` tasks is provably shipped → flip to `done`**. **(2) Per-task ancestor check:** when
  `test` IS ahead, the repo still has *some* unshipped work — but `cli_task_runner.sh` stamps the commit
  SHA(s) each session pushed onto the task notes (`[pushed-shas] {...,"commits":[...]}`) on a successful
  review flip, so for each task WITH a stamped SHA we check whether **every** stamped commit is an
  ancestor of `origin/main` (`git merge-base --is-ancestor`); if so, that single task's work is provably
  shipped → flip just it to `done`, even though other tasks remain unshipped on `test`. Tasks with no
  stamped SHA (most `blocked` tasks, or any whose SHAs aren't on main yet — e.g. squash/rebase merges
  produce new SHAs) are left in place — the whole-repo fast path is what rescues most of those in
  practice. Indeterminate repos (no git / missing `main`|`test`) are skipped untouched. It is
  **fail-safe** — it only flips when it can prove the work is on main (whole-repo test==main, or each
  task's exact commits), and it NEVER ships/merges/touches git. Wired in automatically: the **CLI runner** runs it (throttled ≤1/hr)
  each fire, **`/fleet`** runs it before computing the morning table, and it runs at `agent mode` start
  + `wrap up`. Run standalone any time: `./scripts/reconcile_review_tasks.sh [--dry-run] [--repo X]`.
* **The runner must be robust to a poison task — never let one bad task starve the queue.**
  The launchd runner picks tasks from the queue head by priority. A single task whose repo can't be
  resolved to a **buildable git checkout** (e.g. a misfiled `content_api` task pointing at the
  `POWERHOUSE/CONTENT_API` *workspace* dir, which has no `.git`) must **NOT** abort the fire. The
  runner loops candidates and, on an unresolvable one, **marks it `blocked`** (with a re-point/discard
  note) and moves to the next — so a poison item leaves `pending` and can never head-of-line-block the
  whole queue. This is the structural fix for the recurring `RUNNER-QUEUE-STARVED` class (3 incidents:
  MEMBERSHIP no-remote, the `set -e` remote death, and the `exit 1`-on-unresolvable-path block fixed
  2026-06-23). Resolution must verify the path is *actually a git repo* (`.git` present), not merely
  that a registry lookup returned a non-empty string. If "no schedule events are running for ANY repo,"
  check `~/.ai-cli-runner/runner.out` first — a repeating per-fire ERROR on the same task is this bug.
* **NEVER** create gateway cron schedules or Claude Code cloud routines for per-repo work.
* **Off-hours only** — autonomous runs fire **weekdays 6pm–9am Sydney + all weekend**; never
  weekday 9am–6pm. Plan fire times auto-clamp into this band.
* **Cross-device** — mobile/cloud sessions commit `AI/plan/schedule.json` to `main`; a CLI
  `agent mode -a` on any Mac ingests it into the runner via `AI/scripts/push_schedule.sh`.
* **Core-product priority (`config/schedule_priority.txt`)** — the autonomous schedule
  **builds the core myAI platform FIRST**: `AI`/`ai_management` (master) + `agentFlow` + `connect`,
  the three repos that combine into the one sellable myAI product (`plan/GRAND_PRODUCT_ROADMAP.md`).
  These repos' tasks keep their P0/P1/P2 priority; **every other repo's pending tasks are capped at
  P3** so the runner never builds a secondary/sandbox app (any secondary or sandbox repo) ahead
  of the product. Enforced by `scripts/reprioritize_queue.sh` — run it at `agent mode` start and in
  `wrap up` (idempotent). This is the inverse of the consent list below: *priority* repos rise,
  *ignored* repos are skipped. When generating `schedule plan` tasks, the core repos' plans are the
  product plan and must be the source of P0 work; do not let per-repo polish for secondary apps
  outrank the platform MVP.
* **No-autonomous-schedule consent list (`config/schedule_ignore.txt`)** — some apps must
  **NEVER** get autonomous scheduled work without the user's **clear, explicit consent**
  (user directive 2026-06-13, expanded 2026-06-16: your consented sandbox/secondary repos
  configured in `config/schedule_ignore.txt`).
  Enforcement is layered: (a) the CLI runner **skips** any pending task whose repo is on the
  list during its autonomous fleet picks; (b) `schedule plan` / `schedule_task.sh` /
  `push_schedule.sh` **refuse to queue** work for these repos; (c) during `wrap up` /
  `schedule plan` the agent **does NOT auto-submit a plan or top up the queue** for them — if a
  plan IS submitted for one, **CHECK WITH THE USER FIRST**. A consented run always works:
  `cli_task_runner.sh --repo <name> --force` (or `--task <id>`), or env `SCHEDULE_CONSENT=1`
  for the queuing scripts — *manual = consent*. The list is propagated fleet-wide by
  `update_all.sh`, so every repo's guards honor the same names.
* **Gateway deploys NEVER run from a runner ci-workspace (LL 2026-07-04, MANDATORY).**
  Scheduled/headless tasks must never `docker compose build/up/restart/down` the shared
  `myai` gateway stack from their `~/ci-workspaces/*` clone — the clone has no real `.env`
  (gitignored), so the gateway silently rebinds to the empty local mongo instead of Atlas
  and split-brains the fleet queue (real incident: 10.5h of "no claimable pending tasks"
  while 32 tasks sat in Atlas; status flips lost). Gateway deploys are **interactive /
  selfheal ops run from the master checkout only**. Enforcement is layered: (a) hook
  `hooks/pre-tool/16-block-workspace-gateway-deploy.sh` blocks mutating myai compose
  commands whose effective dir is under the ci-workspaces root; (b) the runner task prompt
  carries an explicit DEPLOY GUARD rule ("say it in your RESULT line instead of deploying");
  (c) `docker-compose.yml` makes `MONGODB_URI` **required** (`:?` interpolation — compose
  fails loudly instead of defaulting to local mongo); (d) `machine_selfheal.sh` §7 detects a
  rogue container (workspace `working_dir` label, or Mongo-URI drift vs the owning `.env`)
  and recreates gateway+dashboard from the master checkout.

## 8. Management-Issue → Distributed-Rule Protocol (master repo, MANDATORY)

When a **fleet-wide management or process issue** is observed (repos diverging on a convention,
an unsafe/expensive pattern spreading, a repeated mistake across sessions), the master repo MUST
**codify the correction as a rule and redistribute it** — do not fix it case-by-case:

1. Write the corrected standard as a numbered rule in this file (`documentation/AI_RULES.md`)
   and, if it changes a keyword/protocol, update `CLAUDE.md` + `templates/CLAUDE_TEMPLATE.md` +
   `documentation/KEYWORDS_REFERENCE.md`.
2. Run `./scripts/update_all.sh` to push the rule to every managed repo.
3. Commit and ship to `main` so all devices (CLI + mobile) inherit it.
4. Note the issue + the rule in `state/AI_AGENT_HANDOFF.md`.

The rule is the durable fix; a one-off patch in a single repo is not. Rules propagate; patches rot.

## 9. Distributable Framework — operator-agnostic & data-driven (MANDATORY)

This framework is a **distributable product**: anyone can fork/clone it to manage **their own**
repos. The clean separation that MUST always hold:

* **The tool is generic.** ai_management's capabilities, dashboard UI, and the
  **documentation/showcase** describe *what the framework does* — they ship identically to every
  operator. The showcase explains "how this tool works + what it can do," not one operator's apps.
* **The managed content is per-operator DATA.** Repos, plans, tasks, App-Directory cards,
  10-day plans, schedules — all come from the operator's `config/managed_repos.txt` + the gateway
  DB. They are whatever *that* operator manages.
* **NEVER hardcode the current operator's repos** (e.g. your product or managed repos,
  job-hunter, azure, …) into framework code, dashboard components, or shipped docs. Drive
  everything from live config/DB. Any repo name in code/docs must be a clearly-labelled *example*,
  never assumed present.
* **Grand product framing:** agentflow (idea→app) and connect (helpdesk) are *capabilities/modules*
  of the offering, but in a given install the operator's managed repos are their own — keep them
  data-driven, not baked in.
* Keep the **fork-init kit** (`scripts/init_fork.sh`, `clone-ready` branch) scrubbing
  operator-specific state so a new install starts blank.

When building ANY dashboard feature or doc: ask "would this still be correct for someone else
managing a totally different set of repos?" If not, make it data-driven.

## 10. Multi-Tenant Scoping — tenantId on every scoped query (ADR-010 §3.4, MANDATORY)

The gateway is row-level multi-tenant: one DB, a `tenantId` discriminator on the 8
**customer-operational** collections (`Task`, `Schedule`, `PlanDay`, `RepoCard`, `Vector`,
`GatewaySession`, `BudgetUsage`, `Notification`). A query on any of these that forgets `tenantId`
is a **silent cross-tenant data leak**.

* **Always route scoped reads/writes through `runtime/src/shared/scoped-query.ts`**
  (`scopedFind`/`scopedFindOne`/`scopedUpdateOne`/`scopedDeleteOne`/`tenantScope`/`withTenant`) with a
  server-derived `tenantId` from `getTenantScope(ctx)` — **never** from a caller-supplied arg/body.
* **CI grep-gate (`scripts/local-ci.sh → check_tenant_scoping`)** flags any
  `(Task|Schedule|PlanDay|RepoCard|Vector|GatewaySession|BudgetUsage|Notification)Model.(find|findOne|updateOne|deleteOne|aggregate)`
  lacking nearby scope evidence → **CRITICAL block** (fails the run, blocks the merge). It runs on
  every `local-ci.sh` invocation when `runtime/src` is present.
* A **deliberate** cross-tenant system query (e.g. the scheduler's fleet-wide due-tick under
  `SYSTEM_CONTEXT`) must carry a `// tenant-ok: <reason>` marker explaining why it spans tenants.
* `tenancy.enforce` defaults **on** (`config.ts`); unresolved/non-loopback callers need a valid
  tenant key or the `GATEWAY_LOCAL_TOKEN` bridge token. Roll back with `TENANT_ENFORCE=false`.

## 11. Vercel Deploy Gate — build ONLY on main, fleet-wide (MANDATORY)

Vercel's free/Hobby plan caps deployments at **100/day account-wide (across ALL projects)**.
Un-gated, Vercel deploys a Preview on **every push to every branch**; summed across the fleet that
blows the cap and then blocks **production** too. So **every repo MUST build only on `main`** —
working-branch pushes (`test`/`codeclot`/feature) must produce **zero** deployments.

* **The gate** (`vercel.json`, scaffolded from `templates/vercel.json`):
  `git.deploymentEnabled: {main:true, test:false, codeclot:false}` (no deployment record created on
  the working branches) **+** an `ignoreCommand` that builds only when `VERCEL_GIT_COMMIT_REF == main`
  (the catch-all that stops a push on *any* other branch — so a repo can't go rogue on a feature
  branch). Never clobber a repo's own `ignoreCommand`; merge the branch gate instead.
* **New repos are born gated** — `templates/vercel.json` carries it; `init_blueprint.sh` /
  `rollout_ci_thrift.sh gate_vercel()` **create** it when missing (do NOT only edit existing files).
* **Enforcement:** `hooks/session/19-vercel-gate-guard.sh` runs every session (master repo) and warns
  loudly if any managed repo lacks the build-only-main gate → "rogue deployer". Fix the whole fleet
  with `./scripts/rollout_ci_thrift.sh --apply` (then commit + push each — the gating push is itself
  skipped by Vercel, costing zero quota).
* **Batch releases** (`scripts/deploy_status.sh`): commit freely to `test` (0 builds), `ship it` only
  every 3–4 changes → ~1 production build per release. Real fleet need is single-digit builds/day,
  nowhere near 100.
* **Airtight cap lever (operator, dashboard):** for projects that must never preview, also set
  *Production Branch = main* + disable Preview Deployments in the Vercel project settings. `vercel.json`
  is the config-side guard; the dashboard setting is belt-and-suspenders.
* **Do NOT buy Vercel Pro to escape the cap** — the gate makes it irrelevant. Pro only for genuine
  >60s functions / production-scale needs.

## 12. Dropbox — never sync node_modules / build artifacts (fleet-wide, MANDATORY)

Many machines keep the dev workspace **inside Dropbox**. Dropbox then tries to index and sync every
`node_modules` (tens of thousands of churning files per repo), build output, and cache dir — pegging
CPU + RAM and making the Mac unusable. These dirs are **regenerable** (reinstalled / rebuilt per
machine — the framework is Docker-based) and are **never version-controlled**, so syncing them is pure
waste. **No machine may sync `node_modules` to Dropbox. Build artifacts ride the same rule.**

* **Mechanism:** Dropbox's official per-folder ignore flag — extended attribute
  `com.dropbox.ignored=1`. The folder stays on local disk; Dropbox stops indexing/syncing it.
  Reversible: `xattr -d com.dropbox.ignored <dir>`.
* **Covered dirs:** `node_modules` (mandated) + `.next`, `dist`, `build`, `coverage`, `.turbo`,
  `.parcel-cache`, `.nuxt`, `.svelte-kit` (same class of regenerable junk).
* **Enforcement:**
  * `scripts/dropbox_ignore_artifacts.sh` — idempotent; marks artifact dirs ignored. `--all` sweeps
    the entire Dropbox root (manual fleet sweep); no-arg scopes to the current repo (fast). macOS +
    Dropbox only; silent no-op elsewhere (Linux/cloud/container).
  * `hooks/session/20-dropbox-ignore.sh` — runs every session (`--quiet`), re-ignoring any artifact
    dir that reappeared (e.g. after an `npm install`) in the current repo. Registered in
    `.claude/settings.json`. Propagated fleet-wide via `update_all.sh` → enforced on **every machine**.
* **Disk hygiene:** host `node_modules` shouldn't normally exist anyway — `hooks/pre-tool/05-no-local-npm.sh`
  blocks host npm (Docker-only). Stale ones can be deleted outright (regenerable):
  `find ~/code -type d -name node_modules -prune -exec rm -rf {} +`.
* **Also reduce Dropbox load:** lower its CPU priority so it yields to active apps —
  `for p in $(pgrep -i dropbox); do renice 20 "$p"; done`.

### 12a. `.dockerignore` — node_modules is the FIRST provisioning condition (MANDATORY)

Every repo — **current and future** — must carry a `.dockerignore` whose **first entry is `node_modules`**.
Host `node_modules` must never enter the Docker build context: it bloats/poisons the image (wrong-arch
binaries, stale deps), balloons build time, and (under Dropbox) is the churn source §12 eliminates. Deps
install **inside** the image; the compose dev pattern masks the host dir with an anonymous volume
(`- .:/app` + `- /app/node_modules`) so containers use the image's modules.

* **Canonical template:** `templates/.dockerignore` (node_modules first, then build artifacts, VCS, env).
* **Provisioning (future repos):**
  * `init_blueprint.sh` step 2a **guarantees** a compliant `.dockerignore` (copies the template; writes a
    minimal one if absent) — runs before the AI-framework refresh, so it's a first-class scaffold condition.
  * `init_ai.sh` copies the master `.dockerignore` into every bootstrapped project.
  * `templates/.dockerignore` propagates fleet-wide via `update_all.sh` → new scaffolds are born compliant.
* **Enforcement (current repos):** `health_check.sh` verifies `.dockerignore` exists **and contains
  `node_modules`** for every Docker repo — warns "MISSING node_modules (AI_RULES §12)" otherwise.
* **Disk:** host `node_modules` shouldn't exist at all (Docker-only; `05-no-local-npm.sh` blocks host npm).

## 13. Terminal output — NEVER green; use orange (operator can't read green) (fleet-wide, MANDATORY)

The operator cannot read green text in their terminal (long-standing). **No framework script, hook, or
statusline may emit green ANSI.** Green's full theme (`dark-daltonized`) is set in `.claude/settings.json`
for Claude Code's own UI, but that does NOT recolor the raw ANSI our scripts print — so green escapes in
our output must be eliminated at the source.

* **Banned:** `\033[32m` / `\033[0;32m` / `\033[1;32m` / `\033[92m` (bright green) / `tput setaf 2` /
  256-color greens (`38;5;{2,10,22,28,34,40,46,70,76,82,118,154}`).
* **Use instead:** **orange `\033[1;38;5;208m`** (or `38;5;214` gold-orange where a second distinct
  orange is needed, e.g. the `claude-personal` statusline vs `claude-museum`'s 208). Success/OK states
  that were green → orange; the palette is orange (good) / yellow `38;5;220` (warn) / red `38;5;196`
  (bad) / cyan `38;5;45/51` (info) — all colour-blind-safe, no green.
* **Applies to:** statusline (`org-statusline.sh` + deployed `~/.claude-org-statusline.sh`), every
  session/stop hook banner, and every `scripts/*.sh` `GREEN=`/inline color. Fixed fleet-wide 2026-06-26.
* **When you add colored output:** never reach for green. If you need "good/pass," use orange.

## 14. Config propagation is DEEP-MERGE, never clobber (fleet-wide, MANDATORY)

* **The rule:** `update_all.sh`, `init_ai.sh`, and any future propagation path must NEVER
  plain-overwrite a repo-local JSON config. `.claude/settings.json` and `.mcp.json` are
  propagated through the shared `merge_json()` wrapper (`scripts/lib/merge_json.sh`, calling
  `scripts/lib/json_merge.py`): **framework-owned keys stay canonical (master wins), repo-local
  additions survive** (statusLine, extra session hooks, extra permissions, custom MCP servers),
  and the file is rewritten **only when the merged result differs semantically** — a no-change
  sync leaves the repo tree clean.
* **Why (real incidents):** the old unconditional overwrite clobbered agentFlow's repo-local
  settings **18 times** (3 in one session), burning a repair cycle
  (`git checkout origin/main -- .claude/settings.json .mcp.json`) at the start of every
  agentFlow session. The old `.mcp.json` jq merge also silently dropped every non-`mcpServers`
  top-level key and rewrote the file on every sync even when nothing changed. PR #289
  (2026-07-02) fixed all 5 `update_all.sh` callsites — but `init_ai.sh` had its OWN independent
  raw `sed ... > .claude/settings.json` overwrite that fix never touched, so re-`init`ing an
  already-customized repo kept clobbering (19th incident, 2026-07-05). Fixed by extracting
  `merge_json()` into a shared lib both scripts source, plus a cross-machine repo lock
  (`scripts/lib/sync_guard.sh`) so `init_ai.sh` and `update_all.sh` can't race each other's
  write to the same repo's `.claude/settings.json`.
* **Guard, not fallback:** if a repo's file is invalid JSON, the merge SKIPS it and reports —
  it never falls back to overwriting. A broken file is the repo agent's to fix; destroying it
  hides the problem.
* **When you add a new propagated JSON config:** wire it through `merge_json()`
  (`scripts/lib/merge_json.sh`) in whichever script writes it — never a raw `cp`/`sed`/jq
  overwrite. Tests: `scripts/tests/test_json_merge.sh` (17 assertions),
  `scripts/tests/test_init_ai_settings_merge.sh`.
  LL: `LL/2026-07-02-updateall-json-clobber-deepmerge.md`, `LL/2026-07-05-init-ai-settings-clobber.md`.

## 15. Checkpoint-as-you-go — the handoff is ALWAYS current, never end-loaded (fleet-wide, MANDATORY)

> Operator directive 2026-07-05: sessions repeatedly hit token/credit limits BEFORE the
> handoff/wrap-up was written, losing the session's context. The wrap-up ritual is a
> CLOSE-OUT, not the first save. The AI decides when to checkpoint — continuously.

**The rule — after EVERY completed unit of work** (a merged PR, a shipped/verified batch,
an operator decision or directive, a diagnosed incident), IMMEDIATELY and without asking:

1. **Update the handoff delta** — amend `state/AI_AGENT_HANDOFF.md`'s Last-session line /
   ACTION block with what just landed and what's next. Small surgical edits, not rewrites.
2. **Append a brain atom** (`brain commit` / session atom) for decisions and milestones —
   atoms are ~free and auto-push to the brain remote (survives machine death instantly).
3. **Commit + push `chore: update state`** to the working branch. State/AI commits are
   BUILD-FREE at every gate (§CI-thrift v2: pre-push skips, Actions cheap, Vercel skips) —
   there is no cost excuse for an unpushed handoff.

**Token-guard checkpoints are MANDATORY interrupts, not suggestions.** When hook 15 emits
`TOKEN GUARD: CHECKPOINT` (70% session budget), write + push the handoff before the next
piece of work. At an account-limit death, a current handoff is the difference between a
seamless resume and a blind session.

**Rule of thumb: at ANY random moment, a kill -9 of the session should cost at most the
last ~15 minutes of context.** If losing the session right now would lose more than that,
you are overdue — checkpoint first.

## 16. CI-thrift v2 — AI/docs-only changes are BUILD-FREE at all three gates (fleet-wide, MANDATORY)

> Operator directive 2026-07-05: an AI/framework or docs commit must NEVER rebuild the
> app stack. Framework propagation (`update_all.sh`), handoff/state pushes (§15), and doc
> edits are high-frequency and touch no runtime code — paying a Docker build + Actions run +
> Vercel deploy for each is pure credit burn. The **AI/docs set** —
> `AI/  docs/  state/  logs/  .claude/  *.md` — is build-free at every gate.

**The three gates, all skip AI/docs-only changes:**

1. **Pre-push (local, per-machine).** The CI-THRIFT pre-push hook diffs exactly what is being
   pushed against the remote base; if nothing outside the AI/docs set changed, it skips the
   Docker gate entirely (`[pre-push] AI/docs-only push — skipping Docker gate`). State-only
   commits (`chore: update state`) short-circuit even earlier. Installed/upgraded by
   `rollout_ci_thrift.sh install_prepush()`.
2. **GitHub Actions (`ci.yml`).** A `changes` job runs first and computes `outputs.code`
   (`false` when only the AI/docs set changed). Every heavy job (`lint`/`type-check`/`test`/
   `build`/`e2e`/…) carries `needs: changes` + `if: needs.changes.outputs.code == 'true'` and
   **skips** for AI/docs-only PRs. Jobs that depend on a gated job cascade-skip automatically.
   **NEVER use `paths-ignore` at the trigger level** — a required check that never posts a
   conclusion leaves the PR BLOCKED forever. A *skipped* required check, by contrast, counts as
   *satisfied* by branch protection, so the workflow still completes green and app-pinned
   required checks stay happy. Carried by `templates/ci.yml`; injected into divergent managed
   `ci.yml` files by `scripts/lib/ci_paths_gate.py` (surgical, comment-preserving, idempotent —
   PyYAML is NOT used because it strips the fleet's comments).
3. **Vercel (`vercel.json`).** `git.deploymentEnabled: {main:true, test:false, codeclot:false}`
   (§11) plus a paths-aware `ignoreCommand`: build only when `VERCEL_GIT_COMMIT_REF == main`
   **and** the `HEAD^..HEAD` diff touches something outside the AI/docs set (+ `.github`) —
   else `echo skip-build:ai-docs-only; exit 0`. So even an AI/docs-only merge to `main` costs
   zero deploys. Legacy branch-only `ignoreCommand`s are upgraded in place by
   `rollout_ci_thrift.sh gate_vercel()`; never clobbers a repo's own monorepo/path filter.

**Rollout & enforcement:** `./scripts/rollout_ci_thrift.sh --apply --commit` applies the proven
gates (Vercel prod-gate, pre-push AI/docs skip, `on:`-rewrite) across the fleet; add `--ci-gate`
to also inject the Actions paths gate into a repo's `ci.yml` (opt-in — validate the repo's first
PR-to-main after enabling, since a wrong required-check config can hang PRs). Dry-run default;
skips protected AI-folder-only / no-push repos. The
vercel-gate guard hook (`hooks/session/19-vercel-gate-guard.sh`) still warns on any repo that
lost its gate. Verify a repo with a dry-run before/after, then one AI-only PR (heavy jobs skip,
workflow green) and one code PR (full matrix runs) through its CI. Composes with the Local-CI
Policy (admin-merge when Actions is billing-blocked). This is why §15 can promise state/handoff
pushes are free — they are, at every gate.

## 17. Actions credit is scarce — strict PR discipline + no-review-for-docs (fleet-wide, MANDATORY)

> Operator ran OUT of GitHub Actions credit for a whole day (2026-07-05). §16 made
> AI/docs-only changes build-free, but every *PR* still triggers the check + review
> workflows once, and a PR-per-tiny-change multiplies that. Enforce mechanically.

**1. Docs go DIRECT to main; code goes via a (batched) PR. NEVER a PR for docs.**
Docs / AI_RULES / plans / ADRs / state / logs are docs-safe and **push directly to
`main`** — a direct push triggers ZERO check workflows (all are PR-to-main only) and
needs no Copilot/test/build, yet lands on main so **every other machine's `agent mode`
(which pulls main) sees the new docs immediately.** `hooks/pre-tool/01-block-push-main.sh`
permits this for the docs-safe fileset and blocks any push that also touches code.
Session/handoff continuity ALSO travels cross-machine via the brain auto-sync (§brain),
independent of the code repo. **App / runtime / hook / script / workflow / config code**
goes to `test` then a **single batched PR** to main (fold any accompanying docs in) —
never a PR-per-change, never a standalone PR for a one-line doc/hook change.

**2. Copilot NEVER reviews docs/AI-only PRs.** The Copilot-review workflow carries the
same §16 `changes` gate — `if: needs.changes.outputs.code == 'true'`. No code delta →
no review. (If Copilot runs as the repo auto-review APP rather than a workflow, disable
auto-review and request it manually only on code PRs.)

**3. No test/build workflow runs for docs.** Every check workflow (merge-gate, fleet-
smoke, script-unit-tests, ci, docs) uses the §16 `changes`-job + per-job `if:` skip —
NEVER `paths-ignore` at the trigger (that hangs required checks). A docs-only PR runs
only the cheap `changes` detector; every heavy/review job skips but the workflow still
completes green so required checks stay satisfied.

**4. Docs / AI changes NEVER build Vercel — production OR preview.** `vercel.json`'s
`ignoreCommand` skips EVERY non-main ref (so no preview build is created on any docs/
branch push) AND skips main commits whose diff is docs/AI-only (§16 paths-gate). A docs or
`AI_RULES` change must never produce a preview or a production deployment — it is *just
docs*. (Proven live: docs/state merges log `skip-build` instead of building.) Non-Next /
no-app repos additionally carry `deploymentEnabled` all-false so there is no project churn.

**5. Billing-blocked mode (Actions credit exhausted).** When credit is out: FREEZE PRs —
accumulate on `test`. If a merge is genuinely urgent, verify locally (`local-ci.sh`) and
`gh pr merge --admin` per the Local-CI Policy. Never wait on Actions that cannot run.

**Enforcement is hook + workflow level, not agent discipline** (shipped mechanically):

- **PR-creation guard — `scripts/pr_guard.sh`.** `ship it` / any `gh pr create` flow runs it
  first; it diffs HEAD vs `origin/main` (non-code set `AI/ docs/ state/ logs/ .claude/ hooks/
  config/ *.md`) and **REFUSES (exit 2)** a docs/AI/hook/config-only PR — override
  `PR_GUARD_FORCE=1` for a genuine standalone infra fix. (§17.1)
- **All check + review workflows carry the §16 `changes`-gate.** `scripts/lib/ci_paths_gate.py`
  now also gates a single-job `if:`-only workflow (the Copilot/Claude review shape) by merging
  `needs.changes.outputs.code == 'true' && (<orig if>)` — so merge-gate / fleet-smoke /
  script-unit-tests / ci / copilot-review / claude-review all skip their heavy/review job on a
  docs-only PR while the workflow still completes green (required checks stay satisfied). NEVER
  `paths-ignore` at the trigger. (§17.2/.3)
- **Copilot auto-review APP** (if enabled outside the workflow) — audit + disable with
  `scripts/disable_copilot_autoreview.sh`; see `documentation/BLUEPRINT_ORG_SETUP.md` §4a. (§17.2)
- **Vercel** — `rollout_ci_thrift.sh gate_vercel()` sets non-Next/Docker-only repos to
  `deploymentEnabled` all-false and web repos to build-only-main + AI/docs-skip `ignoreCommand`. (§17.4)
- **Rollout:** `./scripts/rollout_ci_thrift.sh --apply --ci-gate` gates EVERY PR-triggered
  workflow in a repo (not just `ci.yml`); propagated fleet-wide with `update_all`. `--ci-gate`
  stays opt-in per repo (validate the first PR-to-main after enabling). Covered by
  `scripts/tests/test_ci_paths_gate.sh` + `test_pr_guard.sh`.

---

## 18. Claude profile allocation + session-boot cost ceiling (fleet-wide, MANDATORY)

> Operator is running 3 Claude profiles simultaneously and hit budget pain on all 3 at once
> (2026-07-07): `claude-tech` weekly allowance 97% used (resets Saturday), `claude-museum`
> burned $1050 in 2 days, and the personal `claude` (Pro subscription) profile has limited
> interactive runway. All three burning at once means the allocation below is not optional.

**1. Profile roles — do not blur them.**
- **`claude-tech`** — the **runner profile**. Idle/after-hours + weekend autonomous work
  only. **Runner defaults to `claude-sonnet-5`, Sonnet-tier fallback chain, NO speculative
  Opus/Fable** (enforced in `cli_task_runner.sh` + `machine_selfheal.sh`, PR #352).
  **Failure-gated Opus escalation (2026-07-11):** Opus is reached ONLY as a capped last
  resort — a task that genuinely fails (`→ blocked`, not a trust/limit/resource-cap release)
  `ESCALATE_AFTER_FAILS` times on Sonnet (default 2) is promoted to `ESCALATION_MODEL`
  (`claude-opus-4-8`) for its next attempt, subject to a hard `OPUS_DAILY_CAP` (default 2
  Opus tasks / Sydney-day) and at most ONE Opus attempt per task. The ledger is machine-local
  (`~/.ai-cli-runner/escalation/`, never in the git tree). Disable with `RUNNER_ESCALATION=off`.
  This is the durable fix for the weekend Fable/Opus burn that torched a week of credit —
  Opus never runs speculatively, only after Sonnet has demonstrably failed. Tests:
  `scripts/tests/test_runner_escalation.sh` (17 cases).
- **`claude-museum`** — **mobile/remote-control of the master repo (`ai_management`) only** —
  i.e. instructing/directing work from a phone, not running heavy autonomous multi-agent
  work itself. Treat it as a light dispatch channel, not a compute profile.
- **`claude`** (default/personal, Pro subscription) — the **fallback profile**, used when the
  other two are unavailable or exhausted (this session is an example). Its capacity is a
  fixed Pro-plan allowance, not API-metered — the scarcest of the three for casual burning.

**2. Model choice for INTERACTIVE sessions (operator actively driving, not the runner):
default to Opus.** This is orthogonal to profile — Opus is for response quality when a human
is in the loop; Sonnet-only is a **runner-specific** rule (rule 1), not a blanket ceiling on
every session. Model pin lives in `.claude/settings.local.json` (`"model"` key) — verify it
matches intent before assuming which model is actually active; `/model` sets the *next new
session* default but a project-level pin in `settings.local.json` overrides on restart. If the
two disagree, surface it — do not silently pick one.

**3. Session-boot token ceiling — brain/cache must actually carry history, not raw re-reads.**
The brain-atom system (`brain_delta`) exists precisely so `agent mode` / `-a` / `-min` never
re-read `STATE.md` / `AI_AGENT_HANDOFF.md` / protocol docs wholesale — verified cost as low as
~34 tokens for an up-to-date `brain_delta` call. When boot still costs tens of thousands of
tokens, the leak is almost always ONE of: (a) a broken trim/rotation mechanism letting a
fallback file balloon unbounded (see `scripts/lib/trim_handoff.py` — the ACTION section was
exempt from trimming for ~2 weeks before the 2026-07-07 fix, 70KB→14KB), or (b) the agent
re-running an expensive command (a fleet-wide `update_all.sh` sweep, a full protocol-doc read)
more than once instead of capturing output once and extracting what's needed. **Full swarm
dispatch / fleet-wide `update_all.sh` is opt-in busy-work, not a rote default step of every
`agent mode -a`** — reserve it for when the task actually needs the fleet touched. Prefer a
`-min`-style brain-first boot by default; escalate to reading `CORE_KEYWORDS.md` / `STATE.md`
/ full fleet sweeps only when the task genuinely requires it.

**4. Autonomous credit pacing — a weekend must not drain the week (2026-07-11).** The
off-hours window *permits* weekend runs but never capped them; the only stop was the
reactive credit-exhaustion cooldown (i.e. the wall). That let a deep queue front-load a
whole week's credit on a free weekend and starve weekday interactive sessions. Fixed with a
dual-cap pacing throttle in `cli_task_runner.sh` (config: `config/runner_budget.conf`,
Dropbox-synced): a **DAILY spread cap** (a weekend can spend at most 2× the daily cap, never
the week) and a **WEEKLY reserve cap** (runner gets ~1/3 of the weekly `claude-tech`
allowance; 2/3 is protected for interactive). Caps run in **session-count** (always on, each
Sonnet session bounded by `MAX_MINUTES`) and **output-token** units (precision layer, set
`AUTO_WEEKLY_TOKEN_BUDGET` from `/usage`); per-session tokens are measured precisely via
`scripts/lib/session_tokens.py` (byte-offset snapshot/delta — no double-count). On a hit the
runner self-skips the fire (`credit pacing: … reached`, visible on `/schedule`) — no claim,
no spend. Bypass with `--force`/`FORCE_RUN=1`/`--task-id`; disable with `RUNNER_PACING=off`.
Ledger is machine-local (`~/.ai-cli-runner/pacing/`, never in git). Tests:
`scripts/tests/test_runner_pacing.sh` (17 cases).

**5. Trivial → local tier — free grunt on local Ollama (2026-07-12, fixed 2026-07-19).** Below
the Sonnet tier sits an optional **free** tier: a genuinely mechanical task (title/desc matches
`TRIVIAL_KEYWORDS` — chore/docs/format/lint/bump/rename/typo/comment/changelog/readme) runs
on a local Ollama model (`LOCAL_MODEL`, default `qwen2.5-coder:7b`) FIRST, with Sonnet as
fallback — and a local success is **not charged to the pacing budget** (§18.4). Escalation
(failure→Opus) always wins over trivial-routing. **VERIFIED 2026-07-18 that `claude -p
--model qwen2.5-coder:7b` never routes to Ollama** — Claude Code sends the model name straight
to Anthropic, which errors "model may not exist". Fixed by calling the Ollama HTTP API
directly instead of the `claude` CLI for this one tier (`scripts/lib/ollama_local_tier.sh` +
`scripts/lib/ollama_agent.py`): a bounded (default 6-iteration) tool-calling loop gives the
model `list_files`/`read_file`/`write_file` scoped to the task's workdir, and the runner
itself handles the `test`-branch checkout/commit/push (with the same fetch+rebase-retry-once
as an interactive session) once the model reports done. **Resource guards (non-negotiable
per user directive):** `OLLAMA_LOCAL_KEEP_ALIVE=2m` (model unloads shortly after each call,
not left resident) · single-concurrency lock (`ollama_lock_acquire`/`_release` — local
inference NEVER runs in parallel, even across concurrent runner slots) · a free-RAM
preflight (`ollama_ram_ok`, `OLLAMA_MIN_FREE_RAM_MB=1536`) that skips local outright and falls
straight through to Sonnet when the box is already tight, respecting the 2GB stack ceiling
(CLAUDE.md §2). **`RUNNER_LOCAL_TIER=on`** in `config/runner_budget.conf` (flipped from the
prior default-off now that the routing actually works). Low-risk: any decline/failure at any
stage (RAM preflight, lock contention, agent giving up, nothing to commit, unresolvable push
conflict) makes the model-loop fall through to Sonnet in the same fire — the task is never
released back to `pending` empty-handed on account of the local attempt alone. Full model
ladder now: **local qwen (trivial, free) → Sonnet 5 (default) → Opus 4.8 (failure-gated,
capped)**, all under the daily/weekly credit pacing. Tests:
`scripts/tests/test_runner_local_tier.sh` (8 cases, classifier), `scripts/tests/test_ollama_local_tier.sh`
(resource-guard + git-plumbing unit tests), `scripts/tests/test_ollama_agent.py` (bounded
tool-loop unit tests against a fake transport).

## 19. Framework CLI install — registry-only `npm i -g ai-management`, NO EXCEPTION (fleet-wide, MANDATORY)

> Operator directive (2026-07-22): a Mac was found running the framework CLI from a **local
> tarball** (`@knofler/ai-management@0.2.0`, scoped, installed via `npm i -g ./*.tgz`) instead
> of the published registry package. Tarball/scoped/link installs drift per-machine, silently
> lag the module, and defeat the myAI-native propagation model (CLAUDE.md "After Any Framework
> Change"). Every Mac must be **byte-identical**.

**1. The ONLY sanctioned install, on every machine, always:**
```bash
npm i -g ai-management      # bare name, from the public npm registry — nothing else
```
**No exception.** Explicitly FORBIDDEN as the framework install path:
- ❌ local tarball (`npm i -g ./ai-management-*.tgz`, `npm i -g <path>.tgz`)
- ❌ the scoped name `@knofler/ai-management` (it is **not published** — a tarball-only artifact)
- ❌ `npm link` / `npm i -g <local-dir>` / editable installs
- ❌ hand-copying `AI/` folders as the propagation path (that is legacy `update_all.sh`, dormant repos only)

**2. Propagation is module-based (never file-copy).** A framework change reaches the fleet by
**publishing the module** — bump `package.json`, `npm publish` (user-owed Gate 0), then
`npm i -g ai-management` on each machine. The hook `hooks/pre-tool/05-no-local-npm.sh` blocks
project-local host `npm install` (use Docker) but **exempts global installs** so this path is
never obstructed. Verify a machine is compliant: `myai root` must resolve to
`…/node_modules/ai-management` (bare), and `myai --version` must match `npm view ai-management version`.

**3. After install, manage EVERYTHING through the brain + the `ai-management` (`myai`) tool.**
State, memory, and continuity live in the git-versioned **brain** (`brain_*` MCP tools /
`brain` keywords); framework operations go through the **`myai` CLI** (`init`, `up`/`down`,
`scan`, `new-app`, `connect`, `schedule`, `doctor`, `mcp`, `root`). No out-of-band manual
file management of framework internals. This is the durable form of the operator directive:
one install path, one management surface, identical on every Mac.
