---
name: health-check-setup
description: "Add health check and readiness endpoints with Docker healthcheck integration. Triggers: 'health check', 'healthcheck', 'liveness', 'readiness', 'monitoring endpoint'"
---

# Health Check Setup

Add `/health` and `/ready` endpoints for liveness/readiness probes and Docker healthchecks.

## Prerequisites

- Running API service (Node.js/Express or Python/FastAPI)
- Database connection configured

## Steps

### 1. Create /health endpoint (liveness probe)

Lightweight check that the process is alive. No dependency checks.

```javascript
// Express
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version || 'unknown'
  });
});
```

### 2. Create /ready endpoint (readiness probe)

Checks that the service can handle requests — verifies database and critical dependencies.

```javascript
app.get('/ready', async (req, res) => {
  try {
    // Check database connection
    const dbState = mongoose.connection.readyState;
    if (dbState !== 1) {
      throw new Error('Database not connected');
    }
    // Ping database
    await mongoose.connection.db.admin().ping();

    res.status(200).json({
      status: 'ready',
      checks: {
        database: 'connected'
      }
    });
  } catch (err) {
    res.status(503).json({
      status: 'not ready',
      checks: {
        database: err.message
      }
    });
  }
});
```

### 3. Add Docker HEALTHCHECK instruction

In the Dockerfile:

```dockerfile
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD curl -f http://localhost:4000/health || exit 1
```

### 4. Configure Docker Compose healthcheck

```yaml
services:
  api:
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:4000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
  db:
    healthcheck:
      test: ["CMD", "mongosh", "--eval", "db.adminCommand('ping')"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 20s
```

### 5. Use healthcheck in service dependencies

```yaml
services:
  api:
    depends_on:
      db:
        condition: service_healthy
```

### 6. Add basic monitoring metadata

Extend `/health` with optional details for monitoring dashboards:

```javascript
{
  status: 'ok',
  timestamp: new Date().toISOString(),
  uptime: process.uptime(),
  memory: process.memoryUsage(),
  version: process.env.npm_package_version,
  environment: process.env.NODE_ENV
}
```

### 7. Secure health endpoints

- `/health` — public, no auth required (used by load balancers)
- `/ready` — optionally restrict to internal network
- Never expose sensitive data (secrets, full config) in health responses

## Validation

```bash
curl http://localhost:4000/health        # Should return 200
curl http://localhost:4000/ready         # Should return 200 when DB is up
docker inspect --format='{{.State.Health}}' <container>   # Check Docker health
docker compose ps                        # Verify "healthy" status
```
