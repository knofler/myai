---
name: code-review
description: "Perform code review. Check changed files against project standards, verify error handling, security, test coverage, and documentation. Output approve or request-changes. Triggers: code review, review code, PR review, review changes, review my code"
---

# Code Review Playbook

## 1. Identify Changes

- Run `git diff` or `git diff --staged` to see changed files.
- If reviewing a PR, use `gh pr diff` to get the full diff.
- List all modified, added, and deleted files.

## 2. Check Project Standards

- Read `documentation/AI_RULES.md` for mandatory conventions.
- Verify TypeScript strict mode is enabled (if applicable).
- Check file and folder naming conventions.
- Verify import ordering and module boundaries.

## 3. Review Logic and Correctness

- Read each changed file for logical errors.
- Verify edge cases are handled (null, empty, overflow).
- Check that business logic matches requirements.
- Look for off-by-one errors, race conditions, and memory leaks.

## 4. Verify Error Handling

- Ensure all async operations have try/catch or .catch().
- Check that errors are logged with sufficient context.
- Verify user-facing errors return appropriate HTTP status codes and messages.

## 5. Check Security

- No secrets or credentials in code.
- Input validation on all user-supplied data.
- SQL/NoSQL injection prevention.
- XSS prevention in rendered output.
- Auth checks on protected routes.

## 6. Verify Test Coverage

- Every new function or endpoint should have a corresponding test.
- Check that tests cover both happy path and error cases.
- Verify no tests were deleted without replacement.

## 7. Check Documentation

- Public APIs have JSDoc or docstrings.
- README or CHANGELOG updated if user-facing behavior changed.
- Inline comments explain non-obvious logic.

## 8. Output Review

- For each issue found, provide: file, line, severity, description, suggestion.
- End with a verdict: **Approve**, **Approve with nits**, or **Request Changes**.
- Log the review in `logs/claude_log.md`.

## 9. Review Checklist

- [ ] Standards compliance verified.
- [ ] Error handling present and correct.
- [ ] No security vulnerabilities introduced.
- [ ] Test coverage adequate.
- [ ] Documentation updated.
