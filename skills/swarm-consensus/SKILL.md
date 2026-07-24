---
name: swarm-consensus
description: "Resolve conflicting agent outputs using weighted voting and structured analysis. Present both positions with recommendation. Triggers: conflict, disagreement, contradictory, consensus, resolve conflict, agents disagree"
---

# Swarm Consensus Playbook

## When to Use
- Two or more agents produce contradictory outputs for related sub-tasks
- A code review agent rejects work from an implementation agent
- Architectural recommendations from different specialists conflict

## Prerequisites
- At least two conflicting agent outputs are available with their reasoning
- The original task or requirement that triggered both outputs is known
- Agent roles and lane ownership are understood from `documentation/MULTI_AGENT_ROUTING.md`

## Playbook

### 1. Identify the Conflict
State the conflict clearly:
- **Agent A** ([name]): produced [output summary]
- **Agent B** ([name]): produced [output summary]
- **Point of conflict**: [exactly what contradicts]

### 2. Classify the Conflict Type
| Type | Description | Resolution Strategy |
|------|-------------|-------------------|
| **Technical** | Different implementation approaches | Evaluate against tech mandates |
| **Architectural** | Conflicting design decisions | Defer to solution-architect |
| **Scope** | Disagreement on what to build | Defer to product-manager |
| **Quality** | Standards vs. delivery speed | Defer to tech-lead |

### 3. Apply Weighted Voting
Score each agent's position using weighted criteria:

| Factor | Weight | Description |
|--------|--------|-------------|
| Domain expertise | 0.35 | Is this agent the domain specialist for this topic? |
| Alignment with requirements | 0.25 | Which output better matches the original task? |
| Consistency with codebase | 0.20 | Which approach fits existing patterns and tech mandates? |
| Simplicity | 0.10 | Which solution is simpler to implement and maintain? |
| Precedent | 0.10 | Has either approach been used successfully before in this project? |

Calculate a score (0.0–1.0) for each agent's position.

### 4. Present Analysis
Document both positions with pros and cons:
```
### Position A: [Agent] — Score: [x.xx]
- Approach: [summary]
- Pros: [list]
- Cons: [list]

### Position B: [Agent] — Score: [x.xx]
- Approach: [summary]
- Pros: [list]
- Cons: [list]
```

### 5. Recommend Resolution
Based on the weighted scores:
- If score difference > 0.15 — recommend the higher-scoring position
- If score difference <= 0.15 — flag as close call, present to user for decision
- If conflict involves a security concern — always defer to `security-specialist`

### 6. Record the Decision
Log the consensus decision in `state/STATE.md`:
```
### Consensus Decision — [timestamp]
- Conflict: [summary]
- Resolution: [chosen approach]
- Rationale: [why this approach won]
- Rejected: [what was not chosen and why]
```

## Output
- Consensus decision documented in `state/STATE.md`
- Losing agent's output archived or discarded
- Winning approach integrated into the task tree

## Review Checklist
- [ ] Both positions were fairly represented with pros and cons
- [ ] Weighted scoring used all five factors with correct weights
- [ ] Domain specialist weight was correctly applied
- [ ] Close-call conflicts (difference <= 0.15) were escalated to the user
- [ ] Decision was logged in STATE.md with full rationale
