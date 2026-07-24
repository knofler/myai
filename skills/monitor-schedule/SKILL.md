# Skill: Monitor Schedule

> **Agent:** DevOps Specialist / QA Specialist
> **Trigger keywords:** `monitor`, `run monitoring`, `periodic check`
> **Output:** `reports/monitoring-report.md`, `state/scan-status.json`

---

## Purpose

Run periodic monitoring checks across the project: dependency audits, configuration
drift detection, test health, and secrets scanning. Produces a consolidated report
and auto-creates tasks for critical findings.

---

## Steps

### 1. Check Interval Configuration
- Read `state/scan-status.json` for last run timestamps per check type
- Default intervals: audit (daily), drift (daily), tests (per session), secrets (daily)
- Skip any check that ran within its interval unless `--force` is specified

### 2. Dependency Audit
- Run `docker exec <container> npm audit --json` to get vulnerability report
- Parse output: count critical, high, medium, low vulnerabilities
- For each critical/high: record package name, severity, fix available (yes/no)
- If `npm audit fix` can resolve, note as auto-fixable

### 3. Configuration Drift Check
- Compare current project files against framework templates:
  - `CLAUDE.md` vs `templates/CLAUDE_TEMPLATE.md`
  - `.github/workflows/` vs expected CI configs
  - `docker-compose.yml` structure vs standard
- Flag any drift as intentional (documented) or unintentional

### 4. Test Health Check
- Run the test suite via `docker exec <container> npm test`
- Compare results against last known good run from `reports/test-results.md`
- Flag new failures, coverage drops, or flaky tests (pass/fail inconsistency)

### 5. Secrets Scan
- Scan codebase for patterns: API keys, tokens, passwords, connection strings
- Check `.env` files are in `.gitignore`
- Verify no secrets committed in git history (last 10 commits)
- Check `docker-compose.yml` for hardcoded secrets vs env var references

### 6. Write Monitoring Report
- Output to `reports/monitoring-report.md` with sections:
  - Run timestamp and checks performed
  - Dependency audit summary with severity counts
  - Drift findings (intentional vs unintentional)
  - Test health status (pass/regress/fail)
  - Secrets scan results (clean / findings)
  - Overall health score: HEALTHY / NEEDS ATTENTION / CRITICAL

### 7. Auto-Create Tasks
- For each critical finding, create a task in `tasks.json`:
  - Critical vulnerability with fix available -> priority P0
  - Secrets exposure -> priority P0
  - Unintentional drift -> priority P1
  - Test regressions -> priority P1
- Tag tasks with `monitoring`, relevant agent, and severity

### 8. Update Scan Status
- Write timestamps for each completed check to `state/scan-status.json`
- Record overall health score for trend tracking

---

## Abort Conditions
- Docker not running -> skip test health check, run other checks, WARN
- No `package.json` -> skip audit, run remaining checks

## Post-Completion
- Update `state/STATE.md` with monitoring summary
- Log action to `logs/claude_log.md`
