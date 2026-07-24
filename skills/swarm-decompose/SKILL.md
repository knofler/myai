---
name: swarm-decompose
description: "Break a complex task into sub-tasks, identify components, map to specialist agents, and produce a dependency-aware task tree. Triggers: decompose, break down, split task, task tree, subtasks"
---

# Swarm Decompose Playbook

## When to Use
- A task is too large or cross-cutting for a single agent to handle
- The user requests a feature that spans multiple specialist domains (frontend, API, DB, etc.)
- You need to plan parallel execution across lanes before dispatching

## Prerequisites
- The task description or feature spec must be available (user prompt, feature-spec, or STATE.md)
- `state/STATE.md` is current so existing work is not duplicated
- `documentation/MULTI_AGENT_ROUTING.md` is accessible for agent-lane mapping

## Playbook

### 1. Parse the Task
Read the full task description. Identify the primary objective, acceptance criteria, and any constraints. If the task is vague, ask the user one clarifying question before proceeding.

### 2. Identify Components
Break the task into atomic sub-tasks. Each sub-task must be:
- Completable by a single specialist agent
- Independently testable or verifiable
- Small enough to finish in one session

List each sub-task with a short ID (e.g., `T1`, `T2`, ...).

### 3. Map Sub-Tasks to Agents
For each sub-task, assign the best-fit specialist agent using lane ownership:
- Lane A: `frontend-specialist`, `ui-ux-specialist`
- Lane B: `api-specialist`, `database-specialist`
- Lane C: `devops-specialist`, `security-specialist`
- Lane D: `documentation-specialist`, `solution-architect`, `product-manager`
- Cross-lane: `tech-lead`, `qa-specialist`

### 4. Build the Dependency Graph
Determine which sub-tasks depend on outputs from others. Mark:
- **Independent** — can run in parallel immediately
- **Dependent** — must wait for a named predecessor to complete
- **Blocking** — other tasks depend on this; prioritise it

### 5. Produce the Task Tree
Write the task tree to `state/task-tree.md` in this format:

```
# Task Tree: [Task Title]
Generated: [ISO timestamp]

## Sub-Tasks
| ID | Description | Agent | Depends On | Status |
|----|------------|-------|-----------|--------|
| T1 | ... | frontend-specialist | — | pending |
| T2 | ... | api-specialist | — | pending |
| T3 | ... | database-specialist | T2 | pending |
```

### 6. Update STATE.md
Add a reference to the new task tree under the current sprint or active work section in `state/STATE.md`.

## Output
- `state/task-tree.md` — the full dependency-aware task tree
- Updated `state/STATE.md` with a link to the task tree

## Review Checklist
- [ ] Every sub-task is atomic and assigned to exactly one agent
- [ ] Dependencies are correct — no circular references
- [ ] Independent tasks are marked for parallel execution
- [ ] Task tree file is valid markdown with all columns populated
- [ ] STATE.md references the new task tree
