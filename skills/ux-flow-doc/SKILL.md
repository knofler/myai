---
name: ux-flow-doc
description: "Document UX user flows. Identify user goals, map steps and decision points, note error states, and create text-based flow diagrams. Triggers: user flow, UX flow, flow diagram, user journey, task flow"
---

# UX Flow Documentation Playbook

## 1. Identify User Goal

- State the user's goal in one sentence (e.g., "User completes checkout").
- Identify the user persona/role performing the flow.
- Note the entry point (how the user arrives at this flow).

## 2. List Flow Steps

- Number each step sequentially.
- For each step, describe:
  - What the user sees (page/component).
  - What the user does (action).
  - What the system does (response).
- Keep steps atomic -- one action per step.

## 3. Document Decision Points

- Identify where the flow branches (e.g., "Is user logged in?").
- Map each branch to its outcome.
- Note which branch is the "happy path."

## 4. Note Error States and Recovery

- For each step, list what can go wrong (validation error, network failure, auth expired).
- Document the error message shown to the user.
- Describe the recovery path (retry, redirect, support contact).

## 5. Create Text-Based Flow Diagram

Use Mermaid or ASCII format:

```
Start -> [Page: Login]
  -> Enter credentials -> [Validate]
    -> Valid? -> Yes -> [Page: Dashboard]
    -> Valid? -> No  -> [Show Error] -> [Page: Login]
```

## 6. Identify UX Improvements

- Flag steps with high friction (too many clicks, confusing labels).
- Suggest simplifications (combine steps, add defaults, reduce input).
- Note accessibility concerns in the flow.

## 7. Save and Update

- Save the flow document to `AI/design/`.
- Update `state/STATE.md` with the new flow reference.
- Log the session in `logs/claude_log.md`.

## 8. Review Checklist

- [ ] User goal clearly stated.
- [ ] All steps are atomic and numbered.
- [ ] Decision points have all branches mapped.
- [ ] Error states documented with recovery paths.
- [ ] Flow diagram is readable and accurate.
- [ ] UX improvement opportunities noted.
