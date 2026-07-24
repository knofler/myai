---
name: ops-incident-rca
description: "Conduct blameless root cause analysis for production incidents. Build timeline, apply 5-whys technique, identify contributing factors, define remediation actions, and establish prevention measures. Triggers: RCA, root cause, incident review, postmortem, post-incident, blameless review"
---

# Incident Root Cause Analysis Playbook

## When to Use

- After any production incident (P0 or P1 severity)
- After a near-miss that could have caused an outage
- When recurring issues suggest a systemic problem
- As part of mandatory post-incident review process

## Prerequisites

- Incident timeline available (alerts, logs, chat history)
- Access to monitoring dashboards and log aggregation
- List of responders and actions taken during incident
- Blameless culture commitment from all participants

## Playbook

### 1. Establish Incident Summary

Document the basics:
- **Incident ID**: unique identifier
- **Date/Time**: start, detection, mitigation, resolution (all in UTC)
- **Duration**: total time from start to resolution
- **Severity**: P0 (critical), P1 (major), P2 (minor)
- **Impact**: users affected, revenue impact, data loss, SLA breach
- **Services affected**: list all impacted components

### 2. Build the Timeline

Construct a minute-by-minute timeline:

| Time (UTC) | Event | Source |
|-----------|-------|--------|
| 14:00 | Deploy v2.3.1 pushed to production | GitHub Actions |
| 14:05 | Error rate spikes to 15% | Monitoring alert |
| 14:07 | On-call engineer paged | PagerDuty |
| 14:12 | Root cause identified: missing env var | Manual investigation |
| 14:15 | Rollback initiated | Manual deploy |
| 14:18 | Error rate returns to baseline | Monitoring |

Include: deployments, alerts, communications, actions taken, and resolution steps.

### 3. Apply 5-Whys Analysis

Starting from the impact, ask "why" iteratively:

1. **Why** did users see errors? → API returned 500 on /api/tasks
2. **Why** did the API return 500? → Database connection failed
3. **Why** did the DB connection fail? → Connection string env var was empty
4. **Why** was the env var empty? → Deploy script did not propagate new secrets
5. **Why** didn't the deploy script propagate? → No validation step for required env vars

The final "why" reveals the systemic root cause.

### 4. Identify Contributing Factors

Beyond the root cause, document factors that made the incident worse or delayed resolution:
- **Detection gap**: How long before the issue was noticed?
- **Monitoring gap**: Were there missing alerts?
- **Runbook gap**: Did responders know what to do?
- **Communication gap**: Was escalation timely?
- **Testing gap**: Could this have been caught pre-deploy?

### 5. Define Remediation Actions

For each contributing factor, create a specific action item:

| Action | Owner | Priority | Due Date | Status |
|--------|-------|----------|----------|--------|
| Add env var validation to deploy script | DevOps | P1 | Next sprint | Open |
| Add DB connection health check to CI | QA | P2 | Next sprint | Open |
| Create runbook for DB connection failures | Docs | P2 | 2 weeks | Open |

### 6. Establish Prevention Measures

Long-term changes to prevent recurrence:
- **Process changes**: pre-deploy checklists, mandatory canary deploys
- **Technical changes**: circuit breakers, health checks, env validation
- **Monitoring changes**: new alerts, tighter thresholds, synthetic monitoring
- **Training**: incident response drills, runbook reviews

### 7. Write the RCA Document

Compile everything into a structured document stored in `documentation/incidents/` with the standard sections: Summary, Timeline, Root Cause, Contributing Factors, Actions, Prevention.

## Output

- Incident timeline (minute-by-minute)
- 5-whys analysis chain to root cause
- Contributing factors list
- Remediation action items with owners and deadlines
- Prevention measures for systemic improvement
- RCA document in `documentation/incidents/`

## Review Checklist

- [ ] Timeline is complete and verified with multiple sources
- [ ] 5-whys reaches a systemic root cause (not a person)
- [ ] Tone is blameless throughout the document
- [ ] Every contributing factor has a remediation action
- [ ] Actions have owners, priorities, and due dates
- [ ] Prevention measures address systemic issues
- [ ] RCA document is shared with all stakeholders
