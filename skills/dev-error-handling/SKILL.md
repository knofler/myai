---
name: dev-error-handling
description: "Implement a comprehensive error handling strategy with custom classes, middleware, and client-side boundaries. Triggers: 'error handling', 'error strategy', 'custom errors', 'error middleware', 'error boundary'."
---

# Error Handling Strategy Playbook

## When to Use
- Setting up a new project that needs structured error handling
- Current error handling is inconsistent (mix of throw strings, unhandled rejections)
- API responses return inconsistent error formats
- Frontend lacks error boundaries and crashes on unexpected errors

## Prerequisites
- Backend framework identified (Express or FastAPI)
- Frontend framework identified (Next.js/React) if client-side boundaries needed
- Logging setup in place or planned (see `dev-logging-setup` skill)

## Playbook

### 1. Define Custom Error Classes
- Create `src/errors/AppError.ts` as the base class:
  - Properties: `statusCode`, `message`, `code` (machine-readable), `isOperational`, `details?`
  - Extends native `Error` with proper prototype chain
- Create specific subclasses:
  - `ValidationError` (400) — invalid input with field-level details
  - `AuthenticationError` (401) — missing or invalid credentials
  - `ForbiddenError` (403) — valid credentials but insufficient permissions
  - `NotFoundError` (404) — resource does not exist
  - `ConflictError` (409) — duplicate resource or state conflict
  - `RateLimitError` (429) — too many requests
  - `InternalError` (500) — unexpected server error

### 2. Create Error Response Envelope
- Standardize all error responses to:
  ```
  { error: { code: "VALIDATION_ERROR", message: "...", details?: [...], requestId?: "..." } }
  ```
- Include `requestId` from request correlation ID for tracing
- In development: include `stack` trace. In production: omit stack

### 3. Implement Error Middleware (Backend)
- Global Express error handler as the last middleware:
  - Catch `AppError` subclasses — use their statusCode and code
  - Catch Mongoose `ValidationError` — map to 400 with field details
  - Catch Mongoose `CastError` — map to 400 "invalid ID format"
  - Catch JWT errors — map to 401
  - Catch everything else — log full error, return generic 500
- Wrap async route handlers with `asyncHandler` to catch promise rejections

### 4. Handle Unhandled Errors
- Register `process.on('unhandledRejection')` — log and exit gracefully
- Register `process.on('uncaughtException')` — log and exit immediately
- In both cases: log the error with full context, close DB connections, exit with code 1

### 5. Implement Client-Side Error Boundaries (Frontend)
- Create `ErrorBoundary` component wrapping route segments
- Create `error.tsx` for Next.js App Router error handling per route
- Implement retry logic for transient errors (network, 503)
- Show user-friendly error messages — never expose stack traces
- Report client errors to backend via `POST /api/v1/errors`

### 6. Add Logging Integration
- Log all 5xx errors at `error` level with full stack trace
- Log all 4xx errors at `warn` level without stack trace
- Include: timestamp, requestId, userId (if authenticated), error code, path

## Output
- `src/errors/` — custom error class hierarchy
- Error middleware registered in the Express/FastAPI app
- `asyncHandler` utility for route wrapping
- `ErrorBoundary` component (frontend)
- Unhandled rejection/exception handlers
- Error logging integrated with the project logger

## Review Checklist
- [ ] All custom error classes extend AppError with correct status codes
- [ ] Error response envelope is consistent across all endpoints
- [ ] Async route handlers wrapped to catch rejections
- [ ] Unhandled rejection and uncaught exception handlers registered
- [ ] Client-side error boundaries prevent full-page crashes
- [ ] Stack traces hidden in production responses
- [ ] All errors logged with correlation ID
