---
name: swarm-dispatch
description: "Assign sub-tasks to agents by topology, dispatch in parallel where possible, sequence where dependent, and log dispatch status. Triggers: dispatch, assign agents, run tasks, execute plan, start swarm"
---

# Swarm Dispatch Playbook

## When to Use
- A task tree exists in `state/task-tree.md` and is ready for execution
- After `swarm-decompose` has produced a validated dependency graph
- When resuming a partially-completed task tree after a session break

## Prerequisites
- `state/task-tree.md` exists with sub-tasks, agent assignments, and dependency info
- The selected topology is known (from `swarm-topology-select` or default hierarchical)
- `state/STATE.md` is current

## Playbook

### 1. Load the Task Tree
Read `state/task-tree.md`. Parse all sub-tasks, their assigned agents, dependencies, and current statuses. Filter to only `pending` or `blocked` tasks.

### 2. Identify the Ready Set
A sub-task is **ready** if:
- Status is `pending`
- All tasks it depends on have status `done`
- No unresolved blockers exist for its agent

Collect all ready tasks into the dispatch batch.

### 3. Apply Topology Rules
Dispatch according to the active topology:
- **Hierarchical** — tech-lead reviews each output before the next task starts
- **Mesh** — all ready tasks execute simultaneously, agents coordinate peer-to-peer
- **Ring** — output of one agent feeds directly into the next in sequence
- **Star** — one central agent (tech-lead or solution-architect) coordinates all others

### 4. Dispatch Each Task
For each task in the ready set:
1. Announce: "Dispatching [ID]: [description] to [agent]"
2. Invoke the agent with the sub-task description and any predecessor outputs
3. Set the task status to `active` in the task tree
4. Record dispatch timestamp

### 5. Monitor Completion
As each agent completes its sub-task:
1. Capture the output or artifact produced
2. Set the task status to `done` in the task tree
3. Check if any `blocked` tasks are now unblocked and move them to `pending`
4. Re-run step 2 to find the next ready set

### 6. Log Dispatch to STATE.md
Update `state/STATE.md` with a dispatch log entry:
```
### Dispatch Log — [timestamp]
- Dispatched: T1 (frontend), T2 (api) — parallel
- Completed: T1 — output: [artifact]
- Next ready: T3 (depends on T2)
```

## Output
- Updated `state/task-tree.md` with current statuses for all sub-tasks
- Dispatch log appended to `state/STATE.md`
- Agent outputs collected and available for downstream tasks

## Review Checklist
- [ ] Only ready tasks (all dependencies met) were dispatched
- [ ] Topology rules were respected — no out-of-order execution
- [ ] Every dispatched task has a status update in the task tree
- [ ] Blocked tasks were re-evaluated after each completion
- [ ] STATE.md contains the dispatch log with timestamps
