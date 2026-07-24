---
name: ops-runbook-create
description: "Create step-by-step operational runbooks for common procedures: service restart, failover, cache flush, database rollback, scaling, and incident response. Triggers: runbook, operational procedure, how to restart, failover guide, operations manual, playbook ops"
---

# Operational Runbook Creation Playbook

## When to Use

- Setting up a new service that needs operational documentation
- After an incident revealed missing operational procedures
- When onboarding new team members to on-call rotation
- Before going to production with a new service

## Prerequisites

- Understanding of the service architecture and dependencies
- Access to deployment infrastructure (Vercel, Render, Atlas)
- Knowledge of monitoring and alerting setup
- Docker-based development environment

## Playbook

### 1. Identify Required Runbooks

Assess which operational procedures the service needs:

| Category | Runbook | Priority |
|----------|---------|----------|
| Restart | Service restart (graceful and forced) | P0 |
| Deploy | Rollback to previous version | P0 |
| Database | Backup and restore | P0 |
| Database | Connection pool reset | P1 |
| Cache | Flush cache (full and selective) | P1 |
| Scale | Horizontal scale up/down | P1 |
| Failover | Switch to backup service | P1 |
| Maintenance | Certificate renewal | P2 |
| Maintenance | Log rotation and cleanup | P2 |

### 2. Write Each Runbook

Use the standard template for every runbook:

```markdown
# [Procedure Name]

## When to Use
[Trigger conditions — what symptoms or alerts invoke this]

## Prerequisites
[Access, tools, permissions needed]

## Impact
[What happens during execution — downtime, degraded performance]

## Steps
1. [Exact command or action]
   - Expected output: [what you should see]
   - If this fails: [fallback action]
2. [Next step]
   ...

## Verification
[How to confirm the procedure worked]

## Rollback
[How to undo if something goes wrong]

## Escalation
[Who to contact if this doesn't resolve the issue]
```

### 3. Include Exact Commands

Every step must have copy-pasteable commands. No ambiguity:

```bash
# Restart the service on Render
curl -X POST "https://api.render.com/v1/services/$SERVICE_ID/restart" \
  -H "Authorization: Bearer $RENDER_API_KEY"

# Verify service is healthy
curl -f https://api.example.com/health || echo "HEALTH CHECK FAILED"
```

### 4. Add Decision Trees

For procedures with branching logic, include a decision tree:

```
Is the service responding?
├── YES → Check error rate
│   ├── Error rate > 5% → Run "Restart Service" runbook
│   └── Error rate normal → Check downstream dependencies
└── NO → Check container status
    ├── Container running → Check port binding
    └── Container stopped → Run "Force Restart" runbook
```

### 5. Define Escalation Paths

For each runbook, define when to escalate:
- **Level 1**: On-call engineer (first 15 minutes)
- **Level 2**: Team lead (after 15 minutes, or P0 severity)
- **Level 3**: Engineering manager (after 30 minutes, or data loss risk)

### 6. Test Every Runbook

Execute each runbook in a non-production environment:
- Verify all commands work as documented
- Confirm expected outputs match reality
- Time the procedure end-to-end
- Note any missing steps discovered during testing

### 7. Organize and Store

Save runbooks to `documentation/runbooks/` with a naming convention:
- `restart-service.md`
- `rollback-deploy.md`
- `database-backup-restore.md`
- `cache-flush.md`

Create an index file listing all runbooks with trigger conditions.

## Output

- Complete runbook documents with exact commands
- Decision trees for branching procedures
- Escalation path definitions
- Runbook index with trigger conditions
- Test results confirming each runbook works

## Review Checklist

- [ ] All critical procedures documented (restart, rollback, backup)
- [ ] Every step has exact, copy-pasteable commands
- [ ] Expected outputs documented for each step
- [ ] Failure handling included (what if a step fails)
- [ ] Verification steps confirm success
- [ ] Escalation paths defined with contact info
- [ ] All runbooks tested in non-production environment
