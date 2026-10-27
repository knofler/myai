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

**A version release is a two-repo deal. Publishing to npm WITHOUT refreshing the public showcase mirror is an incomplete release** — `npm i -g ai-management` and `github.com/<owner>/myai` then drift apart (that drift is exactly what shipped the v0.6.4 dead-link fix late). Whenever you bump the version and publish, you MUST do BOTH, in one shot:

```bash
scripts/publish_release.sh --interactive-otp   # guard → npm publish → mirror sync
```

This wrapper runs, in order: (0) `npm whoami` auth preflight, (1) `publish_guard.sh` clean-room leak scan, (2) `npm publish --access public`, (3) **wait for the registry to serve the version**, then `publish_public_mirror.sh` (pulls the just-published tarball, scrubs infra identifiers, pushes one squashed snapshot to the public mirror), (4) `npm view` verification → one `RELEASE-VERIFIED` line. `MIRROR_REMOTE` auto-derives from `package.json` `repository.url` — no need to remember it. `SKIP_MIRROR=1` exists but is discouraged (only for a genuine npm-only hotfix).

**npm asks for WEB AUTH, not an OTP (verified 2026-09-09 on `ai-management@0.9.0`).** It prints `Authenticate your account at: https://www.npmjs.com/auth/cli/<uuid>` and waits; the operator approves in a browser and the publish resumes by itself. Nothing types a code, so `scripts/publish_release.sh <otp>` has nothing to consume — **prefer `--interactive-otp`**, which runs the guard first and then lets npm do whatever it needs at the moment it needs it. The `EOTP` recorded earlier that same day (blamed on a code expiring during the ~90s guard) was most likely this same mismatch, so **don't re-derive an OTP-ordering bug.** The OTP arguments stay supported for an account/registry that really is on TOTP.

**Driving it from an agent shell:** `--interactive-otp` requires a real tty (`[ -t 0 ]`). Give it one with tmux rather than bypassing the guard — `tmux new-session -d -s pub -c <root> "scripts/publish_release.sh --interactive-otp; exec bash"`, then `tmux capture-pane -pt pub` to watch and `tmux send-keys` to answer. Never reach for `PUBLISH_GUARD_SCRIPT=/usr/bin/true` to make an up-front code fit.

**If it fails AFTER step 2, the release is HALF-DONE — do not re-run the wrapper.** npm has the version, so a re-run dies at the already-published guard. Finish it with the mirror step alone (idempotent): `bash scripts/publish_public_mirror.sh`. This is what happened on 0.9.0: the registry took **880s (14.7 min)** to serve the tarball, the old `sleep 3` settle handed the mirror a 404, and the wrapper exited 1 with npm already live. Step 3 now polls (`RELEASE_AVAIL_RETRIES`/`RELEASE_AVAIL_SLEEP`, ~20 min budget) and retries the mirror, so the "atomic" claim below is actually true — but verify the END state (`npm view` + the mirror repo), never the loudest intermediate success line.

**Rules:**
- Publishing is still MANUAL (the operator approves auth in a browser) while GitHub Actions is billing-blocked — this wrapper is the standing publish path.
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

## 10. Live mail delivery — the three layers (arm the mail watcher)

The durable mailbox (`mail_send` / `mail_inbox`) is account-independent and never loses a message, but *live delivery* — poking a session so it reads the mail **now** — needs three complementary layers, because a session is sometimes busy, sometimes idle, and sometimes must be reached from outside:

| Layer | Covers | Mechanism |
|-------|--------|-----------|
| **Watcher** (idle) | a session sitting idle at the prompt (no hooks run) | `scripts/mail_watch.sh` — a blocking background `mail_inbox` poll; its **exit** re-invokes the session with the new mail |
| **mail-live hook** (busy) | a session actively working (hooks fire) | `hooks/mail-live.sh` — a throttled (~60s) poll on every `UserPromptSubmit` + `PostToolUse` that injects new mail into the live context |
| **live ping** | reaching a session from another account/session on the same Mac | `tell <label>` / `session_ping.sh` — an operator/agent-initiated poke (never automatic): PRIMARY is iTerm AppleScript `write text` into a lane's visible tab (`scripts/lib/session_lanes.sh`, operator direction 2026-10-03 — every session lives in a visible tab, no hidden tmux); `tmux send-keys` into a registered pane is the LEGACY fallback for older fleet doorways |

**Arming the watcher (MANDATORY on every interactive session):**
- A SessionStart banner (`hooks/session/37-arm-mail-watch.sh`, installed into every profile by `setup_org_dirs.sh`) prints the standing instruction.
- Launch `scripts/mail_watch.sh` as a **background task** (`run_in_background`, timeout 2h) at session start.
- **RE-ARM on every exit.** The watcher exits only when it has printed new mail — handle the mail, then launch it again in the background. An un-re-armed watcher is a deaf idle session.

**Addresses:** the watcher's default address set comes from `scripts/lib/session_registry.sh` → `session_default_addrs` — `host/repo`, `repo`, (opt-in `$MYAI_SESSION_ROLE`) `role`, and, for a session running a non-`default` lane (`session_profile`: `master` or a worker lane) **in the swarm repo** (`$SWARM_REPO`, default `ai_management`), `host/<lane>` too; the one session holding the swarm-coordinator lease also answers `host/coordinator` — the **same** set the mail-live hook watches, so both layers see identical mail. `host/<lane>` is what lets `tell <lane>` reach exactly that lane instead of the `host/repo` address every lane working the same repo shares (without it, a master and a worker side by side on one Mac only had one shared mailbox — a message to one silently woke, or was swallowed by, the other). A runner fire never answers `host/<worker-lane>` even from inside `claude-<worker-profile>`'s config dir (`MYAI_RUNNER_FIRE=1` excludes it — it is a queued task, not the operator's tech session). Pass an explicit JSON array as `$1` to override.

**No address collisions (2026-10-04).** An operator's terminal arrangement put master sessions in several workspace repos (plus worker sessions in others); with bare `host` and `host/<lane>` on every session, mail to `home-mac/master` surfaced in five master sessions (any could ack it first) and bare `home-mac` in ~11. Now: bare `host` is not watched by anyone; `host/<lane>` only by that lane's sessions in the swarm repo (a lane worktree `~/.myai/worktrees/ai_management/<task>` counts — `repo_id.sh`); and swarm role mail has a single-holder address — `swarm master take` (and the heartbeat tick, which heals it) records the holder in `~/.myai/swarm/coordinator.<host>.current`, `session_is_coordinator` gives ONLY that live session `host/coordinator`, and stepping down / losing the lease removes it. While a swarm is active `tell coordinator` and `tell <coordinator's lane>` (e.g. `tell master … --kind merge-go`) mail `host/coordinator` and ping that exact pid; with no swarm `tell coordinator` means master. Lane pings resolve among swarm-repo sessions only. The watcher re-derives its addresses each poll (an address gained mid-watch is watched without a re-arm), and on its first pass it REPORTS unacked mail to this session's direct addresses (`host/<lane>`, `host/coordinator` — `session_direct_addrs`) instead of seeding it silently: mail that landed between a watcher's exit and its re-arm used to be swallowed (three coordinator mails sat unseen for ~2 h).

**Lane addressing is reciprocal.** `tell <lane>` (`scripts/tell.sh`) resolves a lane label (`master` or a worker lane) straight to `host/<lane>`, skipping the live-session registry, so it lands whether or not the peer is in tmux/iTerm right now. When the SENDER is itself a lane session, its mail `from` is `host/<lane>` too (not `host/repo`), so a reply threads back to that exact lane rather than to every lane in the repo.

**agy is a reachable fleet lane, not just a headless swarm worker.** `scripts/agy_session.sh start` (shell alias `agy-rc`; `scripts/morning_boot.sh` phase 9b runs it unattended at the 08:00 boot) launches Antigravity registered as profile `agy`. It now runs the same way every other lane does — a **visible iTerm tab** with Remote Control on (operator direction 2026-10-03 superseded the original hidden-tmux session; `agy-rc`/phase 9b used to open a tmux pane, which still works as the legacy fallback above when iTerm isn't reachable). agy has no hooks and no background watcher of its own, so the `check mail <id>` line `tell`/`session_ping.sh` types into its tab **is** its wake-up; a ping that lands while it's busy is deferred (`session_ping.sh --deferred`, retried every ~15s for up to 10 min) rather than dropped, since nothing inside agy polls for it the way a Claude session's mail-live hook does. Never restart, stop, or re-register agy's own remote-control daemon (`com.google.antigravity-cli-daemon`) — it owns the fixed per-device entry; `agy_session.sh` only checks whether it's up.

**Mail headers are colour-coded fleet-wide**, so a scrollback shows direction at a glance: incoming prints a bold green `MAIL RECEIVED` header (`hooks/mail-live.sh`, `scripts/mail_watch.sh`, the session-start mailbox banner); outgoing prints a bold orange `MAIL SENT` header (`scripts/tell.sh`). `NO_COLOR` suppresses both.

**Mail discipline (operator rule, 2026-10-04).** Workers mail the coordinator — the active `swarm master` holder, or master when no swarm is running — ONLY for four things, always with the kind set: `tell --kind plan <coordinator> …` (a plan to approve), `--kind blocker` (stuck, or a claim conflict), `--kind merge-go` (branch/PR ready for the coordinator to merge), `--kind done` (task finished). Progress chatter, FYIs and "still working" notes do not go to the coordinator. While a swarm is active, `scripts/tell.sh` prints a WARNING when a worker session mails the coordinator's lane or master with no kind or another kind (it still sends — never blocks); the coordinator session itself may mail anything, and with no swarm active nothing is checked. Automated mail follows the same kinds: claim conflicts and unannounced config changes are `blocker`, `config_journal.sh note` is `done`.

**Deaf lanes are woken, not forgotten (2026-10-04).** A session with no `mail_watch.sh` in its process tree (`lanes_has_watcher`) only sees mail when it happens to make a tool call — once idle, nothing reaches it (a new worker mailed its plan, then sat idle ~9 min and never saw the GO). While a swarm is active, two mechanical layers cover it: (1) `tell` to a **busy** deaf lane also schedules the deferred idle ping (as for agy), and that loop stops as soon as the mail is acked; (2) on every tick the **coordinator** sweeps the other live lanes (`sm_deaf_sweep` in `scripts/swarm_master.sh`) and types `check mail <id>` into any **idle** deaf lane holding unacked mail older than `SWARM_DEAF_AFTER` (120s) — once per mail, `kind=result` excluded, agy skipped (its agy-loop watches for it), `SWARM_DEAF_SWEEP=0` disables. Both only type a READ command; neither sends mail, so the no-auto-reply guarantee below holds. Arming the watcher is still the rule — this is the safety net.

**Never auto-reply.** The watcher and the mail-live hook only READ and PRINT — neither has a send path. This is structural: a `kind=result` message can therefore never trigger another message, which is what stops agent-to-agent ping-pong. `tell` / `session_ping` are the only live pokes, and they are always operator/agent-initiated, never automatic.

**Fail-soft.** A gateway that is down / unreachable / 401 / returns garbage never wakes the session and never advances the watcher's first-pass state — it just keeps waiting, so a gateway restart doesn't spuriously replay every pre-existing message.

**Runner fires don't need it.** A headless CLI-runner fire (`scripts/cli_task_runner.sh`, running in a `ci-workspaces` / `.worktrees` clone) works ONE queued task and reads its mail at claim time, then exits — there is no idle window to cover. The ARM banner is suppressed in those workspaces (same guard as `hooks/session/34-collaborator-activity.sh`).

---

