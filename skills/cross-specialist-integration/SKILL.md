---
name: cross-specialist-integration
description: "Coordinate cross-specialist integration. Verify contracts between API, frontend, database, and auth layers. Run integration tests and create fix tasks for breaking changes. Triggers: integration, cross-team, connect services, wire up, end-to-end integration"
---

# Cross-Specialist Integration Playbook

## 1. Identify Integration Points

- **API <-> Frontend**: Route definitions vs fetch calls.
- **DB <-> API**: Schema definitions vs query/mutation code.
- **Auth <-> All**: Middleware, token validation, role checks.
- **DevOps <-> All**: Environment variables, build scripts, deploy targets.

## 2. Collect Contracts

- List all API endpoints with method, path, request body, response shape.
- List all database collections/tables with field names and types.
- List all environment variables each service expects.

## 3. Verify Contract Alignment

- For each API endpoint, confirm the frontend calls it with the correct shape.
- For each DB query, confirm the schema supports the fields being accessed.
- For each protected route, confirm auth middleware is applied.
- For each env var, confirm it exists in `.env.example` and CI config.

## 4. Run Integration Tests

- Execute existing integration/E2E tests if available.
- Note any tests that fail due to contract mismatches.
- If no integration tests exist, flag this as a gap.

## 5. Identify Breaking Changes

- List any recent changes that altered a contract (renamed field, changed type).
- Check if consumers of that contract were updated.
- Flag unupdated consumers as breaking.

## 6. Create Fix Tasks

- For each misalignment or break:
  - Describe what is wrong and where.
  - Specify which specialist should fix it.
  - Estimate effort (S/M/L).

## 7. Update State

- Update `state/STATE.md` with integration status and fix tasks.
- Log findings in `logs/claude_log.md`.

## 8. Review Checklist

- [ ] All integration points identified.
- [ ] Contracts documented and compared.
- [ ] Breaking changes flagged with affected consumers.
- [ ] Fix tasks created with owner and effort.
- [ ] state/STATE.md updated.
