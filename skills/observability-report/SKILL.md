# Skill: Observability Report

> **Agent:** Project Manager / Tech Lead
> **Trigger keywords:** `observability report`, `agent activity`, `framework metrics`
> **Output:** `reports/observability/`

---

## Purpose

Generate a comprehensive report on AI agent activity, task throughput, framework
health, and operational metrics. Provides visibility into how the multi-agent
system is performing across all managed projects.

---

## Steps

### 1. Parse Agent Logs
- Read `logs/claude_log.md`, `logs/gemini.md`, `logs/copilot.md`
- Extract per-session data:
  - Session start/end timestamps
  - Skills invoked and their outcomes (success/fail/abort)
  - Keywords triggered
  - Files created or modified
- Count total invocations per agent, per skill, per day

### 2. Task Metrics
- Read `tasks.json` (or equivalent task store)
- Compute:
  - Total tasks: open, in-progress, completed, blocked
  - Average time from creation to completion
  - Tasks created by monitoring vs manual
  - Tasks by priority (P0, P1, P2) and their completion rates
- Identify overdue tasks (open > 7 days for P0, > 14 days for P1)

### 3. Throughput Analysis
- Calculate per-session productivity:
  - Commits per session
  - Tasks completed per session
  - Skills executed per session
- Calculate weekly rolling averages
- Detect trends: improving, stable, declining

### 4. Stale Task Detection
- Flag tasks that have not been updated in:
  - P0: > 3 days
  - P1: > 7 days
  - P2: > 14 days
- For each stale task, check if it is blocked by another task
- Suggest re-prioritization or closure for abandoned tasks

### 5. Framework Drift Check
- For each repo in `config/managed_repos.txt`:
  - Check if `AI/` folder exists and is up to date
  - Compare `CLAUDE.md` against template
  - Verify `state/STATE.md` was updated within last 7 days
- Flag repos that are out of sync or stale

### 6. Write Reports
- Create timestamped report in `reports/observability/`:
  - `reports/observability/YYYY-MM-DD-summary.md`
- Report sections:
  - Agent activity summary (invocations, top skills, error rate)
  - Task throughput table (open/closed/blocked by priority)
  - Stale tasks list with recommended actions
  - Framework drift findings per repo
  - Trend indicators (arrows: up/down/stable)
  - Recommendations (max 5 actionable items)

### 7. Historical Comparison
- If previous reports exist in `reports/observability/`:
  - Compare current metrics against last report
  - Highlight improvements and degradations
  - Track whether previous recommendations were addressed

---

## Abort Conditions
- If no log files exist -> generate a bootstrap report noting the framework is new
- If `tasks.json` is missing -> skip task metrics, note in report

## Post-Completion
- Update `state/STATE.md` with observability summary
- Log action to `logs/claude_log.md`
- If any P0 stale tasks found, surface them prominently in output
