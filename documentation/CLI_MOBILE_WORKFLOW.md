# CLI-Mobile Agent Workflow

> Seamless mobility between mobile Claude and CLI Claude across all managed repos.

---

## Overview

This workflow enables you to work on any project from your phone, tablet, or browser (mobile Claude), then continue seamlessly from your desktop/laptop (CLI Claude) — and vice versa. Every repo is self-contained with full AI context, so `agent mode` on any device gives you immediate access to all code, state, and handoff information.

---

## How It Works

### The Branch Model

```
main ─────────────────────────────────────────────── production
  │                                          ↑
  │  (mobile pulls from main)                │ (CLI merges PR)
  ↓                                          │
codeclot ──── mobile work ──── push ─────→ test ──── CI ──── PR
                                              ↑
                                              │ (CLI pushes here)
                                              │
                                         CLI work
```

- **`main`** — production branch, source of truth for latest code + state
- **`codeclot`** — mobile sync branch, never deployed, always merged via CLI
- **`claude/agent-mode-*`** — auto-created by Claude Code web/mobile (treated same as codeclot)
- **`test`** — staging branch, CI runs here, PR to main
- **`codeclot/<YYYYMMDD-HHMM>`** — timestamped branch for concurrent mobile sessions

### The Full Cycle

```
┌─────────────────────────────────────────────────────────────────┐
│                     CLI-MOBILE WORKFLOW                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  MOBILE (phone/tablet/browser)         CLI (desktop/laptop)     │
│  ══════════════════════════            ═════════════════════     │
│                                                                 │
│  1. Open any repo                      1. Open same repo        │
│  2. Type: agent mode                   2. Type: agent mode      │
│     ├─ git fetch origin                   ├─ git fetch origin   │
│     ├─ git checkout main                  ├─ git pull current   │
│     ├─ git pull origin main               ├─ find codeclot*     │
│     ├─ read STATE.md (latest!)            ├─ merge codeclot*    │
│     ├─ read HANDOFF (latest!)             ├─ delete codeclot*   │
│     ├─ checkout codeclot branch           ├─ read STATE.md      │
│     └─ READY: full context                └─ READY: full ctx    │
│                                                                 │
│  3. Do work                            3. Do work               │
│     ├─ code changes                       ├─ code changes       │
│     ├─ bug fixes                          ├─ bug fixes          │
│     └─ plan/review                        └─ plan/review        │
│                                                                 │
│  4. Type: wrap up                      4. Type: ship it         │
│     ├─ commit ALL to codeclot             ├─ push to test       │
│     ├─ push codeclot to remote            ├─ CI passes          │
│     └─ state + handoff saved              ├─ PR to main         │
│                                           ├─ merge to main      │
│                                           └─ state on main      │
│                                                                 │
│  ─── NEXT MOBILE SESSION ───           5. Type: wrap up         │
│  agent mode → pulls main                  ├─ state committed    │
│  → gets ALL CLI work + state              └─ pushed to main     │
│  → seamless continuity                                          │
│                                        ─── NEXT CLI SESSION ──  │
│                                        agent mode → merges      │
│                                        codeclot → gets all      │
│                                        mobile work              │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Session Type Detection

| Signal | Session Type | Working Branch |
|--------|-------------|----------------|
| hostname = `vm` | Mobile/Cloud | `codeclot` |
| `CODECLOT_OVERRIDE=1` | Forced Mobile | `codeclot` |
| `CODECLOT_OVERRIDE=0` | Forced CLI | `test` |
| Any other hostname | CLI | `test` |

---

## Agent Mode Steps by Session Type

### Mobile Session (`agent mode`)

```
Step 0a: git fetch origin
         git checkout main && git pull origin main
         → Now you have latest code + state from CLI
Step 0a: Create codeclot branch from main
         git checkout -b codeclot
         (or codeclot/<timestamp> if codeclot exists unmerged)
Step 0b: Multi-machine check (hostname comparison)
Step 1:  Read STATE.md + AI_AGENT_HANDOFF.md
Step 2:  Load SONA context
Step 3:  Report status (completed, in-progress, next)
Step 4:  Start work
```

### CLI Session (`agent mode`)

```
Step 0a: git fetch origin
         git pull origin <current-branch>
         → Now you have latest remote state
Step 0b: Multi-machine check (hostname comparison)
Step 0c: Docker naming check
Step 0d: Check for mobile branches (codeclot* AND claude/*)
         git branch -r | grep -E 'codeclot|claude/'
         For each: diff, report, merge, delete
Step 1:  Read STATE.md + AI_AGENT_HANDOFF.md
Step 2:  Load SONA context
Step 3:  Report status (completed, in-progress, next)
Step 4:  Dispatch work (swarm coordinator)
```

---

## Wrap Up by Session Type

### Mobile: `wrap up`

1. Summarize session work
2. Update STATE.md + AI_AGENT_HANDOFF.md + logs
3. `git add -A && git commit` — commit ALL changes (code + state)
4. `git push -u origin codeclot` — push to remote
5. Show traffic-light dashboard

### CLI: `wrap up`

1. Summarize session work
2. Update STATE.md + AI_AGENT_HANDOFF.md + logs
3. Commit state files
4. Push to current branch (test or main)
5. **Ensure state reaches `main`** — this is critical for mobile sync
6. Show traffic-light dashboard

---

## Why Every Repo Must Be Self-Contained

Mobile Claude loads a single repo. It cannot access workspace roots, parent directories, or other repos. Therefore:

| File | Required In Every Repo | Purpose |
|------|----------------------|---------|
| `AI/state/STATE.md` | YES | Project progress, blockers, decisions |
| `AI/state/AI_AGENT_HANDOFF.md` | YES | Context for next session |
| `AI/logs/claude_log.md` | YES | Session history |
| `AI/agents/*.md` | YES | 59 specialist agent definitions |
| `AI/skills/` | YES | 135 skill playbooks |
| `AI/documentation/` | YES | AI rules, routing, guides |
| `CLAUDE.md` | YES | Routing rules + keywords |

The `update_all.sh` script ensures all repos have these files. If state files are missing, it creates skeleton templates (never overwrites existing content).

---

## Mobile Branch Patterns

Mobile work can arrive via two naming conventions:

| Source | Pattern | Example |
|--------|---------|---------|
| Manual / codeclot protocol | `codeclot` or `codeclot/<timestamp>` | `codeclot/20260405-1430` |
| Claude Code web (auto-generated) | `claude/agent-mode-*` or `claude/*` | `claude/agent-mode-lF3SR` |

CLI `agent mode` MUST check both: `git branch -r | grep -E 'codeclot|claude/'`

## Concurrent Mobile Sessions

If you have multiple mobile sessions before a CLI merge:

```
Mobile Session 1 → codeclot           (first session gets the default name)
Mobile Session 2 → codeclot/20260405-1430  (timestamped to avoid conflicts)
Mobile Session 3 → claude/agent-mode-xY7qR (auto-created by Claude Code web)

CLI agent mode → merges ALL mobile branches, deletes each after merge
```

## Critical: Mobile Must Pull Main First

**The single most important step in the mobile `agent mode` workflow is:**

```bash
git checkout main && git pull origin main
```

This MUST happen before reading state files or doing any work. Without it:
- Mobile works on stale code (missing CLI changes)
- Mobile reads stale STATE.md and HANDOFF (missing CLI context)
- The whole CLI-Mobile cycle breaks

CLI sessions push code + state to `main` via PR. Mobile must pull `main` to receive it.

---

## Quick Reference

| Action | Mobile | CLI |
|--------|--------|-----|
| Start work | `agent mode` (pulls main) | `agent mode` (merges codeclot) |
| Save work | `wrap up` (pushes codeclot) | `ship it` (pushes test→main) |
| Working branch | `codeclot` | `test` |
| State sync | Pulls from `main` | Pushes to `main` via PR |
| Safety | Never deploys codeclot | Never pushes to main directly |
