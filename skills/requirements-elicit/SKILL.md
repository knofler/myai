---
name: requirements-elicit
description: "Elicit and document requirements. Gather functional and non-functional requirements, prioritize using MoSCoW, and output a structured requirements document. Triggers: requirements, elicit requirements, gather requirements, what do we need, business requirements"
---

# Requirements Elicitation Playbook

## 1. Identify Stakeholders

- List who cares about this feature/system (end users, admins, ops, business).
- Note each stakeholder's primary concern (usability, performance, cost, etc.).

## 2. Gather Functional Requirements

- Write each requirement as a user story:
  **As a [role], I want [capability] so that [benefit].**
- Add acceptance criteria for each story (Given/When/Then format).
- Group stories by feature area or epic.

## 3. Gather Non-Functional Requirements

- **Performance**: Response times, throughput, concurrent users.
- **Security**: Authentication method, authorization model, data encryption.
- **Scalability**: Expected growth, peak load scenarios.
- **Availability**: Uptime target (e.g., 99.9%), disaster recovery.
- **Compliance**: GDPR, HIPAA, or other regulatory needs.

## 4. Identify Constraints and Assumptions

- **Constraints**: Budget, timeline, team size, existing tech stack.
- **Assumptions**: Third-party service availability, user behavior patterns.
- Document each explicitly -- unstated assumptions cause scope creep.

## 5. Prioritize Using MoSCoW

| Priority | Meaning |
|----------|---------|
| **Must** | Launch blocker, non-negotiable |
| **Should** | Important but workaround exists |
| **Could** | Nice-to-have if time permits |
| **Won't** | Explicitly out of scope for this iteration |

## 6. Output Requirements Document

- Save to `AI/plan/` as a structured markdown file.
- Include: stakeholders, user stories, NFRs, constraints, MoSCoW table.
- Update `state/STATE.md` with the requirements summary.
- Log the session in `logs/claude_log.md`.

## 7. Review Checklist

- [ ] All stakeholders identified.
- [ ] Every functional requirement has acceptance criteria.
- [ ] Non-functional requirements are measurable (not vague).
- [ ] Constraints and assumptions documented.
- [ ] MoSCoW prioritization applied.
