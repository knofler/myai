---
name: status-report
description: "Generate a project status report from state/STATE.md with completed work, in-progress items, risks, blockers, and milestone progress. Triggers: status report, progress report, project status, how are we doing, update report"
---

# Status Report

Generate a comprehensive project status report.

## Playbook

### 1. Read Current State

- Read `AI/state/STATE.md` for the authoritative project state.
- Read `AI/state/AI_AGENT_HANDOFF.md` for recent session context.
- Check `logs/claude_log.md` for recent activity timestamps.

### 2. Summarize Completed Work

- List all items marked as done since the last report.
- Group by milestone or epic if applicable.
- Note the completion date for each item.

### 3. List In-Progress Items

- List all items currently being worked on.
- Note the assigned agent or owner for each.
- Estimate percent complete where possible.

### 4. Identify Risks and Blockers

- **Blockers**: items that are stopped and need intervention.
- **Risks**: items that could become blockers if not addressed.
- For each, note severity (High / Medium / Low) and mitigation plan.

### 5. Calculate Milestone Progress

- For each active milestone, count total vs. completed deliverables.
- Calculate percentage complete.
- Assess whether the milestone is on track, at risk, or behind.

### 6. Output Formatted Report

```
## Project Status Report — [date]

### Overall Health: [Green / Yellow / Red]

### Completed Since Last Report
- [item] — [date]

### In Progress
| Item | Owner | Progress |
|------|-------|----------|

### Blockers
| Blocker | Type | Since | Owner |
|---------|------|-------|-------|

### Risks
| Risk | Severity | Mitigation |
|------|----------|------------|

### Milestone Progress
| Milestone | Done | Total | % | Status |
|-----------|------|-------|---|--------|

### Next Steps
1. ...
2. ...
```

Present to the user. Offer to save to `plan/` if requested.
