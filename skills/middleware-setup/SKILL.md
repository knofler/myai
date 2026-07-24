---
name: middleware-setup
description: "Set up Express or FastAPI middleware — auth, validation, rate limiting, error handling, logging. Triggers: 'middleware', 'add middleware', 'error handler', 'rate limit', 'request logging', 'auth middleware'."
---

# Middleware Setup

Create and wire middleware into the API application. Middleware handles cross-cutting concerns that should not live in individual route handlers.

## When to Use

- Adding authentication/authorization checks
- Setting up request validation
- Implementing rate limiting
- Creating a centralized error handler
- Adding request/response logging
- Setting security headers (CORS, Helmet)

## Playbook

### 1. Identify Middleware Type

| Type | Purpose | Priority |
|------|---------|----------|
| **Security headers** | CORS, Helmet, content-type enforcement | High — add first |
| **Request logging** | Log method, path, status, duration | High |
| **Auth** | Verify JWT, attach user to request | High |
| **Validation** | Validate body/query/params against schema | Medium |
| **Rate limiting** | Throttle requests per IP or user | Medium |
| **Error handler** | Catch all errors, return standard envelope | High — register last |

### 2. Create the Middleware File

**Express:**
```
src/middleware/<name>.middleware.js
```

Standard signature:
```js
// Regular middleware
const myMiddleware = (req, res, next) => { /* ... */ next(); };

// Error middleware (4 params)
const errorHandler = (err, req, res, next) => { /* ... */ };
```

**FastAPI:**
```
app/middleware/<name>.py
```

Use `@app.middleware("http")` or a custom class inheriting from `BaseHTTPMiddleware`.

### 3. Implementation Details by Type

**Auth middleware:**
- Extract token from `Authorization: Bearer <token>` header
- Verify JWT using the project secret (from env vars, never hardcoded)
- Attach decoded user to `req.user` (Express) or `request.state.user` (FastAPI)
- Return 401 for missing/invalid token, 403 for insufficient role

**Validation middleware (Express + Zod):**
- Accept a Zod schema and a source (`body`, `query`, `params`)
- Parse with `schema.safeParse()`; if invalid, return 400 with `error.flatten()`

**Rate limiter:**
- Use `express-rate-limit` (Express) or `slowapi` (FastAPI)
- Configure window (15 min default) and max requests (100 default)
- Store in memory for dev, Redis for production

**Error handler:**
- Catch all unhandled errors
- Map known error types to HTTP status codes
- Return standard envelope: `{ error: { code, message, details? } }`
- Log the full error with stack trace, return sanitized message to client

**Logging:**
- Log: timestamp, method, path, status code, response time
- Use `morgan` (Express) or custom middleware (FastAPI)
- In production, output structured JSON logs

### 4. Wire into the Application

**Express — order matters:**
```js
app.use(helmet());
app.use(cors(corsOptions));
app.use(morgan('combined'));
app.use(express.json());
app.use(rateLimiter);
// ... routes ...
app.use(errorHandler); // must be last
```

**FastAPI:**
```python
app.add_middleware(CORSMiddleware, ...)
app.add_middleware(LoggingMiddleware)
```

### 5. Test the Middleware

- Unit test the middleware function in isolation with mocked req/res/next
- Integration test through routes to confirm the middleware fires correctly
- Verify error handler catches thrown errors and returns the standard envelope

## Checklist Before Done

- [ ] Middleware file created with clear single responsibility
- [ ] Wired into app in the correct order
- [ ] Environment-specific config loaded from env vars
- [ ] Unit and integration tests pass
- [ ] No secrets hardcoded
