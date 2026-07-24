---
name: analysis-api-contract-diff
description: "Compare API implementation against documented contracts in AI/plan/api-contracts/. Flag drift between spec and code including missing endpoints, changed schemas, and undocumented routes. Triggers: api drift, contract diff, api mismatch, spec vs code, api contract check"
---

# API Contract Diff Playbook

## When to Use

- After implementing new endpoints to verify they match the contract
- Before a release to catch undocumented API changes
- When frontend reports unexpected API behavior
- During coherence review across API and frontend specialists

## Prerequisites

- API contracts documented in `AI/plan/api-contracts/` or equivalent
- API source code accessible (Express/FastAPI routes)
- Understanding of the project's API structure

## Playbook

### 1. Load Documented Contracts

Read all contract files from `AI/plan/api-contracts/`. For each endpoint, extract:
- HTTP method and path
- Request body schema (fields, types, required)
- Response schema (fields, types, status codes)
- Authentication requirements
- Query parameters and path parameters

### 2. Scan Implemented Routes

Walk through the API source code and extract every registered route:
- Route definitions (`router.get()`, `router.post()`, etc.)
- Controller/handler functions
- Validation schemas (Zod, Joi, etc.)
- Response shapes from the handler return values
- Middleware applied (auth, rate limit)

### 3. Match Routes to Contracts

For each documented endpoint, find the matching implementation. For each implemented route, find the matching contract. Categorize:
- **Matched**: both contract and implementation exist
- **Missing implementation**: contract exists but no code
- **Undocumented**: code exists but no contract
- **Method mismatch**: same path but different HTTP method

### 4. Compare Schemas Field-by-Field

For each matched pair, compare:
- **Request body**: missing fields, extra fields, type mismatches, required vs optional drift
- **Response body**: missing fields, extra fields, type changes, nested object differences
- **Status codes**: undocumented error codes, missing success codes
- **Query params**: added/removed/renamed parameters

### 5. Check Auth and Middleware Alignment

Verify that:
- Endpoints documented as "authenticated" have auth middleware
- Rate limiting matches the contract specification
- CORS and content-type expectations align

### 6. Produce Drift Report

| Endpoint | Contract | Implementation | Drift Type | Details |
|----------|----------|---------------|------------|---------|
| GET /api/users | Defined | Implemented | Field added | `avatarUrl` in response, not in contract |
| POST /api/tasks | Defined | Missing | No implementation | Endpoint not coded yet |
| DELETE /api/cache | Not defined | Implemented | Undocumented | Route exists without contract |

### 7. Recommend Actions

For each drift item:
- **Update contract**: if the implementation is correct and intentional
- **Fix implementation**: if the contract is the source of truth
- **Remove route**: if undocumented and unintended
- **Add contract**: if the route is intentional but undocumented

## Output

- Drift report table with all mismatches
- Per-endpoint schema comparison
- List of undocumented routes
- List of unimplemented contracts
- Recommended action for each drift item

## Review Checklist

- [ ] All contract files loaded and parsed
- [ ] All implemented routes discovered (including nested routers)
- [ ] Every route matched or flagged as missing/undocumented
- [ ] Schema comparison done field-by-field with type checking
- [ ] Auth/middleware alignment verified
- [ ] Each drift item has a recommended action
