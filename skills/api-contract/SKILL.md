---
name: api-contract
description: "Define API contracts — endpoint specs with HTTP methods, paths, auth requirements, request/response schemas. Triggers: 'API contract', 'endpoint spec', 'define endpoints', 'API design', 'route planning'."
---

# API Contract Definition

Define API contracts before any implementation begins. Contracts are the single source of truth shared between backend and frontend teams.

## When to Use

- Starting a new feature that requires API endpoints
- Redesigning or versioning existing endpoints
- Coordinating frontend-backend work in parallel

## Playbook

### 1. Gather Requirements

- Read the feature spec or user story (check `AI/plan/` and any linked issue)
- Identify the resources/entities involved
- Determine CRUD operations needed
- Clarify auth requirements (public, authenticated, role-based)
- Note any pagination, filtering, or sorting needs

### 2. Define Each Endpoint

For every endpoint, specify:

| Field | Example |
|-------|---------|
| **Method** | `POST` |
| **Path** | `/api/v1/projects` |
| **Auth** | `Bearer JWT — role: admin` |
| **Request Body** | Zod/Pydantic schema reference |
| **Query Params** | `?page=1&limit=20&sort=createdAt` |
| **Success Response** | `201 { id, name, createdAt }` |
| **Error Responses** | `400 validation`, `401 unauth`, `409 duplicate` |

### 3. Output Contract Format

Write the contract as a markdown table or OpenAPI-compatible YAML block in `AI/plan/api-contracts/`. One file per feature or domain:

```
AI/plan/api-contracts/<feature-name>.md
```

Include:
- Base path and API version
- Authentication requirements per endpoint
- Request/response schemas with field types and required markers
- Pagination envelope format: `{ data: [], meta: { page, limit, total } }`
- Standard error envelope: `{ error: { code, message, details? } }`

### 4. Validate with Stakeholders

- Tag `frontend-specialist` to confirm request/response shapes work for the UI
- Tag `database-specialist` if schema changes are implied
- Tag `security-specialist` for any public or elevated-permission endpoints

### 5. Finalize and Handoff

- Commit the contract file
- Reference it in `state/STATE.md` under current sprint work
- Implementation can now proceed via the `endpoint-implementation` skill

## Output Artifacts

- `AI/plan/api-contracts/<feature>.md` — the contract document
- Updated `state/STATE.md` — reference to the new contract
