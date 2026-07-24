---
name: mvp-definition
description: "Define MVP scope using MoSCoW prioritization. Identify Must-haves, technical prerequisites, and create a launch milestone with timeline. Triggers: MVP, minimum viable, first release, initial scope, launch scope"
---

# MVP Definition

Define the minimum viable product scope for a project or feature set.

## Playbook

### 1. List All Potential Features

- Brainstorm or gather every feature idea from the user.
- Include both user-facing and technical/infrastructure items.
- Do not filter yet — capture everything.

### 2. Apply MoSCoW Prioritization

Categorize every item:

| Priority | Meaning |
|----------|---------|
| **Must** | Launch blocker — product is broken without it |
| **Should** | High value but launch can proceed without it |
| **Could** | Nice-to-have, low effort |
| **Won't** | Explicitly deferred — not in this release |

For each item, justify the category in one sentence.

### 3. Define MVP Feature Set

- MVP = **Must-haves only**.
- Verify each Must-have is truly required for first usable release.
- Challenge any Must-have that looks like a Should — keep scope minimal.

### 4. Identify Technical Prerequisites

- List infrastructure needed before feature work begins.
- Include: repo setup, CI/CD, auth, database schema, deployment target.
- Flag any prerequisites that are not yet in place.

### 5. Create MVP Milestone

- Name the milestone (e.g., `v0.1 — MVP`).
- List all Must-have items as deliverables.
- Estimate a timeline: days or sprints to completion.
- Identify the critical path — the longest dependency chain.

### 6. Output

Produce a structured document:

```
## MVP Definition: [Project Name]

### All Features (MoSCoW)
| Feature | Priority | Justification |
|---------|----------|---------------|

### MVP Scope (Must-haves)
- ...

### Technical Prerequisites
- ...

### Milestone: [Name]
- Target date: [date]
- Critical path: [items]
- Deliverables: [list]
```

Save to `plan/` or present to the user for review.
