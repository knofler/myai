---
name: backlog-prioritize
description: "Prioritize product backlog using RICE or weighted scoring. Rank items, identify quick wins, and group into milestones. Triggers: backlog, prioritize, priority, what to build next, ranking"
---

# Backlog Prioritization

Score, rank, and organize backlog items by impact and effort.

## Playbook

### 1. List All Backlog Items

- Gather every pending item: features, bugs, tech debt, spikes.
- Pull from state/STATE.md, issue trackers, or user input.
- Ensure each item has a clear one-line description.

### 2. Score Each Item

Use **RICE** scoring or a simplified value/effort matrix:

**RICE** (default):
- **Reach**: How many users/transactions affected per quarter? (1-10)
- **Impact**: How much does it move the needle? (0.25 / 0.5 / 1 / 2 / 3)
- **Confidence**: How sure are we? (50% / 80% / 100%)
- **Effort**: Person-weeks to complete. (0.5 - 8)
- Score = (Reach x Impact x Confidence) / Effort

**Simplified** (if data is scarce):
- Value: High / Medium / Low
- Effort: High / Medium / Low

### 3. Rank Items

- Sort by RICE score descending (or Value/Effort ratio).
- Break ties by risk: lower-risk items rank higher.
- Present the ranked list as a numbered table.

### 4. Identify Quick Wins

- Quick win = High value + Low effort.
- Flag the top 3-5 quick wins separately.
- These are candidates for immediate execution.

### 5. Group into Milestones

- Cluster related items into milestones or sprints.
- Respect dependency ordering within each group.
- Assign a rough timeline to each milestone.

### 6. Output

Produce a prioritized backlog:

```
## Prioritized Backlog

### Ranked Items
| # | Item | Reach | Impact | Confidence | Effort | RICE |
|---|------|-------|--------|------------|--------|------|

### Quick Wins
- ...

### Milestone Groupings
#### Milestone 1: [Name]
- ...

#### Milestone 2: [Name]
- ...
```

Present to the user for review and adjustment.
