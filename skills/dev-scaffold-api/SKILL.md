---
name: dev-scaffold-api
description: "Scaffold a complete Express or FastAPI project with Docker, health endpoint, and auth. Triggers: 'scaffold API', 'new API project', 'bootstrap API', 'create API starter', 'init express', 'init fastapi'."
---

# API Scaffold Playbook

## When to Use
- Starting a new backend service from scratch
- Creating a microservice within an existing system
- Need a production-ready API starter with Docker and CI

## Prerequisites
- Target directory path known and writable
- Framework choice: Express (Node.js) or FastAPI (Python)
- Docker installed on the development machine
- Project name and port number decided

## Playbook

### 1. Create Directory Structure
- Create the project root with standard layout:
  - Express: `src/{routes,controllers,services,middleware,models,utils}/`, `tests/`, `scripts/`
  - FastAPI: `app/{routers,services,middleware,models,schemas}/`, `tests/`, `scripts/`
- Create config files at root: `.env.example`, `.gitignore`, `.dockerignore`

### 2. Initialize Package Manager
- **Express**: Create `package.json` with scripts (dev, start, test, lint, typecheck). Install: express, cors, helmet, dotenv, winston, zod. Dev deps: typescript, ts-node-dev, jest, supertest, eslint, @types/*
- **FastAPI**: Create `requirements.txt` with: fastapi, uvicorn, pydantic, python-dotenv, structlog. Dev: pytest, httpx, ruff. Create `pyproject.toml` with tool configs

### 3. Create Health Endpoint
- Route: `GET /health` returning `{ status: "ok", timestamp, uptime, version }`
- No auth required on this endpoint
- Include in both the main router and Docker healthcheck

### 4. Set Up Error Handling Middleware
- Custom `AppError` class with statusCode, message, and isOperational flag
- Global error handler that catches sync and async errors
- Structured error response: `{ error: { code, message, details? } }`
- Log errors with stack trace in development, without in production

### 5. Add Basic Auth Middleware
- JWT verification middleware (reads from `Authorization: Bearer` header)
- Placeholder secret in `.env.example` with `JWT_SECRET=change-me`
- Protect all routes except `/health` and `/api/v1/auth/*`
- Role-based access control helper: `requireRole('admin')`

### 6. Create Docker Setup
- `Dockerfile` with multi-stage build (deps, build, runtime)
- `docker-compose.yml` with app service, MongoDB service, and network
- `.dockerignore` excluding node_modules, .git, .env, tests
- Healthcheck in compose: `curl -f http://localhost:{port}/health`
- Entrypoint script that waits for DB before starting

### 7. Add Configuration
- `.env.example` with: PORT, NODE_ENV, MONGO_URI, JWT_SECRET, LOG_LEVEL
- Config loader that validates all required env vars on startup
- Fail fast with clear error if required vars are missing

### 8. Create Entry Point
- Express: `src/index.ts` — load config, connect DB, register middleware, mount routes, start server
- FastAPI: `app/main.py` — create app, add middleware, include routers, configure CORS

## Output
- Complete project directory ready to `docker compose up`
- Health endpoint responding at `/health`
- Error handling middleware in place
- Auth middleware scaffolded with JWT placeholder
- `.env.example` documenting all required variables

## Review Checklist
- [ ] Project runs with `docker compose up` without errors
- [ ] Health endpoint returns 200 with expected payload
- [ ] Error handling catches and formats errors consistently
- [ ] Auth middleware rejects requests without valid token
- [ ] All env vars documented in `.env.example`
- [ ] `.gitignore` excludes node_modules, .env, dist
