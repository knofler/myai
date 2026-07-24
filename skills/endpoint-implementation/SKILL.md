---
name: endpoint-implementation
description: "Implement an API endpoint end-to-end — route, controller, service, validation, tests. Triggers: 'implement endpoint', 'create API route', 'build endpoint', 'add route', 'new API endpoint'."
---

# Endpoint Implementation

Implement a single API endpoint from contract to working, tested code. Follows a layered architecture: route -> controller -> service -> model.

## When to Use

- An API contract exists and is ready for implementation
- Adding a new endpoint to an existing API
- Refactoring an endpoint to match an updated contract

## Prerequisites

- API contract defined (see `api-contract` skill)
- Database schema in place if the endpoint touches persistence

## Playbook

### 1. Read the API Contract

- Locate the contract in `AI/plan/api-contracts/`
- Confirm method, path, auth, request/response schemas
- Note any dependencies on other endpoints or services

### 2. Create the Route File

**Express (Node.js):**
```
src/routes/<resource>.routes.js
```
- Define the route with method, path, middleware chain, and controller reference
- Apply auth middleware if the contract requires it

**FastAPI (Python):**
```
app/routers/<resource>.py
```
- Define the router with path prefix and tags

### 3. Create the Controller

```
src/controllers/<resource>.controller.js   # Express
app/controllers/<resource>.py              # FastAPI
```
- Parse and destructure validated request data
- Call the service layer
- Return the correct HTTP status and response envelope
- Handle errors with try/catch, delegate to error middleware

### 4. Create the Service

```
src/services/<resource>.service.js   # Express
app/services/<resource>.py           # FastAPI
```
- Contain all business logic — no HTTP concerns
- Interact with the database via model/repository
- Throw typed errors (NotFoundError, ConflictError, etc.)

### 5. Add Validation Schema

**Node.js (Zod):**
```
src/validators/<resource>.validator.js
```
- Define `createSchema`, `updateSchema`, `querySchema` as needed
- Wire into route via validation middleware

**Python (Pydantic):**
```
app/schemas/<resource>.py
```
- Define request/response models — FastAPI validates automatically

### 6. Add Tests

```
tests/unit/services/<resource>.service.test.js
tests/integration/routes/<resource>.routes.test.js
```
- Unit test the service layer with mocked dependencies
- Integration test the route with supertest (Express) or httpx (FastAPI)
- Cover: success path, validation errors, auth errors, not-found, conflict

### 7. Register the Route

- Import and mount the route in the app entry point
- Verify with a manual curl or REST client call
- Confirm the endpoint appears in Swagger if `swagger-openapi` skill is active

## Checklist Before Done

- [ ] Route registered and reachable
- [ ] Validation rejects bad input with 400
- [ ] Auth middleware blocks unauthenticated requests (if required)
- [ ] Service logic covered by unit tests
- [ ] Integration test passes
- [ ] Response matches the API contract schema exactly
