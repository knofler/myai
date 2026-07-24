# Skill: Auto Task Assign

> Agent: **project-manager** (primary), **tech-lead** (reviewer)
> Triggers: `auto assign`, `create tasks`, `task board`

---

## Purpose

Convert scan findings and agent opinions into structured, prioritized tasks with agent assignments. Produces a machine-readable task board in `state/tasks.json` and a human-readable summary for the user.

---

## Inputs

| Input | Source | Required |
|-------|--------|----------|
| Scan report | `reports/codebase-scan.md` or `reports/agent-opinions/CONSOLIDATED.md` | Yes |
| Existing task board | `state/tasks.json` | No (created if missing) |
| Agent routing rules | `documentation/MULTI_AGENT_ROUTING.md` | Yes |

---

## Steps

### 1. Read Scan Report
- Parse the consolidated findings from the scan report.
- Extract each finding: description, severity, source agent, affected files, recommendation.
- If no scan report exists, prompt user to run `scan codebase` first.

### 2. Categorize by Severity
- **CRITICAL**: Create one individual task per finding. Mark as `blocking`. These must be resolved before any feature work.
- **HIGH**: Create one individual task per finding. Mark as `priority`.
- **MEDIUM**: Group related findings by domain/agent into batch tasks. One task per group.
- **LOW**: Collect into a single backlog task per agent domain. Mark as `backlog`.

### 3. Assign Agents
- For each task, determine the responsible agent using `documentation/MULTI_AGENT_ROUTING.md`:
  - Match affected files to agent domains (e.g., `.github/workflows/` -> `devops-specialist`).
  - Match finding topic to agent expertise.
  - If multiple agents could handle it, assign primary + secondary.
- Assign lane (A/B/C/D/Cross) based on agent mapping.

### 4. Structure Tasks
- Each task in `state/tasks.json` follows this schema:

```json
{
  "id": "TASK-001",
  "title": "Short description",
  "severity": "CRITICAL|HIGH|MEDIUM|LOW",
  "status": "open|in-progress|done|blocked",
  "assignee": "agent-name",
  "secondary": "agent-name or null",
  "lane": "A|B|C|D|Cross",
  "source": "scan report reference",
  "files": ["affected/file/paths"],
  "description": "Detailed description with context",
  "created": "ISO timestamp",
  "updated": "ISO timestamp"
}
```

- Number tasks sequentially: TASK-001, TASK-002, etc.
- Preserve existing tasks; append new ones. Do not duplicate (match by title + files).

### 5. Write Task Board
- Write or update `state/tasks.json` with all tasks.
- Sort: CRITICAL first, then HIGH, MEDIUM, LOW. Within same severity, group by lane.

### 6. Present Board to User
- Output a markdown summary table:

```
| ID | Title | Severity | Assignee | Lane | Status |
|----|-------|----------|----------|------|--------|
| TASK-001 | Fix exposed secrets in .env | CRITICAL | security-specialist | C | open |
| TASK-002 | Add auth middleware | HIGH | api-specialist | B | open |
```

- Show totals: X critical, Y high, Z medium, W low.
- Recommend execution order: all CRITICAL first (parallel by lane), then HIGH by lane priority.

---

## Outputs

| Output | Location |
|--------|----------|
| Task board | `state/tasks.json` |
| Task summary | Displayed to user |
| Log entry | `logs/claude_log.md` (appended) |

---

## Notes

- Tasks are the bridge between scanning and execution. No work should start without a task.
- When `agent mode` runs, it reads `state/tasks.json` to determine what each agent should work on.
- Completed tasks should be marked `done` with a timestamp, never deleted.
- The tech-lead reviews task assignments for cross-lane coherence before execution begins.
