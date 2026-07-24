---
name: gap-analysis
description: "Perform gap analysis between current and target state. Identify feature, technical, and process gaps, then create prioritized action items. Triggers: gap analysis, what's missing, current vs target, gap, missing features"
---

# Gap Analysis Playbook

## 1. Document Current State

- Read `state/STATE.md` for the latest project status.
- Scan the codebase for implemented features, services, and infrastructure.
- Note what is working, partially done, and known-broken.

## 2. Define Target State

- Source the target from requirements docs in `AI/plan/`, user input, or roadmap.
- List every expected capability, integration, and quality attribute.
- Be specific: "User can reset password via email" not "auth works."

## 3. Identify Gaps

- Compare current state against target state line by line.
- For each target item, mark: **Done**, **Partial**, or **Missing**.
- Capture gaps that are not in the target but should be (emergent gaps).

## 4. Categorize Gaps

| Category | Examples |
|----------|---------|
| **Feature** | Missing user stories, incomplete flows |
| **Technical** | Missing services, unbuilt APIs, no database migration |
| **Process** | No CI/CD, no code review workflow, no monitoring |
| **Quality** | Missing tests, no accessibility audit, no security review |

## 5. Prioritize by Impact

- **Critical**: Blocks launch or core user journey.
- **High**: Degrades experience or creates risk.
- **Medium**: Affects efficiency or DX.
- **Low**: Polish or optimization.

## 6. Create Action Items

- For each gap, write a concrete task:
  - What needs to be done, which files/services, estimated effort.
- Group related tasks into workstreams.

## 7. Output and Update

- Save the gap analysis to `AI/plan/`.
- Update `state/STATE.md` with gap summary and action items.
- Log the session in `logs/claude_log.md`.

## 8. Review Checklist

- [ ] Current state sourced from code, not assumptions.
- [ ] Target state is specific and measurable.
- [ ] Every gap has a category and priority.
- [ ] Action items are concrete and assignable.
