#!/usr/bin/env python3
"""slim_claude_md.py — turn the 56 KB CLAUDE.md into a ~16 KB kernel.

WHY: CLAUDE.md is loaded into EVERY session (~14k tokens before any work).
The framework's own boot cost exceeded what the brain saved. This script
moves long protocol sections to documentation/AGENT_PROTOCOLS.md, replaces
the core-keyword table with one-line summaries pointing at
documentation/CORE_KEYWORDS.md (the checker-enforced canonical copy, synced
2026-09-07), and rewrites the Zero-Prompt Policy for the auto-mode era.

Idempotent: exits if CLAUDE.md already carries the slim-kernel marker.
Run:  python3 scripts/slim_claude_md.py   (then: bash scripts/check_agent_min_protocol.sh)
"""
import os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLAUDE = os.path.join(ROOT, "CLAUDE.md")
AP = os.path.join(ROOT, "documentation", "AGENT_PROTOCOLS.md")

src = open(CLAUDE).read()
if "Slim kernel (2026-09-07)" in src:
    print("CLAUDE.md already slim — nothing to do"); sys.exit(0)

parts = re.split(r'(?m)^(?=## )', src); head = parts[0]; secs = parts[1:]
name = lambda s: s.split('\n', 1)[0][3:].strip()
S = {name(s): s for s in secs}
find = lambda p: next(k for k in S if k.startswith(p))
G = lambda p: S[find(p)]

sm = G("State Management Protocol"); sm_keep, sm_rest = sm.split("### Two-tier state architecture", 1)
sm_move = "### Two-tier state architecture" + sm_rest
qk = G("Quick Keywords"); ext = "### Extended keywords" + qk.split("### Extended keywords", 1)[1]

head = head.rstrip() + """

> **Slim kernel (2026-09-07).** This file is loaded into every session, so it holds only rules and one-line keyword summaries. Full protocols live in `documentation/` — **`CORE_KEYWORDS.md`** (every core keyword, checker-enforced), **`AGENT_PROTOCOLS.md`** (mobile/CLI branches, dispatch lanes, MCP, YOLO, usage guard, release, state tiers), **`KEYWORDS_REFERENCE.md`** (extended keywords). Read the *section* you need (`grep -n '^## ' <file>` then Read with offset/limit), never the whole file.

---

"""

pointers = """## Load-on-demand protocols (documentation/AGENT_PROTOCOLS.md)

Read the numbered section when the task needs it — not at session start.

1. **CLI ↔ Mobile branch workflow** — `codeclot*` / `claude/*` are sync branches; mobile sessions pull `main` first and work on `codeclot`; CLI `agent mode` merges them and deletes merged ones. Never deployed.
2. **Parallel dispatch lanes** — A frontend+ui-ux, B api+database, C devops+security, D docs+architect+PM, Cross tech-lead+QA. Sequential only when one lane's output is another's input.
3. **Project-type dispatch** — which lanes start immediately for a Next.js app vs an API-heavy project.
4. **MCP servers** — `.mcp.json` is authoritative; base set myai, Context7, shadcn/ui, Playwright, Dropbox, GitHub, Vercel; conditional Chrome DevTools, Docker, OpenAPI.
5. **YOLO protocol** — timed / god mode mechanics, 3-strikes postmortem block.
6. **Usage Guard** — 80/90/95% levels and what each mandates (warn-only by default).
7. **Release & publish** — `scripts/publish_release.sh <npm-otp>` runs guard → `npm publish` → public-mirror sync **atomically. Never publish npm without the mirror.** Manual while Actions is billing-blocked.
8. **Two-tier state** — hot `STATE.md`/handoff, cold `AI/state/archive/`; `rotate_state.sh` keeps hot bounded; RAG recall via the master gateway when `RAG_RECALL=1`.

---

"""

zero = """## Zero-Prompt Policy

Operator direction (PR #147, 2026-05-22): no-question operation is the default in `agent mode`, `wrap up`, `yolo`. Implemented in the **committed** `.claude/settings.json`: `permissions.defaultMode` + `skipDangerousModePermissionPrompt` + `skipAutoPermissionPrompt`, with the `permissions.allow` block (PR #146) as fallback.

- **`defaultMode` is `auto` since 2026-09-07** (was `bypassPermissions`). Team/Enterprise orgs gained a server-side policy that disables the older mode; it never lands on disk, and Claude Code silently downgraded every such session to `manual` from 2026-09-03. `auto` is the sanctioned zero-prompt mode. Fleet rollout: `scripts/rollout_permission_mode.sh --dry-run`, then without the flag. Do **not** move `defaultMode` out of the committed file.
- **Safety rails are hooks, not permissions** (`hooks/pre-tool/01`–`05`: block push to main, commit lint, secret scan, protected files, no local npm). They match `Bash` only and are blind to MCP writes — which is why github/vercel/dropbox/docker writes stay off the MCP allow-list and `gitkraken` is pinned `--readonly`.
- **Auto mode may decline a call** (nested `claude`, fleet-wide git loops, edits to permission files or hooks, commands carrying credentials, wholesale rewrites of CLAUDE.md). Report the decline plainly and hand the operator a one-liner to run with `! <command>`; do not look for another route to the same effect.
- If tools prompt anyway: check `/permissions`. `hooks/session/29-permission-mode-guard.sh` reports what is *declared*; no hook can see the *effective* mode. Compound one-liners match no `Bash(cmd:*)` allow rule — prefer one simple command per call.

---

"""

kw = """## Quick Keywords — Core (always loaded)

One-line summaries. **The full, step-numbered protocol for each row is in `documentation/CORE_KEYWORDS.md` — Read that row's section before executing a keyword you have not run this session.** The Keyword Execution Protocol above (announce → per-step report → summary table) applies to all of them.

| Keyword | What it does |
|---------|--------------|
| `hello` | Table of all keywords (core + `KEYWORDS_REFERENCE.md`). |
| `jam` / `jam <idea>` | Brainstorm **before** building. A real conversation — questions and pushback are the work (explicit zero-prompt exception). No code, edits, or commits. On convergence: brief to `AI/plan/jam/<slug>.md` + `plan_set`, then decision point: schedule / more jam / park. |
| `start work` | Multi-machine check → read STATE + handoff → report done / in-progress / blocked → next priority. |
| `agent mode` / `agent mode -a` | Full session start: project identity → `git fetch` + pull (mobile: pull `main`, branch `codeclot`) → machine, Docker-naming, Dropbox-`.git` checks → mobile-branch merge → `rotate_state.sh` → SCHEDULE banner (`hooks/session/17-schedule-status.sh`) → remote check (`remote_fleet.sh`) → schedule ingest → blueprint onboarding if `.awaiting-app-idea` → **brain boot** (`brain_delta` since the handoff's `Brain:` SHA, `repo`-scoped) or file fallback → LL scan → report → MCP list → dispatch lanes → update state. `-a`: then `./AI/scripts/yolo.sh start god`. |
| `agent mode -min` / `agent min` | Lightweight start, under a minute: `git fetch` + pull → brain boot via `brain_delta` (or **one** Read of the handoff on fallback — never STATE.md) → SCHEDULE banner → remote check (current repo only) → surface the `BOOT SYNC` block → report last session, ACTION, queue. Skips every other maintenance step. Read budget enforced by `scripts/check_agent_min_protocol.sh`. |
| `agent mode -resume` / `agent resume` | Join the last runner session for this repo: SCHEDULE banner → Read newest `~/.ai-cli-runner/logs/*-<repo>-task-*.log` → cross-check task store + `git log test -5` → JOIN summary → continue as that agent. |
| `ship it` | Commit → push `test` (never `main`) → CI (local-ci fallback when Actions is billing-blocked: real gates in Docker first, then post statuses) → Vercel preview → `pr_guard.sh` (refuses docs-only PRs) → PR `test`→`main` → AI review → merge (`--admin` **only** for the billing/outage case over genuinely green gates, announced) → post-merge reviewer comments → update STATE/handoff/log → `git merge origin/main` into `test`. |
| `wrap up` / `wrap up -u` | `schedule plan` first (`-u` skips it) → session-close writing a **thin handoff delta** (header `Brain:`/`Last machine:`, ACTION block, top-3 session lines) → `rotate_state.sh` → `memory_reindex` → `repo_card.sh` → **`brain_commit` (with `topic`) + `brain_merge` = the primary record** → commit + push state → traffic-light dashboard → **WRAPPED UP banner** (`documentation/WRAP_UP_BANNER.md`) as final output. |
| `merge it` | PR `test`→`main` (create if missing), CI green, merge, flip bug/feature DB rows to deployed, confirm prod. |
| `yolo god` / `yolo <min>` / `yolo off` | Autonomous mode until next commit or plan done / for N minutes / stop. `./AI/scripts/yolo.sh start god|<min>|stop`. Skips prompts, never safety rails. 3 consecutive failures → `3-strikes stop` postmortem block. |

"""

new = (head + G("CRITICAL RULES") + G("Keyword Execution Protocol") + G("On Session Start") + pointers
       + G("Specialist Subagents") + G("Skills") + zero + kw + ext.rstrip() + "\n\n---\n\n"
       + G("Deployment Workflow") + G("Quality Gates")
       + sm_keep.rstrip() + "\n\nTwo-tier hot/cold state layout and RAG recall: `documentation/AGENT_PROTOCOLS.md` §8.\n\n---\n\n"
       + G("File Domain Ownership"))

moved = ["CLI-Mobile Agent Workflow", "Parallel Dispatch Rules", "Project-Type Dispatch", "MCP Servers",
         "YOLO Mode", "Usage Guard Protocol", "Release & publish"]
ap = """# Agent Protocols — load-on-demand companion to CLAUDE.md

> Moved out of `CLAUDE.md` on 2026-09-07 to cut per-session boot cost (CLAUDE.md was 56 KB ≈ 14k tokens on every start). Nothing here changed in substance. Read the numbered section you need; the numbers match the pointer list in `CLAUDE.md` → "Load-on-demand protocols".

---

"""
for i, p in enumerate(moved, 1):
    s = G(p); first, rest = s.split('\n', 1); ap += f"## {i}. {first[3:]}\n{rest}"
ap += "## 8. Two-tier state architecture + RAG recall\n\n" + sm_move.split('\n', 1)[1]
ap += "\n\n## 9. Wrap Up Banner\n" + G("Wrap Up Banner").split('\n', 1)[1]

open(AP, "w").write(ap)
open(CLAUDE, "w").write(new)
print(f"CLAUDE.md {os.path.getsize(CLAUDE)} bytes (was {len(src)}); AGENT_PROTOCOLS.md {os.path.getsize(AP)} bytes")
