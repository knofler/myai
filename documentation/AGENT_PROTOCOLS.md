# Agent Protocols — load-on-demand companion to CLAUDE.md

> Moved out of `CLAUDE.md` on 2026-09-07 to cut per-session boot cost (CLAUDE.md was 56 KB ≈ 14k tokens on every start). Nothing here changed in substance. Read the numbered section you need; the numbers match the pointer list in `CLAUDE.md` → "Load-on-demand protocols".

---

## 1. CLI-Mobile Agent Workflow (Codeclot Branch Strategy)

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

## 2. Parallel Dispatch Rules

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

## 3. Project-Type Dispatch

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

## 4. MCP Servers (Auto-Configured)

Configured in `.mcp.json`, auto-managed by `update_all.sh`.

**Base (all projects):** Context7 (library docs), shadcn/ui (component browser), Playwright (E2E browser testing), Dropbox (file access via OAuth), myai (local gateway when Docker running).

**Conditional (auto-detected):**
- **Chrome DevTools** — web project (has `next.config.*` / `vercel.json` / `src/app/layout.tsx`) → browser console, network, screenshots
- **Google Stitch** — web project (auto with Chrome DevTools) → AI UI design
- **Docker** — has `docker-compose.yml` → container logs, exec, management (uses `{folderName}-*` naming)
- **OpenAPI** — has `src/app/api/` / `src/routes/` / `routes/` → exposes API endpoints as MCP tools from `/api/openapi.json`

**API-Key servers (add when ready):** see `AI/plan/MCP_SERVERS.md` for Brave Search, Figma, Sentry, MongoDB Atlas, Vercel, Upstash, Notion, Slack.

---

## 5. YOLO Mode — Autonomous Execution Protocol

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

## 6. Usage Guard Protocol — Session Capacity Management

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

## 7. Release & publish — npm AND the public mirror move together (MANDATORY)

**A version release is a two-repo deal. Publishing to npm WITHOUT refreshing the public showcase mirror is an incomplete release** — `npm i -g ai-management` and `github.com/knofler/myai` then drift apart (that drift is exactly what shipped the v0.6.4 dead-link fix late). Whenever you bump the version and publish, you MUST do BOTH, in one shot:

```bash
scripts/publish_release.sh <npm-otp>      # guard → npm publish → mirror sync (atomic)
```

This wrapper runs, in order: (1) `publish_guard.sh` clean-room leak scan, (2) `npm publish --access public --otp=<otp>`, (3) `publish_public_mirror.sh` (pulls the just-published tarball, scrubs infra identifiers, pushes one squashed snapshot to the public mirror). `MIRROR_REMOTE` auto-derives from `package.json` `repository.url` — no need to remember it. `SKIP_MIRROR=1` exists but is discouraged (only for a genuine npm-only hotfix).

**Rules:**
- Publishing is still MANUAL (operator supplies the 2FA OTP) while GitHub Actions is billing-blocked — this wrapper is the standing publish path.
- The host `no-local-npm` hook permits `npm publish` (it blocks `npm run`/`install`/`build` only), so run the wrapper directly with `bash`/`scripts/...`, not via `npm run`.
- The private `ai_management` repo NEVER goes public (it carries session history, the brain, the vuln queue, infra identifiers). The public surface is ONLY the curated, scrubbed mirror = the exact npm file set.
- After releasing, note the new version + mirror sync in the handoff so other Macs know to `npm i -g ai-management`.

---

## 8. Two-tier state architecture + RAG recall


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



## 9. Wrap Up Banner

The `wrap up` keyword MUST end with the ASCII WRAPPED UP banner as **final output**. Read `AI/documentation/WRAP_UP_BANNER.md` for the exact ASCII template + field placeholders (REPO, BRANCH, REMOTE, SESSION, WRAPPED, PRs, STATUS). Fill dynamically from git + session context. Banner makes session-end instantly visible when scrolling back.

---

