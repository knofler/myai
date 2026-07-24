# Skill: Agent Opinion Gather

> Agent: **project-manager** (orchestrator), all relevant specialists (contributors)
> Triggers: `gather opinions`, `agent review`

---

## Purpose

Dispatch multiple specialist agents to review a codebase or specific topic in parallel, collect their domain-specific opinions, and consolidate them into a structured set of reports. This is the primary mechanism for multi-agent analysis.

---

## Inputs

| Input | Source | Required |
|-------|--------|----------|
| Agent dispatch list | Calling skill or user | Yes |
| Project root path | Context or `config/managed_repos.txt` | Yes |
| Scan scope | `full` (entire codebase) or file/directory list | No (defaults to full) |
| Focus topic | Free text describing what to evaluate | No |

---

## Steps

### 1. Validate Dispatch List
- Confirm each agent in the dispatch list exists in `.claude/agents/`.
- Remove duplicates. Log any unknown agents as warnings.
- Minimum 1 agent required; maximum is all 13.

### 2. Prepare Output Directory
- Ensure `reports/agent-opinions/` directory exists.
- Clear stale opinions from previous runs (archive to `reports/agent-opinions/archive/` with timestamp).

### 3. Dispatch Domain Scans
- For each agent in the dispatch list, dispatch in parallel by lane:
  - **Lane A** (frontend-specialist, ui-ux-specialist): Scan pages, components, styles, accessibility, design system usage.
  - **Lane B** (api-specialist, database-specialist): Scan routes, controllers, models, schemas, queries, migrations.
  - **Lane C** (devops-specialist, security-specialist): Scan Docker, CI/CD, env vars, secrets, headers, auth flows.
  - **Lane D** (documentation-specialist, solution-architect, product-manager): Scan docs, ADRs, README, feature coverage, architecture coherence.
  - **Cross-lane** (tech-lead, qa-specialist, tech-ba, project-manager): Scan standards, test coverage, requirements traceability, delivery state.
- Agents within the same lane run in parallel. Lanes run in parallel.

### 4. Each Agent Writes Opinion
- Each dispatched agent writes to `reports/agent-opinions/{agent-name}.md` using this format:

```markdown
# {Agent Name} Opinion

**Scanned**: {timestamp}
**Scope**: {files/directories scanned}
**Duration**: {time taken}

## Summary
{2-3 sentence overview of findings}

## Findings

| # | Finding | Severity | File(s) | Recommendation |
|---|---------|----------|---------|----------------|
| 1 | ... | CRITICAL/HIGH/MEDIUM/LOW | ... | ... |

## Recommendations
1. {Prioritized recommendation}
2. ...
```

### 5. Wait and Collect
- Wait for all dispatched agents to complete (timeout: 5 minutes per agent).
- Verify each expected opinion file exists and is non-empty.
- Log any agents that timed out or produced empty output.

### 6. Format Consolidated View
- Read all opinion files.
- Merge all findings into a single list, sorted by severity (CRITICAL first).
- Deduplicate findings that multiple agents flagged (keep the most detailed version, note agreement).
- Write consolidated view to `reports/agent-opinions/CONSOLIDATED.md`.

---

## Outputs

| Output | Location |
|--------|----------|
| Per-agent opinions | `reports/agent-opinions/{agent-name}.md` |
| Consolidated findings | `reports/agent-opinions/CONSOLIDATED.md` |
| Dispatch log | `logs/claude_log.md` (appended) |

---

## Notes

- Agents should only report on their domain. A frontend-specialist should not opine on database schema.
- If a focus topic is provided, agents narrow their scan to that topic within their domain.
- The consolidated report is the primary input for `auto-task-assign` and `codebase-scan` compilation steps.
- Always log the dispatch and completion to `logs/claude_log.md` with timestamps.
