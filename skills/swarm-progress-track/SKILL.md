---
name: swarm-progress-track
description: "Track and report sub-task progress across all agents. Calculate completion percentage, identify blockers, and produce a status dashboard. Triggers: progress, status, track, how far, completion, dashboard"
---

# Swarm Progress Track Playbook

## When to Use
- During or after a multi-agent swarm execution to assess overall progress
- When the user asks for a status update on a complex task
- At session start to understand where a partially-completed task tree stands

## Prerequisites
- `state/task-tree.md` exists with sub-tasks and status fields
- `state/STATE.md` contains dispatch logs from previous execution

## Playbook

### 1. Load Current State
Read `state/task-tree.md` and parse all sub-tasks. For each task, capture:
- ID, description, assigned agent
- Status: `pending`, `active`, `done`, `blocked`, `skipped`
- Dependencies and whether they are satisfied

### 2. Calculate Metrics
Compute the following:
- **Total tasks**: count of all sub-tasks
- **Completed**: count with status `done`
- **Active**: count with status `active`
- **Blocked**: count with status `blocked`
- **Pending**: count with status `pending`
- **Completion %**: (completed / total) * 100, rounded to nearest integer
- **Effective velocity**: tasks completed per dispatch cycle

### 3. Identify Blockers
For each task with status `blocked`:
- State what it is blocked on (dependency, external input, failed predecessor)
- Identify the responsible agent or user action needed
- Estimate impact: how many downstream tasks are also blocked

### 4. Identify Critical Path
Trace the longest dependency chain from pending tasks to final deliverable. Highlight tasks on the critical path — delays to these tasks delay the entire deliverable.

### 5. Produce Progress Report
Output a formatted report:
```
## Progress Report — [timestamp]

### Summary
| Metric | Value |
|--------|-------|
| Total sub-tasks | [N] |
| Completed | [N] ([%]%) |
| Active | [N] |
| Blocked | [N] |
| Pending | [N] |

### Task Status
| ID | Description | Agent | Status | Blocker |
|----|------------|-------|--------|---------|
| T1 | ... | ... | done | — |
| T2 | ... | ... | blocked | Waiting on T4 |

### Blockers
- [T2]: [reason] — impact: [N downstream tasks blocked]

### Critical Path
T1 → T3 → T5 → T7 (estimated [N] more dispatch cycles)
```

### 6. Update STATE.md
Append the progress report summary to `state/STATE.md` under the active work section.

## Output
- Progress report displayed to user
- Summary appended to `state/STATE.md`
- Blocker list available for `swarm-escalate` to act on

## Review Checklist
- [ ] All sub-tasks from the task tree were accounted for
- [ ] Completion percentage is accurate
- [ ] Every blocked task has an identified reason and impact assessment
- [ ] Critical path is traced and highlighted
- [ ] Report is appended to STATE.md with timestamp
