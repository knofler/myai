---
name: swagger-openapi
description: "Generate OpenAPI 3.0 / Swagger documentation for the API. Triggers: 'swagger', 'openapi', 'API docs', 'API documentation', 'generate swagger', 'document endpoints'."
---

# Swagger / OpenAPI Documentation

Generate and serve OpenAPI 3.0 documentation for the API so consumers can discover endpoints, schemas, and auth requirements interactively.

## When to Use

- Setting up API docs for a new project
- Adding documentation for newly implemented endpoints
- Updating docs after contract or schema changes
- Sharing API reference with frontend or external consumers

## Playbook

### 1. Read Existing Routes

- Scan all route files in `src/routes/` (Express) or `app/routers/` (FastAPI)
- Cross-reference with API contracts in `AI/plan/api-contracts/`
- Catalog every endpoint: method, path, auth, request body, query params, responses

### 2. Generate the OpenAPI Spec

**Express (Node.js) — use `swagger-jsdoc`:**

Create `src/config/swagger.js`:
```js
const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'Project API',
      version: '1.0.0',
      description: 'Auto-generated API documentation',
    },
    servers: [
      { url: '/api/v1', description: 'API v1' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      },
    },
  },
  apis: ['./src/routes/*.js'],
};

module.exports = swaggerJsdoc(options);
```

Add JSDoc annotations to each route file using `@openapi` blocks.

**FastAPI (Python) — built-in:**

FastAPI generates OpenAPI automatically from route decorators and Pydantic models. Ensure:
- Every route has a `summary` and `description`
- Response models are declared with `response_model=`
- Tags group related endpoints
- `dependencies` declare auth requirements

### 3. Serve the Documentation

**Express:**
```js
const swaggerUi = require('swagger-ui-express');
const swaggerSpec = require('./config/swagger');

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
```

**FastAPI:**
Docs are served automatically at `/docs` (Swagger UI) and `/redoc` (ReDoc). Customize via:
```python
app = FastAPI(
    title="Project API",
    docs_url="/api-docs",
    redoc_url="/api-redoc",
)
```

### 4. Validate the Spec

- Export the spec as JSON/YAML: hit `GET /api-docs.json` or use `swagger-jsdoc` CLI
- Validate with `swagger-cli validate openapi.json` or an online validator
- Confirm every endpoint is listed with correct methods and schemas
- Verify auth requirements show the lock icon on protected endpoints
- Check that request/response examples render correctly

### 5. Maintain Over Time

- Add `@openapi` annotations as part of the `endpoint-implementation` skill
- Run spec validation in CI via GitHub Actions
- Version the spec: bump `info.version` on breaking changes
- Keep the spec in sync with API contracts — if a contract changes, update the docs

## Checklist Before Done

- [ ] OpenAPI 3.0 spec generated and valid
- [ ] Swagger UI accessible at `/api-docs`
- [ ] All endpoints documented with method, path, auth, schemas
- [ ] Request/response examples present for key endpoints
- [ ] Spec validation added to CI pipeline (optional but recommended)
