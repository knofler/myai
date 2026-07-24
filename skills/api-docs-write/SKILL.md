---
name: api-docs-write
description: "Write API endpoint documentation from source code. Triggers: API docs, endpoint documentation, document API, API reference"
---

# Skill: Write API Endpoint Documentation

Read route and controller source code and produce structured markdown API docs.

## Playbook

### 1. Discover API Routes

- Scan `src/routes/`, `src/api/`, `app/api/`, or equivalent directories.
- Identify the router/framework (Express, Fastify, Next.js API routes, etc.).
- Build a list of all endpoint files.

### 2. Read Route Definitions

- For each route file, extract: HTTP method, path, middleware chain.
- Identify authentication/authorization requirements from middleware.
- Note any rate limiting or validation middleware.

### 3. Read Controllers / Handlers

- For each handler, extract expected request parameters:
  - Path params, query params, request body schema.
- Identify response shapes and status codes from return statements.
- Note any error responses thrown or returned.

### 4. Document Each Endpoint

For every endpoint, write a section with:

```
### METHOD /path

**Auth:** Required | Public
**Params:** name (type) - description
**Query:** name (type, optional) - description
**Body:**
  - field (type, required) - description
**Responses:**
  - 200: Success — { shape }
  - 400: Validation error
  - 401: Unauthorized
  - 404: Not found
**Example:**
  curl -X METHOD /path -H "Authorization: Bearer <token>" -d '{}'
```

### 5. Organize by Resource

- Group endpoints by resource/domain (users, auth, projects, etc.).
- Add a table of contents at the top.

### 6. Save Output

- Write to `docs/API.md` or `documentation/API.md` (match existing convention).
- If no docs directory exists, create `docs/`.
- Log action to `logs/claude_log.md`.

### 7. Cross-Reference

- Link from README.md API Reference section if README exists.
- Update `state/STATE.md` to note documentation was generated.
