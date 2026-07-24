---
name: ops-alert-rules
description: "Define alerting rules. Error rate thresholds, latency p95/p99, disk/memory alerts, custom business metrics. Output as structured config. Triggers: alert rules, alerting, monitoring alerts, error threshold, latency alert"
---

# Alert Rules Definition Playbook

## When to Use

- Setting up alerting for a new production service
- Adding alerts for new infrastructure or business metrics
- Reviewing and tuning existing alert thresholds to reduce noise
- Defining escalation policies for different severity levels

## Prerequisites

- Production service with health endpoints deployed
- Knowledge of baseline performance metrics (or will establish during setup)
- Notification channels configured (Slack, email, PagerDuty, or webhook)

## Playbook

### 1. Categorize Alert Severity Levels

Define four severity tiers:

| Severity | Response Time | Example | Notification |
|----------|--------------|---------|-------------|
| P1 Critical | Immediate (<5min) | Service down, data loss risk | PagerDuty + Slack #incidents |
| P2 High | <30min | Error rate >5%, latency p95 >5s | Slack #alerts + email |
| P3 Medium | <4hr | Disk >80%, memory >85% | Slack #monitoring |
| P4 Low | Next business day | Cert expiring in 14d, deps outdated | Email digest |

### 2. Define Infrastructure Alerts

```yaml
infrastructure_alerts:
  cpu_usage:
    warning: { threshold: 70, duration: "5m", severity: P3 }
    critical: { threshold: 90, duration: "2m", severity: P1 }
  memory_usage:
    warning: { threshold: 80, duration: "5m", severity: P3 }
    critical: { threshold: 95, duration: "2m", severity: P1 }
  disk_usage:
    warning: { threshold: 75, duration: "10m", severity: P3 }
    critical: { threshold: 90, duration: "5m", severity: P2 }
  container_restarts:
    warning: { threshold: 3, window: "15m", severity: P3 }
    critical: { threshold: 5, window: "15m", severity: P2 }
```

### 3. Define Application Alerts

```yaml
application_alerts:
  error_rate:
    warning: { threshold: "1%", window: "5m", severity: P3 }
    critical: { threshold: "5%", window: "5m", severity: P1 }
  latency_p95:
    warning: { threshold: "1000ms", window: "5m", severity: P3 }
    critical: { threshold: "3000ms", window: "5m", severity: P2 }
  latency_p99:
    warning: { threshold: "3000ms", window: "5m", severity: P3 }
    critical: { threshold: "5000ms", window: "5m", severity: P1 }
  health_check_failure:
    critical: { consecutive_failures: 3, severity: P1 }
  request_volume_drop:
    warning: { threshold: "50% below baseline", window: "15m", severity: P2 }
```

### 4. Define Database Alerts

```yaml
database_alerts:
  connection_pool_usage:
    warning: { threshold: "80%", severity: P3 }
    critical: { threshold: "95%", severity: P1 }
  slow_queries:
    warning: { threshold: ">500ms", count: 10, window: "5m", severity: P3 }
  replication_lag:
    warning: { threshold: "5s", severity: P3 }
    critical: { threshold: "30s", severity: P2 }
```

### 5. Define Business Metric Alerts

Identify key business metrics from the application domain:

- Signups per hour dropping below baseline
- Payment failures exceeding threshold
- Queue depth growing beyond capacity
- API quota usage approaching limit

Format each with threshold, window, severity, and runbook link.

### 6. Configure Alert Routing and Deduplication

- Group related alerts to avoid alert storms (e.g., one DB outage triggers many downstream alerts)
- Set inhibition rules: P1 database alert suppresses P2/P3 application alerts
- Configure cooldown periods: do not re-alert for same condition within 15 minutes
- Route by severity to appropriate channels and on-call schedules

### 7. Document Runbook Links

Every P1 and P2 alert must link to a runbook with first-responder steps. Reference the `ops-runbook-create` skill for creating these.

## Output

- Alert rules configuration file (YAML or JSON)
- Severity level definitions with response time expectations
- Alert routing and escalation policy
- Runbook link for each critical alert

## Review Checklist

- [ ] Every P1/P2 alert has a linked runbook
- [ ] Thresholds are based on baseline data, not arbitrary values
- [ ] Alert grouping prevents storm scenarios
- [ ] Cooldown periods prevent duplicate notifications
- [ ] Business metric alerts cover key revenue and user-facing flows
- [ ] At least one human has validated thresholds against real traffic
