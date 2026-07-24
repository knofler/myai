---
name: requirements-traceability
description: "Create a requirements traceability matrix. Map requirements to implementation files and test cases. Identify gaps in coverage. Triggers: traceability, requirements trace, RTM, requirement coverage, trace requirements"
---

# Requirements Traceability Playbook

## 1. Gather Requirements

- Collect all requirements from `AI/plan/` and any user stories in state/STATE.md.
- Assign each requirement a unique ID (e.g., REQ-001, REQ-002).
- Include both functional and non-functional requirements.

## 2. Map to Implementation

- For each requirement, identify the source files that implement it.
- Use grep/glob to find relevant code by feature keywords.
- Note requirements with no implementation files (unimplemented).

## 3. Map to Test Cases

- For each requirement, identify test files that verify it.
- Check for unit tests, integration tests, and E2E tests.
- Note requirements with no test coverage (untested).

## 4. Build the Traceability Matrix

Output as a markdown table:

```markdown
| Req ID  | Description          | Status       | Impl Files        | Test Files        |
|---------|----------------------|--------------|-------------------|-------------------|
| REQ-001 | User can log in      | Implemented  | src/auth/login.ts  | tests/auth.test.ts |
| REQ-002 | Password reset email | Partial      | src/auth/reset.ts  | —                 |
| REQ-003 | Rate limiting        | Not started  | —                 | —                 |
```

## 5. Identify Coverage Gaps

- **Unimplemented**: Requirements with no implementation files.
- **Untested**: Requirements with implementation but no tests.
- **Orphan code**: Implementation files not linked to any requirement.
- Summarize gap counts at the bottom of the matrix.

## 6. Output and Update

- Save the RTM to `AI/plan/`.
- Update `state/STATE.md` with coverage summary (e.g., "12/15 requirements implemented, 9/15 tested").
- Log the session in `logs/claude_log.md`.

## 7. Review Checklist

- [ ] All known requirements have an ID.
- [ ] Implementation mapping verified by file existence.
- [ ] Test mapping verified by file existence.
- [ ] Gaps are clearly flagged.
- [ ] state/STATE.md updated with coverage metrics.
