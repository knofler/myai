---
name: swarm-checkpoint
description: "Anti-drift checkpoint validation. Re-read the original task, compare completed work against requirements, calculate drift score, pause if drift exceeds threshold. Triggers: checkpoint, drift check, validate progress, anti-drift, stay on track"
---

# Swarm Checkpoint Playbook

## When to Use
- After completing 3 or more sub-tasks in a swarm execution
- When a sub-task output seems inconsistent with the original goal
- At any point where work feels like it may have diverged from the requirement

## Prerequisites
- The original task description is available (user prompt, feature spec, or STATE.md)
- `state/task-tree.md` exists with at least some tasks marked `done`
- Completed agent outputs are accessible for review

## Playbook

### 1. Re-Read the Original Task
Load the original task description verbatim. Do not paraphrase or summarize. Identify the core objective, acceptance criteria, and explicit constraints.

### 2. Inventory Completed Work
From `state/task-tree.md`, list all sub-tasks with status `done`. For each, summarize the actual output produced — files created, endpoints built, schemas defined, etc.

### 3. Calculate Drift Score
Score drift on a 0.0 to 1.0 scale by evaluating four dimensions:

| Dimension | Weight | Score 0.0 (no drift) | Score 1.0 (full drift) |
|-----------|--------|----------------------|------------------------|
| Scope | 0.3 | All work within original scope | Significant work outside scope |
| Requirements | 0.3 | All acceptance criteria addressed | Criteria ignored or contradicted |
| Architecture | 0.2 | Consistent with stated patterns | Deviates from tech mandates |
| Priority | 0.2 | High-priority items done first | Low-priority items done, high skipped |

**Drift Score** = sum of (dimension_weight * dimension_score)

### 4. Apply Threshold
- **Drift <= 0.1** — On track. Log checkpoint and continue.
- **Drift 0.1–0.3** — Minor drift. Log a warning, adjust remaining tasks to compensate.
- **Drift > 0.3** — Significant drift. **Pause all dispatching.** Report to user with analysis.

### 5. Produce Checkpoint Report
Write a checkpoint report:
```
## Checkpoint Report — [timestamp]
- Original objective: [one-line summary]
- Sub-tasks completed: [N] of [total]
- Drift score: [0.0–1.0]
- Dimensions: Scope=[x], Requirements=[x], Architecture=[x], Priority=[x]
- Action: [continue / adjust / pause]
- Adjustments needed: [list or "none"]
```

### 6. Correct Course if Needed
If drift > 0.1:
- Identify which completed tasks caused the drift
- Revise remaining sub-tasks in the task tree to compensate
- Re-prioritise to ensure acceptance criteria are met
- Update `state/task-tree.md` with revised plan

## Output
- Checkpoint report appended to `state/STATE.md`
- Updated `state/task-tree.md` if course correction was applied

## Review Checklist
- [ ] Original task was re-read verbatim, not from memory
- [ ] Every completed sub-task was evaluated against the original objective
- [ ] Drift score was calculated using all four dimensions with correct weights
- [ ] Threshold action was applied correctly (continue/adjust/pause)
- [ ] If drift > 0.3, dispatching was paused and user was notified
