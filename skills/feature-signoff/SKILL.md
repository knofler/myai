---
name: feature-signoff
description: "Sign off on feature completion. Verify acceptance criteria, tests, documentation, CI/CD, and security review before marking a feature as ready to ship. Triggers: signoff, sign off, feature complete, done review, ready to ship, release approval"
---

# Feature Signoff Playbook

## 1. Identify the Feature

- Confirm which feature is being signed off.
- Locate its requirements (user stories, acceptance criteria) in `AI/plan/`.
- Read `state/STATE.md` for current feature status.

## 2. Verify Acceptance Criteria

- Go through each acceptance criterion one by one.
- For each criterion, confirm it is met by reading the relevant code.
- Mark each as: **Pass**, **Fail**, or **Partial**.
- Any Fail = signoff blocked.

## 3. Verify Tests Pass

- Run the test suite (`npm test`, `pytest`, or equivalent).
- Confirm all tests pass with zero failures.
- Check that new tests were added for the feature.
- Verify both happy path and error case coverage.

## 4. Verify Documentation

- README or user-facing docs updated if behavior changed.
- API documentation updated for new/changed endpoints.
- Inline code comments present for non-obvious logic.
- CHANGELOG entry added.

## 5. Verify No Regressions

- Run the full test suite, not just feature-specific tests.
- Check for newly failing tests unrelated to the feature.
- Review recent bug reports for related regressions.

## 6. Verify CI/CD Passes

- Confirm the latest CI run is green (lint, test, build, deploy).
- Check that the feature branch has no merge conflicts with main.

## 7. Verify Security Review

- Confirm no secrets in code.
- Input validation present on new endpoints.
- Auth checks applied to new protected routes.
- No new vulnerabilities introduced (check `npm audit` or equivalent).

## 8. Signoff Decision

- **Approved**: All checks pass. Mark feature complete in `state/STATE.md`.
- **Blocked**: List failing checks with remediation steps.
- Log the signoff decision in `logs/claude_log.md`.

## 9. Review Checklist

- [ ] All acceptance criteria pass.
- [ ] All tests pass.
- [ ] Documentation updated.
- [ ] No regressions.
- [ ] CI/CD green.
- [ ] Security review complete.
