---
name: swarm-escalate
description: "Escalate blocked sub-tasks by identifying root cause, determining resolution path (user input, different agent, or architectural decision), and routing accordingly. Triggers: escalate, unblock, stuck task, blocked task, resolve blocker"
---

# Swarm Escalate Playbook

## When to Use
- A sub-task has been in `blocked` status for more than one dispatch cycle
- `swarm-progress-track` identified blockers that need resolution
- An agent reports it cannot complete its assigned task

## Prerequisites
- `state/task-tree.md` has tasks with status `blocked`
- The blocker reason is documented (from progress tracking or agent report)
- Agent routing rules from `documentation/MULTI_AGENT_ROUTING.md` are available

## Playbook

### 1. Identify Blocked Tasks
Read `state/task-tree.md` and list all tasks with status `blocked`. For each, document:
- Task ID and description
- Assigned agent
- What it is blocked on
- How long it has been blocked
- Number of downstream tasks affected

### 2. Classify the Blocker
Determine the root cause category:

| Category | Description | Resolution Path |
|----------|-------------|-----------------|
| **Dependency** | Predecessor task not yet complete | Prioritise the predecessor |
| **Missing Input** | Needs information from user | Ask the user directly |
| **Wrong Agent** | Assigned agent lacks capability | Reassign to correct specialist |
| **Technical** | Bug, infra failure, or tooling issue | Route to devops or debug |
| **Architectural** | Needs a design decision first | Route to solution-architect |
| **External** | Waiting on third-party service or API | Document and set a reminder |

### 3. Apply Resolution Strategy

**Dependency blockers:** Check if the predecessor can be fast-tracked. If it has its own blockers, escalate recursively. If a circular dependency exists, flag for architectural review.

**Missing input:** Formulate a specific, concise question for the user. Include context so the user can answer without re-reading the entire task tree. Present as a numbered list if multiple inputs are needed.

**Wrong agent:** Update the task assignment in `state/task-tree.md`. Move the task back to `pending` with the new agent. Log the reassignment.

**Technical:** Dispatch to `devops-specialist` for infrastructure issues or the original agent with additional debugging context.

**Architectural:** Invoke `solution-architect` with the decision needed. Document the options and tradeoffs. Block downstream until resolved.

### 4. Execute the Resolution
Take the appropriate action immediately:
- Reassign tasks by updating the task tree
- Ask the user for input if needed
- Dispatch the appropriate specialist agent
- Update task status from `blocked` to `pending` or `active` as appropriate

### 5. Produce Escalation Report
```
## Escalation Report — [timestamp]
| Task ID | Blocker Type | Action Taken | New Status |
|---------|-------------|-------------|------------|
| T3 | dependency | Prioritised T2 | pending |
| T5 | missing input | Asked user | blocked (awaiting) |
```

### 6. Update State Files
- Update `state/task-tree.md` with new statuses and reassignments
- Append escalation report to `state/STATE.md`
- Log actions to `logs/claude_log.md`

## Output
- Escalation report in `state/STATE.md`
- Updated `state/task-tree.md` with resolved or re-routed tasks
- User questions (if any) presented clearly for quick response

## Review Checklist
- [ ] Every blocked task was evaluated and classified
- [ ] Resolution strategy matches the blocker category
- [ ] Reassigned tasks have updated agent assignments in the task tree
- [ ] User questions are specific and self-contained
- [ ] All state files are updated with escalation actions
