---
name: coherence-review
description: "Review cross-specialist coherence. Verify API contracts, database schemas, auth middleware, and CI/CD alignment across all services. Triggers: coherence, integration review, cross-team review, consistency check, alignment review"
---

# Coherence Review Playbook

## 1. Gather Current State

- Read `state/STATE.md` for active features and their status.
- Identify all services/modules under review.
- List the specialists who contributed (frontend, API, DB, security, DevOps).

## 2. Verify API Contracts

- Compare frontend API calls against backend route definitions.
- Check request/response shapes match on both sides.
- Verify error codes and error response formats are consistent.
- Flag any endpoint the frontend calls that the backend does not expose.

## 3. Verify Database Schema Alignment

- Compare Mongoose/Prisma schemas against service query patterns.
- Check that indexes support the queries being executed.
- Verify migration files are up to date with schema definitions.

## 4. Check Auth Middleware Alignment

- Verify auth middleware is applied to all protected routes.
- Confirm token format and claims match between auth service and consumers.
- Check RBAC roles in middleware match the roles defined in security spec.

## 5. Verify CI/CD Coverage

- Confirm every deployable service has a CI pipeline.
- Check that test, lint, build, and deploy stages exist.
- Verify environment variables are documented and present in CI config.

## 6. Identify Integration Gaps

- List any mismatches found in steps 2-5.
- Categorize each gap: **breaking** (will fail at runtime) vs **drift** (works but inconsistent).
- Prioritize breaking gaps first.

## 7. Create Fix Tasks

- For each gap, create a concrete fix task with:
  - What to change, in which file, by which specialist.
- Update `state/STATE.md` with the gap summary and fix tasks.
- Log findings in `logs/claude_log.md`.

## 8. Review Checklist

- [ ] API contracts verified (frontend vs backend).
- [ ] DB schema matches service queries.
- [ ] Auth middleware covers all protected routes.
- [ ] CI/CD pipelines exist for all services.
- [ ] All gaps documented with fix tasks.
