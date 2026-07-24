---
name: adr-write
description: "Write Architecture Decision Records using a standard template. Triggers: ADR, architecture decision, decision record, technical decision document"
---

# Skill: Write Architecture Decision Record

Create a structured ADR capturing a technical decision, its context, and consequences.

## Playbook

### 1. Determine Next ADR Number

- Scan `AI/architecture/` for existing ADR files.
- Extract the highest sequential number (e.g., ADR-003).
- Increment by one for the new record (e.g., ADR-004).
- If no ADRs exist, start at ADR-001.

### 2. Gather Decision Context

- Ask or infer: What is the decision being made?
- Identify the problem or requirement driving the decision.
- List alternatives that were considered.
- Note any constraints (time, budget, team skills, existing tech).

### 3. Write the ADR

Use this template structure:

```markdown
# ADR-NNN: [Title]

**Status:** Proposed | Accepted | Deprecated | Superseded by ADR-NNN
**Date:** YYYY-MM-DD
**Deciders:** [who was involved]

## Context

[What is the issue? Why does this decision need to be made?]

## Decision

[What is the decision and why was it chosen?]

## Alternatives Considered

### [Alternative 1]
- Pros: ...
- Cons: ...

### [Alternative 2]
- Pros: ...
- Cons: ...

## Consequences

### Positive
- [benefit 1]

### Negative
- [tradeoff 1]

### Risks
- [risk 1]
```

### 4. Save the ADR

- Write to `AI/architecture/ADR-NNN-kebab-case-title.md`.
- Ensure the file name matches the title slug.

### 5. Update Cross-References

- Add an entry in `state/STATE.md` under recent decisions or architecture notes.
- If the ADR supersedes an existing one, update the old ADR status to "Superseded by ADR-NNN".
- Log action to `logs/claude_log.md`.
