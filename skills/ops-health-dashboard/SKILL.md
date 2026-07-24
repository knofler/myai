---
name: ops-health-dashboard
description: "Generate health check dashboard configuration. Define health endpoints, uptime checks, response time thresholds, dependency health, status page config. Triggers: health dashboard, uptime, status page, monitoring dashboard, health config"
---

# Health Dashboard Configuration Playbook

## When to Use

- Setting up health monitoring for a new service
- Adding dependency health checks to an existing project
- Creating a status page configuration for stakeholders
- Defining response time thresholds and SLOs

## Prerequisites

- Running application with at least one HTTP endpoint
- Knowledge of all service dependencies (database, cache, external APIs)
- Target SLOs defined (or use defaults: 99.9% uptime, <500ms p95)

## Playbook

### 1. Inventory All Service Dependencies

Scan the codebase for external connections:

| Dependency Type | Detection Signal | Health Check Method |
|----------------|-----------------|-------------------|
| MongoDB | `mongoose.connect` or `MONGODB_URI` | `db.admin().ping()` |
| Redis | `redis.createClient` or `REDIS_URL` | `client.ping()` |
| External API | `fetch`/`axios` calls to external domains | HEAD request with timeout |
| Message Queue | `amqplib`/`bullmq` imports | Connection status check |

Document each dependency with: name, type, criticality (critical/degraded/optional), timeout threshold.

### 2. Implement Health Endpoint

Create `/api/health` returning structured JSON:

```json
{
  "status": "healthy",
  "version": "1.2.3",
  "uptime": 86400,
  "timestamp": "2024-01-15T10:30:00Z",
  "checks": {
    "database": { "status": "healthy", "latency_ms": 12 },
    "redis": { "status": "healthy", "latency_ms": 3 },
    "external_api": { "status": "degraded", "latency_ms": 890 }
  }
}
```

Return HTTP 200 for healthy, 503 for unhealthy. Include a `/api/health/ready` readiness probe and `/api/health/live` liveness probe.

### 3. Define Thresholds

Set per-dependency thresholds:

| Metric | Default | Critical |
|--------|---------|----------|
| Response time p50 | <200ms | >500ms |
| Response time p95 | <500ms | >2000ms |
| Response time p99 | <1000ms | >5000ms |
| Error rate | <0.1% | >1% |
| DB query time | <50ms | >200ms |
| Uptime target | 99.9% | <99.5% |

### 4. Configure Uptime Checks

Define external monitoring checks (compatible with UptimeRobot, Pingdom, or similar):

- Primary health endpoint: check every 60 seconds
- Individual dependency endpoints: check every 300 seconds
- Alert after 2 consecutive failures
- Verify response body contains `"status":"healthy"`

### 5. Create Status Page Configuration

Define public-facing status components:

- Group by service area (Frontend, API, Database, Integrations)
- Map internal health checks to public component names
- Configure incident auto-detection from consecutive failures
- Set maintenance window support

### 6. Add Docker Healthcheck

Add healthcheck to Dockerfile and docker-compose.yml:

- Interval: 30s, timeout: 10s, retries: 3, start_period: 40s
- Use `curl -f http://localhost:PORT/api/health/live` as test command

## Output

- `/api/health` endpoint returning structured dependency status
- `/api/health/ready` and `/api/health/live` probe endpoints
- Threshold configuration document
- Docker healthcheck configuration
- Uptime monitoring configuration

## Review Checklist

- [ ] All dependencies have health checks with appropriate timeouts
- [ ] Health endpoint returns 503 when critical dependencies fail
- [ ] Thresholds are realistic for the service type
- [ ] Docker healthcheck is configured with start_period for boot time
- [ ] Status page components map to actual health checks
- [ ] No secrets exposed in health endpoint responses
