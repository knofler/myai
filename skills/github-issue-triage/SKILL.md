---
name: github-issue-triage
description: "Auto-triage GitHub issues. Classify as bug/feature/question, assign priority P0-P3, detect duplicates, apply labels, and assign to appropriate agent or team. Triggers: triage issues, issue triage, classify issues, sort issues, triage"
---

# GitHub Issue Triage Playbook

## When to Use
- New issues have been filed and need classification.
- User says "triage", "triage issues", or "classify issues".
- Periodic maintenance to keep the issue backlog organized.

## Prerequisites
- `gh` CLI installed and authenticated.
- Repository has standard labels (or run `github-label-sync` first).
- Access to `documentation/MULTI_AGENT_ROUTING.md` for agent assignments.

## Playbook

### 1. Fetch Untriaged Issues
- Run `gh issue list --state open --label "" --limit 50 --json number,title,body,labels,createdAt`.
- Filter to issues missing priority or type labels.
- If no untriaged issues found, report "backlog is clean" and exit.

### 2. Classify Each Issue
- Read the issue title and body carefully.
- Classify into one of: `bug`, `feature`, `question`, `documentation`, `chore`.
- Bug indicators: "error", "crash", "broken", "doesn't work", stack traces.
- Feature indicators: "add", "support", "would be nice", "request".
- Question indicators: "how to", "is it possible", "help", question marks.

### 3. Assign Priority
- **P0 (Critical)**: Production down, data loss, security vulnerability.
- **P1 (High)**: Major feature broken, blocking multiple users.
- **P2 (Medium)**: Non-critical bug, important feature request with votes.
- **P3 (Low)**: Minor cosmetic issue, nice-to-have, edge case.
- Consider: user impact, frequency mentioned, severity of symptoms.

### 4. Detect Duplicates
- For each new issue, search existing issues: `gh issue list --search "<key terms>"`.
- Compare title and body similarity.
- If duplicate found, comment on the new issue linking the original.
- Close the duplicate with label `duplicate`.

### 5. Apply Labels
- Add type label: `bug`, `feature`, `question`, `documentation`, `chore`.
- Add priority label: `priority/P0`, `priority/P1`, `priority/P2`, `priority/P3`.
- Add area label if detectable: `area/frontend`, `area/api`, `area/database`, `area/devops`.
- Run `gh issue edit <number> --add-label "<labels>"`.

### 6. Assign to Agent/Team
- Map area to specialist agent using MULTI_AGENT_ROUTING.md.
- Frontend issues → frontend-specialist. API issues → api-specialist.
- Database issues → database-specialist. CI/CD issues → devops-specialist.
- If unclear, assign to tech-lead for routing.

### 7. Report
- Output a markdown table: Issue #, Title, Type, Priority, Labels, Assignee.
- Highlight any P0/P1 issues that need immediate attention.
- Log triage session in `logs/claude_log.md`.

## Output
- All untriaged issues classified, labeled, and assigned.
- Duplicate issues identified and closed.
- Triage report table with all decisions.

## Review Checklist
- [ ] All open issues without labels have been triaged.
- [ ] Priority assignments are justified by impact assessment.
- [ ] Duplicates detected and linked before closing.
- [ ] Labels applied consistently using standard label set.
- [ ] Agent assignments match MULTI_AGENT_ROUTING.md routing.
- [ ] P0/P1 issues flagged for immediate attention.
