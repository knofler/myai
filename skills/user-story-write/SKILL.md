---
name: user-story-write
description: "Write user stories with acceptance criteria, edge cases, story points, and epic/theme tags using standard format. Triggers: user story, story, as a user, user requirement, acceptance criteria"
---

# User Story Writer

Write well-formed user stories with acceptance criteria.

## Playbook

### 1. Gather Context

- Identify the target user role (e.g., admin, customer, API consumer).
- Identify the feature or epic this story belongs to.
- Check state/STATE.md for any related in-progress work.

### 2. Write the Story

Use the canonical format:

> **As a** [role], **I want** [goal], **so that** [benefit].

- Keep the goal specific and actionable.
- Keep the benefit tied to a real user outcome, not implementation detail.

### 3. Add Acceptance Criteria

Write each criterion as a checkbox:

- [ ] Given [context], when [action], then [outcome].
- [ ] Given [context], when [action], then [outcome].

Cover at minimum:
- Happy path
- Validation / error handling
- Edge cases (empty state, max limits, concurrent access)

### 4. Define Edge Cases

- List boundary conditions explicitly.
- Note what happens on failure or timeout.
- Identify any race conditions or ordering concerns.

### 5. Estimate Story Points

- Use the Fibonacci scale: 1, 2, 3, 5, 8, 13.
- 1-2 = trivial, 3-5 = moderate, 8-13 = complex or uncertain.
- Note any unknowns that inflate the estimate.

### 6. Tag with Epic / Theme

- Assign an epic label (e.g., `epic:onboarding`).
- Assign a theme label if applicable (e.g., `theme:performance`).

### 7. Output

Produce the story in this template:

```
## Story: [Title]
**Epic:** [epic]  |  **Points:** [n]

As a [role], I want [goal], so that [benefit].

### Acceptance Criteria
- [ ] ...

### Edge Cases
- ...

### Notes
- ...
```

Present to the user for review.
