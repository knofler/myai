# Automated PR review — rubric and lane design

Operator ask (2026-09-07): an automated review process for PRs across the fleet, without GitHub Actions (billing-blocked) and without Copilot autoreview (disabled for cost).

## Lane

`scripts/pr_review_step.sh` (to build) runs from the launchd CLI runner as a **recurring task** (`recurring_tasks_create`, every 2 h during the day), never as a gateway cron and never as an Actions workflow.

1. List open PRs across fleet repos with `gh pr list --limit 200` per repo (respect task-39d2bf78: the CLI silently caps at 30 without `--limit`). Skip repos in `config/schedule_ignore.txt`.
2. Skip PRs already carrying a `myai-review` commit status for the current head SHA.
3. For each PR: fetch the diff (cap 400 KB, else review file list + risk hotspots only), run a headless review with the rubric below. Model routing: Sonnet by default; any P0 candidate is re-checked once by Opus/Fable before it is posted. Hard cap: one review per head SHA, 3 reviews per PR lifetime.
4. Post **one** consolidated review comment (sections: Verdict, P0, P1, P2, Notes) and set commit status `myai-review` = `success` (no P0) or `failure` (P0 present). Add label `myai-reviewed`.
5. Record the run via `job_history_record` so the dashboard `/runs` shows it.

## Rubric

**P0 — block merge**
- Secrets, tokens, credentials, private keys, `.env` content in the diff.
- Direct changes to `main` protection, CI gates, or hook safety rails (`hooks/pre-tool/01`–`05`).
- Tests deleted, skipped, or assertions weakened without a linked reason.
- Auth, permission, tenant-isolation or rate-limit regressions.
- Schema change without migration + rollback; destructive data operation without guard.
- New or changed API endpoint not reflected in the OpenAPI spec (CLAUDE.md rule 7).

**P1 — must fix before merge, reviewer may waive with a reason**
- Changed logic with no test touching it.
- Unhandled promise / error path that can crash a request or the runner.
- Unbounded query, N+1, missing index on a new query path.
- Breaking change to a contract in `AI/plan/api-contracts/` or a published MCP tool signature.
- `npm install` / `node` invoked on the host instead of Docker.

**P2 — note only**
- Duplication, complexity > 10, naming, dead code, missing docs.

## Output contract

```
## myAI review — <verdict: APPROVE | REQUEST CHANGES>
P0 (n) · P1 (n) · P2 (n) · files <n> · model <id> · cost $<x>
### P0
- file:line — finding — why it blocks — suggested fix
### P1 …
### P2 …
```

Cost guard: abort and post `myai-review = error` with a one-line reason if the estimated review cost exceeds the per-PR cap in `config/session-limits.json` → `pr_review.max_usd` (default 0.40).
