---
name: dev-logging-setup
description: "Implement structured logging with JSON format, request correlation, log levels, and sensitive data redaction. Triggers: 'logging', 'log setup', 'structured logging', 'Winston', 'Pino', 'logger setup'."
---

# Logging Setup Playbook

## When to Use
- New project needs a logging strategy from the start
- Current logging uses raw `console.log` with no structure
- Need request tracing across microservices
- Production logs are unreadable or missing critical context

## Prerequisites
- Backend framework identified (Express, FastAPI, or standalone Node.js)
- Log destination decided: stdout (Docker/cloud), file, or external service
- Log retention and volume expectations understood

## Playbook

### 1. Choose Logging Library
- **Node.js**: Pino (preferred for performance) or Winston (preferred for flexibility)
- **Python**: structlog (preferred) or standard logging with JSON formatter
- Create `src/lib/logger.ts` as the single logger instance for the project
- Export a configured logger — all files import from this module, never use `console.log`

### 2. Configure JSON Output
- All log output in JSON format (one JSON object per line)
- Required fields on every log entry:
  - `timestamp` (ISO 8601)
  - `level` (error, warn, info, debug)
  - `message` (human-readable description)
  - `service` (application name from env)
  - `environment` (NODE_ENV value)
- Optional fields: `requestId`, `userId`, `duration`, `error`, `metadata`

### 3. Set Log Levels Per Environment
- **Production**: `info` and above (info, warn, error)
- **Staging**: `debug` and above (debug, info, warn, error)
- **Development**: `debug` and above with pretty-print formatting
- **Test**: `warn` and above (suppress noise in test output)
- Configure via `LOG_LEVEL` env var with fallback to environment defaults

### 4. Add Request ID Correlation
- Create middleware that generates or reads `X-Request-ID` header
- Attach request ID to every log entry within that request lifecycle
- Use AsyncLocalStorage (Node.js) or contextvars (Python) for propagation
- Pass request ID to downstream service calls for distributed tracing

### 5. Implement Sensitive Data Redaction
- Create a redaction list: `password`, `token`, `secret`, `authorization`, `cookie`, `ssn`, `creditCard`
- Apply redaction in the serializer — replace values with `[REDACTED]`
- Redact nested objects recursively
- Redact URL query parameters matching sensitive patterns
- Test redaction with sample payloads to confirm no leaks

### 6. Add Request/Response Logging
- Log incoming requests at `info` level: method, path, query params, user agent, requestId
- Log response at `info` level: statusCode, duration (ms), content-length
- Log request body at `debug` level only (with redaction applied)
- Skip logging for health check endpoints to reduce noise

### 7. Integrate Error Logging
- Catch errors in the global error handler and log at `error` level
- Include: error message, error code, stack trace, requestId, userId
- Log unhandled rejections and uncaught exceptions before exiting

## Output
- `src/lib/logger.ts` — configured logger singleton
- Request ID middleware
- Sensitive data redaction configuration
- Request/response logging middleware
- Updated `.env.example` with LOG_LEVEL variable

## Review Checklist
- [ ] All log output is valid JSON (one object per line)
- [ ] Log levels correctly configured per environment
- [ ] Request ID propagated through entire request lifecycle
- [ ] Sensitive data redacted in all log entries
- [ ] Health check endpoints excluded from request logging
- [ ] No `console.log` calls remain in the codebase
- [ ] Error logs include stack trace and correlation ID
