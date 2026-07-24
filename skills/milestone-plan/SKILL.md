---
name: milestone-plan
description: "Create a project milestone plan with deliverables, dependencies, agent assignments, acceptance criteria, and state/STATE.md tracking. Triggers: milestone, project plan, roadmap, timeline, delivery plan"
---

# Milestone Plan

Create a structured milestone plan for the project.

## Playbook

### 1. Define Milestones

- Break the project into 3-6 milestones.
- Each milestone must have a clear, shippable outcome.
- Name each milestone descriptively (e.g., "v0.1 — Auth & Onboarding").

### 2. List Deliverables per Milestone

- For each milestone, list every deliverable.
- Deliverables should be concrete: "API endpoint for X", not "backend work".
- Estimate effort for each deliverable: S (< 1 day), M (1-3 days), L (3+ days).

### 3. Map Dependencies

- Identify which milestones depend on others.
- Within each milestone, identify deliverable-level dependencies.
- Draw the critical path: the longest chain of dependent items.

### 4. Assign Specialist Agents

Map each deliverable to the responsible agent:

| Deliverable | Agent |
|-------------|-------|
| API endpoint for auth | `api-specialist` |
| Login UI | `frontend-specialist` |
| DB schema | `database-specialist` |

Use agents from `.claude/agents/` for Claude, `agents/` for others.

### 5. Set Acceptance Criteria

- Each milestone needs pass/fail acceptance criteria.
- Criteria should be testable: "All auth endpoints return 200 on valid input."
- Include both functional and non-functional criteria.

### 6. Track in state/STATE.md

- Add each milestone to state/STATE.md under a `## Milestones` section.
- Mark status: Not Started / In Progress / Complete.
- Update as milestones progress.

### 7. Output

Produce the milestone plan:

```
## Milestone Plan: [Project Name]

### Milestone 1: [Name]
- **Target:** [date or sprint]
- **Deliverables:**
  - [ ] [item] — [agent] — [S/M/L]
- **Dependencies:** [list]
- **Acceptance Criteria:**
  - ...

### Milestone 2: [Name]
...

### Critical Path
[milestone] -> [milestone] -> [milestone]
```

Save to `plan/` and update state/STATE.md.
