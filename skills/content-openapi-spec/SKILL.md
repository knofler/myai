---
name: content-openapi-spec
description: "Author OpenAPI 3.0 spec with paths, operations, schemas, security, and examples. Triggers: OpenAPI spec, API specification, OpenAPI author, REST spec, API design document"
---
# OpenAPI Spec Authoring Playbook

## When to Use
- Designing a new API before implementation (design-first approach)
- Documenting an existing API for consumers
- Generating client SDKs or server stubs from a spec
- Establishing an API contract between frontend and backend teams

## Prerequisites
- API requirements or existing route definitions
- Authentication method decided (JWT, API key, OAuth2)
- Data models defined or available from Mongoose schemas
- Understanding of consumer needs (what clients will call)

## Playbook

### 1. Define API Info and Servers
- Set `openapi: "3.0.3"` version
- Write `info` block: title, description, version, contact
- Define `servers` for each environment (local, staging, production)
- Add `externalDocs` link if supplementary docs exist

### 2. Design Paths and Operations
- List all endpoints grouped by resource (e.g., /users, /orders)
- For each endpoint, define HTTP methods (GET, POST, PUT, PATCH, DELETE)
- Write `summary` (short) and `description` (detailed) for each operation
- Assign `operationId` following camelCase convention (e.g., `getUserById`)
- Add `tags` for grouping in generated documentation

### 3. Define Request and Response Schemas
- Create reusable schemas under `components/schemas`
- Define request bodies with `content: application/json`
- Specify required fields and validation constraints (minLength, pattern, enum)
- Define response schemas for each status code (200, 201, 400, 401, 404, 500)
- Use `$ref` for shared schemas to avoid duplication

### 4. Add Parameters
- Define path parameters (e.g., `{id}`) with type and format
- Add query parameters for filtering, sorting, pagination
- Include header parameters for custom headers (X-Request-ID)
- Mark required vs optional parameters

### 5. Configure Security
- Define security schemes under `components/securitySchemes`
- Support: `bearerAuth` (JWT), `apiKey`, `oauth2`
- Apply security globally or per-operation
- Document which endpoints are public (override with empty security array)

### 6. Add Examples
- Include `example` values for all request bodies
- Add response examples for success and error cases
- Use `examples` (plural) for multiple scenarios per endpoint
- Ensure examples pass schema validation

### 7. Validate and Export
- Validate spec with `swagger-cli validate openapi.yaml`
- Test with Swagger UI or Redoc for rendering
- Generate TypeScript types from spec if using design-first
- Store spec in repository root as `openapi.yaml`

## Output
- `openapi.yaml` or `openapi.json` specification file
- Rendered documentation (Swagger UI or Redoc)
- Generated TypeScript interfaces (optional)
- API changelog noting spec version changes

## Review Checklist
- [ ] All endpoints documented with correct HTTP methods
- [ ] Request and response schemas match implementation
- [ ] Required fields and validation constraints specified
- [ ] Security schemes applied to all protected endpoints
- [ ] Examples provided for every request and response
- [ ] Spec validates without errors
- [ ] Pagination, filtering, and sorting parameters documented
