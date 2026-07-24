---
name: blocker-escalation
description: "Escalate and resolve blockers by identifying type, documenting in state/STATE.md, proposing resolutions, assigning to specialists, and tracking to closure. Triggers: blocker, blocked, impediment, stuck, can't proceed"
---

# Blocker Escalation

Identify, document, and drive resolution of project blockers.

## Playbook

### 1. Identify Blocker Type

Classify the blocker:

| Type | Examples |
|------|----------|
| **Technical** | Bug, missing API, infrastructure issue |
| **Dependency** | Waiting on another team, external service, third-party |
| **Resource** | Missing knowledge, tooling, access permissions |
| **Decision** | Pending architectural or product decision |

### 2. Document in state/STATE.md

Add the blocker under a `## Blockers` section:

```
### Blocker: [Title]
- **Type:** [technical/dependency/resource/decision]
- **Blocking:** [what work is blocked]
- **Since:** [date]
- **Owner:** [who is responsible for resolution]
- **Status:** Open
```

### 3. Propose Resolution Options

- List 2-3 possible resolutions.
- For each option, note the tradeoff (speed vs. quality, scope cut, etc.).
- Recommend the preferred option with justification.

### 4. Assign to Relevant Specialist

Route to the appropriate agent:

| Blocker Type | Agent |
|-------------|-------|
| Technical (API) | `api-specialist` |
| Technical (DB) | `database-specialist` |
| Technical (infra) | `devops-specialist` |
| Security | `security-specialist` |
| Design | `ui-ux-specialist` |
| Architecture | `solution-architect` |
| Decision | `tech-lead` or `product-manager` |

### 5. Track Resolution

- Check back on the blocker after the assigned agent acts.
- Update state/STATE.md with resolution progress.
- If unresolved after one session, escalate to the user.

### 6. Close the Blocker

- Update state/STATE.md: set status to **Resolved**.
- Note the resolution and date.
- Unblock downstream work items.
- Log resolution to `logs/claude_log.md`.
