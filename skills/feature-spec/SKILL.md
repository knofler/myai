---
name: feature-spec
description: "Write a feature specification with goal, user problem, acceptance criteria, scope, dependencies, and complexity estimate. Triggers: feature spec, feature specification, feature definition, product spec, spec out"
---

# Feature Specification

Write a structured feature specification document.

## Playbook

### 1. Define Feature Name and Goal

- Ask for or infer the feature name.
- Write a one-sentence goal statement: "Enable [who] to [what] so that [why]."

### 2. Describe the User Problem

- Explain the current pain point or gap.
- Include who is affected and how frequently.
- Reference any existing user feedback or data if available.

### 3. List Acceptance Criteria

- Write each criterion as a testable statement.
- Use the format: "Given [context], when [action], then [outcome]."
- Cover the happy path and key error paths.

### 4. Define Scope

- **In scope**: list what this feature covers.
- **Out of scope**: list what is explicitly excluded.
- Note anything deferred to a future iteration.

### 5. Identify Dependencies

- List upstream services, APIs, or data sources required.
- List downstream consumers affected by this feature.
- Flag any pending decisions that block implementation.

### 6. Estimate Complexity

- Rate as **S** (< 1 day), **M** (1-3 days), or **L** (3+ days).
- Justify the rating briefly.
- Call out any unknowns that could change the estimate.

### 7. Output

Produce a single markdown document with these sections:

```
## Feature: [Name]
### Goal
### User Problem
### Acceptance Criteria
### Scope (In / Out)
### Dependencies
### Complexity: [S/M/L]
### Open Questions
```

Save or present the spec to the user for review.
