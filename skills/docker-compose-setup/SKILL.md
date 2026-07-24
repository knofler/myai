---
name: docker-compose-setup
description: "Set up docker-compose.yml for full-stack local development. Triggers: 'docker-compose', 'compose file', 'multi-container', 'local dev environment'"
---

# Docker Compose Setup

Create a production-ready `docker-compose.yml` for multi-container local development.

## Prerequisites

- Docker and Docker Compose installed
- Project has a Dockerfile (or use `dockerfile-create` skill first)
- `.env` file exists (or use `env-strategy` skill first)

## Steps

### 1. Create docker-compose.yml at project root

Define the top-level structure with version and services block.

### 2. Define application service (app)

- Build from `./Dockerfile` or reference image
- Map port 3000:3000 (Next.js / frontend)
- Mount source code as volume for hot reload: `./src:/app/src`
- Set `depends_on` to api and db services
- Reference `.env` file with `env_file: .env`

### 3. Define API service (api)

- Build from `./api/Dockerfile` or `./server/Dockerfile`
- Map port 4000:4000 (Node.js / Python API)
- Mount API source for hot reload
- Set `depends_on` to db service with healthcheck condition
- Pass database connection string via environment

### 4. Define database service (db)

- Use `mongo:7` image for MongoDB
- Map port 27017:27017
- Mount named volume for data persistence: `mongodb_data:/data/db`
- Set `MONGO_INITDB_ROOT_USERNAME` and `MONGO_INITDB_ROOT_PASSWORD` from `.env`

### 5. Configure networks

- Create a shared bridge network: `app-network`
- Attach all services to the same network
- Use service names as hostnames (e.g., `mongodb://db:27017`)

### 6. Configure volumes

- Declare named volume `mongodb_data` for database persistence
- Use bind mounts for source code (hot reload)
- Exclude `node_modules` with anonymous volume: `/app/node_modules`

### 7. Add healthchecks to each service

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
  interval: 30s
  timeout: 10s
  retries: 3
  start_period: 40s
```

For MongoDB use: `["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]`

### 8. Map environment variables

- Use `env_file: .env` for shared variables
- Override per-service with `environment:` block
- Never hardcode secrets in compose file

### 9. Configure restart policies

- Set `restart: unless-stopped` for all services
- Use `restart: always` for database in production profiles

### 10. Add development overrides

Create `docker-compose.override.yml` for dev-specific settings:
- Debug ports
- Verbose logging
- Volume mounts for live reload

## Validation

```bash
docker compose config          # Validate compose file
docker compose up -d           # Start all services
docker compose ps              # Verify all healthy
docker compose logs -f         # Tail logs
```
