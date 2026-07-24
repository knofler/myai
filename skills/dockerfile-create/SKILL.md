---
name: dockerfile-create
description: "Create optimized, multi-stage Dockerfiles with layer caching. Triggers: 'Dockerfile', 'Docker image', 'containerize', 'build image'"
---

# Dockerfile Creation

Create production-optimized Dockerfiles using multi-stage builds and layer caching.

## Prerequisites

- Identify runtime: Node.js, Python, or static (Next.js export)
- Know the application's entry point and port

## Steps

### 1. Choose base image

- Node.js: `node:20-alpine` (small footprint)
- Python: `python:3.12-slim`
- Static: `nginx:alpine` for final stage
- Always pin major version, prefer `alpine` or `slim` variants

### 2. Set up multi-stage build

```dockerfile
# Stage 1: Dependencies
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --only=production

# Stage 2: Build
FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

# Stage 3: Runtime
FROM node:20-alpine AS runner
WORKDIR /app
```

### 3. Copy dependency files first (layer caching)

- Copy `package.json` and lockfile before source code
- Docker caches this layer; rebuilds only when deps change
- For Python: copy `requirements.txt` first, then `pip install`

### 4. Set working directory

- Use `WORKDIR /app` consistently
- Avoid running as root in final stage

### 5. Configure non-root user

```dockerfile
RUN addgroup --system --gid 1001 appgroup
RUN adduser --system --uid 1001 appuser
USER appuser
```

### 6. Copy build artifacts to final stage

- Copy only what's needed: built output, node_modules (production), config
- Do not copy source code, tests, or dev dependencies to final image

### 7. Expose port and set entrypoint

```dockerfile
EXPOSE 3000
ENV NODE_ENV=production
CMD ["node", "server.js"]
```

### 8. Create .dockerignore

```
node_modules
.git
.env
.env.*
*.md
.next
coverage
.github
tests
```

### 9. Add metadata labels

```dockerfile
LABEL org.opencontainers.image.source="https://github.com/org/repo"
LABEL org.opencontainers.image.description="App description"
```

### 10. Add HEALTHCHECK instruction

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
```

## Validation

```bash
docker build -t app:latest .                 # Build image
docker images app:latest                     # Check size
docker run --rm -p 3000:3000 app:latest      # Test locally
docker scout quickview app:latest            # Scan vulnerabilities
```
