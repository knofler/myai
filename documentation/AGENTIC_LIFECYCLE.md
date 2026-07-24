# Agentic Lifecycle System

> Autonomous multi-agent lifecycle for any codebase — from first scan to ongoing maintenance.

---

## Overview

The Agentic Lifecycle System turns the AI Management Framework into a self-coordinating team. When you type `agent mode`, the PM agent reads the task board, assigns work to specialists, each specialist executes autonomously, QA validates, and the cycle continues until the board is clear or a review gate is hit.

**You only intervene for approvals** — merges, deploys, schema migrations, file deletions.

---

## Lifecycle Phases

```
1. ONBOARD    → scan keyword: integrity check → tech detection → agent opinions → task board
2. PLAN       → PM creates tasks, assigns to specialists, sets priorities
3. EXECUTE    → Specialists pick up tasks, execute, report back
4. REVIEW     → QA runs tests, tech-lead reviews, PM validates completion
5. SHIP       → ship it keyword: test → push → CI → preview → PR → merge
6. MONITOR    → Periodic: deps, drift, tests, secrets → auto-create tasks
7. REPEAT     → Loop back to EXECUTE with new tasks
```

---

## The `scan` Keyword (Onboarding)

First step for any new or existing codebase.

| Step | Agent | Action |
|------|-------|--------|
| 0 | security-integrity | Hash verify all agent/skill files, scan for injection |
| 1 | project-onboarder | Detect tech stack from package.json, Docker, directory structure |
| 2 | project-onboarder | Map tech stack → relevant agents |
| 3 | All relevant agents | Parallel domain scans → `reports/agent-opinions/` |
| 4 | project-onboarder | Compile `reports/codebase-scan.md` |
| 5 | project-manager | Auto-create task board from findings |
| 6 | — | Present summary to user |

---

## Autonomous Execution Model

### How Agents Self-Coordinate

```
agent mode (user triggers once)
  → PM reads state/tasks.json
  → PM assigns pending tasks to specialists (by domain match)
  → Each specialist:
      1. Reads their assigned task
      2. Reads relevant files
      3. Implements the change
      4. Updates task status → "review"
      5. Logs to claude_log.md
  → QA reviews: runs tests, checks coverage
  → Tech-lead reviews: standards, coherence
  → PM marks task → "done" or creates follow-up
  → Loop until: task board empty OR review gate hit
```

### Review Gates (require user approval)

Defined in `config/project-config.json` → `autonomy.require_approval_for`:

| Gate | Why |
|------|-----|
| `merge_to_main` | Production impact — user must verify preview |
| `deploy` | Infrastructure change — user confirms target |
| `delete_files` | Irreversible — user confirms intent |
| `schema_migration` | Data impact — user reviews migration plan |

Everything else executes autonomously.

### Autonomy Settings

```json
{
  "autonomy": {
    "auto_assign_tasks": true,
    "auto_execute_low_risk": true,
    "require_approval_for": ["merge_to_main", "deploy", "delete_files", "schema_migration"],
    "max_autonomous_tasks_per_session": 10
  }
}
```

---

## Task Management

### Task Board (`state/tasks.json`)

```json
{
  "id": "TASK-001",
  "title": "Fix missing auth middleware on /api/admin",
  "description": "Security scan found 3 admin endpoints without auth",
  "agent": "security-specialist",
  "status": "pending",
  "severity": "HIGH",
  "source": "scan",
  "created": "2026-03-27T10:00:00Z",
  "updated": "2026-03-27T10:00:00Z",
  "completed": null,
  "blockedBy": null,
  "notes": ""
}
```

**Status flow:** `pending` → `assigned` → `in-progress` → `review` → `done`

**Keywords:**
- `tasks` — show full task board
- `tasks pending` — filter by status
- `tasks assign` — PM auto-assigns pending tasks

---

## Monitoring

Configurable via `config/project-config.json` → `monitor_interval`:
- `"manual"` — only on `monitor` keyword
- `"daily"` — auto-runs on session start if >24h since last
- `"weekly"` — auto-runs on session start if >7d since last

### What gets checked:
1. **Dependency vulnerabilities** — `npm audit` inside Docker
2. **Codebase drift** — agent/skill file hashes vs master repo
3. **Test health** — run test suite, check for new failures
4. **Secrets scan** — grep for tokens/keys in tracked files

Critical findings auto-create tasks in `tasks.json`.

---

## Testing Workflow

| Keyword | Action |
|---------|--------|
| `test plan` | QA creates comprehensive test plan → `reports/test-plan.md` |
| `test report` | Run tests in Docker, produce `reports/test-results.md` |
| `ship it` | Auto-runs tests before push (if `auto_test_on_ship: true`) |

---

## Integrity Verification

| Keyword | Action |
|---------|--------|
| `integrity check` | SHA-256 hash all agent/skill files, compare against manifest |

### What gets checked:
- **MATCH** — file hash matches manifest (trusted)
- **MODIFIED** — hash differs (investigate)
- **NEW** — file not in manifest (needs baseline)
- **MISSING** — in manifest but file gone (investigate)
- **Injection patterns** — bash, eval, exec, base64, external URLs in playbooks

---

## Agent Teams (Claude Cowork)

When `agent_teams.enabled: true` in project config:

```bash
# PM spawns a team of Claude Code sessions
claude team start \
  --teammate "PM: manage tasks" \
  --teammate "Dev: implement features" \
  --teammate "QA: write and run tests"
```

Each teammate is a separate Claude Code session with:
- Shared task list (via `state/tasks.json`)
- Inter-agent messaging
- Own context window
- Parallel execution

---

## Mobile Control

### Remote Control
```bash
./AI/scripts/remote.sh  # Starts claude --remote-control
```
Then connect from Claude mobile app → full project access from phone.

### Telegram Channel
```bash
./AI/scripts/telegram-channel.sh  # Starts claude channel telegram
```
Send messages to Telegram bot → triggers Claude Code locally.

---

## Project Dashboard (`agents` keyword)

```
## Project Dashboard — example-app
Agents:  56 available, 8 active for this project
Skills:  134 available
Tasks:   3 pending, 2 in-progress, 12 done, 1 blocked
Last scan:    2026-03-27
Last test:    42 passed, 0 failed, 78% coverage
Monitor:      weekly, last run 2026-03-25
Autonomy:     ON (approval gates: merge, deploy, delete, migrate)
```

---

## Configuration Reference

### `config/project-config.json`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `project_name` | string | dir name | Display name |
| `monitor_interval` | string | "manual" | "manual", "daily", "weekly" |
| `active_agents` | array | ["all"] | Which agents to use |
| `excluded_agents` | array | [] | Agents to skip |
| `auto_test_on_ship` | bool | true | Run tests before ship it |
| `auto_monitor` | bool | false | Auto-monitor on session start |
| `autonomy.auto_assign_tasks` | bool | true | PM auto-assigns |
| `autonomy.auto_execute_low_risk` | bool | true | Execute without asking |
| `autonomy.require_approval_for` | array | [merge, deploy, delete, migrate] | Gates |
| `autonomy.max_autonomous_tasks_per_session` | number | 10 | Safety limit |
| `agent_teams.enabled` | bool | false | Use Claude Agent Teams |
| `remote_control.enabled` | bool | false | Enable remote access |

---

## Report Structure

```
reports/
  codebase-scan.md              ← Full scan results
  test-plan.md                  ← Test strategy + targets
  test-results.md               ← Test execution results
  integrity-report.md           ← Hash verification results
  monitoring-report.md          ← Periodic monitoring findings
  agent-opinions/               ← Per-agent domain opinions
    security-specialist.md
    api-specialist.md
    database-specialist.md
    frontend-specialist.md
    devops-specialist.md
    qa-specialist.md
    tech-lead.md
  observability/                ← Framework health
    agent-activity.md
    task-metrics.md
```

---

## MCP Migration Path

All file-based state (`tasks.json`, `scan-status.json`, `project-config.json`) maps directly to MongoDB collections when the MCP server (Phase 5) is built. Reports remain as files (human-readable artifacts). The MCP server will expose tools like `lifecycle.scan`, `lifecycle.tasks`, `lifecycle.monitor`.
