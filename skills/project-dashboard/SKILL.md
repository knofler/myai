# Skill: Project Dashboard

> Agent: **project-manager** (primary)
> Triggers: `dashboard`, `show agents`, `project health`

---

## Purpose

Display a comprehensive health dashboard for the current project, showing agent status, task progress, scan results, test coverage, and deployment state at a glance. This is the go-to command for situational awareness.

---

## Inputs

| Input | Source | Required |
|-------|--------|----------|
| Project root path | Context or cwd | Yes |
| State file | `state/STATE.md` | No |
| Task board | `state/tasks.json` | No |
| Scan report | `reports/codebase-scan.md` | No |
| Integrity manifest | `state/integrity-manifest.json` | No |

---

## Steps

### 1. Read Project Config
- Detect project type: standalone, workspace root, or sub-repo.
- Read `package.json`, `docker-compose.yml`, `vercel.json`, `render.yaml` if present.
- Determine project name, version, and deployment targets.

### 2. Count Agents and Skills
- Count agent files in `.claude/agents/` (or `AI/.claude/agents/` for target projects).
- Count skill directories in `skills/` (or `AI/skills/`).
- List which agents are available vs. the full set of 13.
- Flag any missing agents that the tech stack requires.

### 3. Read Task Board
- Load `state/tasks.json` if it exists.
- Compute: total tasks, open, in-progress, done, blocked.
- Compute by severity: critical open, high open, medium open, low open.
- If no task board exists, show "No tasks — run `scan codebase` to generate."

### 4. Read Scan Status
- Check if `reports/codebase-scan.md` exists.
- If yes: extract last scan timestamp, total findings, findings by severity.
- If no: show "No scan performed yet."
- Check `reports/integrity-report.md` for last integrity check result (PASS/WARN/FAIL).

### 5. Read Test Results
- Check for test result files: `coverage/`, `test-results/`, or recent `docker exec` test output in logs.
- If available: extract pass/fail/skip counts and coverage percentage.
- If unavailable: show "No test results found."

### 6. Present Dashboard
- Output as a structured markdown dashboard:

```
## Project Dashboard: {project-name}
Generated: {timestamp}

### Overview
| Metric | Value |
|--------|-------|
| Project Type | {standalone/workspace/sub-repo} |
| Tech Stack | {detected technologies} |
| Agents Available | {X}/13 |
| Skills Available | {Y}/60 |
| Last Scan | {timestamp or "Never"} |
| Integrity | {PASS/WARN/FAIL or "Unchecked"} |

### Task Board Summary
| Severity | Open | In Progress | Done | Blocked |
|----------|------|-------------|------|---------|
| CRITICAL | X | X | X | X |
| HIGH | X | X | X | X |
| MEDIUM | X | X | X | X |
| LOW | X | X | X | X |
| **Total** | **X** | **X** | **X** | **X** |

### Deployment Status
| Environment | URL | Status |
|-------------|-----|--------|
| Production | {url} | {healthy/unhealthy/unknown} |
| Preview | {url} | {healthy/unhealthy/unknown} |

### Recent Activity
- {Last 5 entries from logs/claude_log.md}
```

- If any section has missing data, show the placeholder with a suggested command to populate it.

---

## Outputs

| Output | Location |
|--------|----------|
| Dashboard display | Rendered to user |
| No files written | Dashboard is read-only |

---

## Notes

- This skill is read-only. It never modifies any files.
- Run this at the start of any session for quick orientation.
- The dashboard adapts to what data is available; missing sections show helpful prompts instead of errors.
- For multi-repo dashboards across all managed projects, use the `list` keyword instead.
