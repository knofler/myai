---
name: neural-pattern-match
description: "Find relevant patterns for the current task by scoring against the memory store. Return top-5 matches ranked by tag overlap, recency, confidence, and usage. Triggers: match pattern, find pattern, similar task, what worked before, recall approach"
---

# Neural Pattern Match Playbook

## When to Use
- At the start of a new task to check if relevant patterns exist in memory
- When an agent is stuck and wants to see if a past approach applies
- During `swarm-decompose` to enrich sub-tasks with known approaches

## Prerequisites
- `memory/patterns/index.json` exists and contains at least one pattern
- The current task description is available
- Pattern JSON files exist in `memory/patterns/`

## Playbook

### 1. Parse Current Task Keywords
Extract keywords from the current task description:
- Identify technical terms (e.g., "MongoDB", "authentication", "rate limiting")
- Identify action verbs (e.g., "migrate", "optimize", "deploy")
- Identify domain terms (e.g., "user flow", "API contract", "schema")
- Produce a keyword list of 5-15 terms

### 2. Load the Pattern Index
Read `memory/patterns/index.json`. For each pattern entry, note:
- `id`, `name`, `tags`, `confidence`, `last_used`

### 3. Score Each Pattern
For every pattern in the index, calculate a relevance score using four weighted factors:

| Factor | Weight | Calculation |
|--------|--------|-------------|
| **Tag overlap** | 0.4 | (number of matching tags / total tags in pattern) |
| **Recency** | 0.2 | 1.0 if used within 7 days, 0.5 if within 30, 0.2 if within 90, 0.0 if older |
| **Confidence** | 0.3 | Direct value from pattern (0.0–1.0) |
| **Usage frequency** | 0.1 | min(usage_count / 10, 1.0) — caps at 10 uses |

**Relevance score** = (tag_overlap * 0.4) + (recency * 0.2) + (confidence * 0.3) + (usage * 0.1)

### 4. Rank and Filter
Sort patterns by relevance score descending. Apply filters:
- Exclude patterns with confidence < 0.2 (unreliable)
- Exclude patterns with relevance score < 0.15 (not relevant)
- Take the top 5 results

### 5. Load Full Pattern Details
For each of the top-5 matches, read the full pattern JSON from `memory/patterns/pat-[slug].json`. Extract the `approach`, `tools_used`, and `agents_involved` fields.

### 6. Produce Context Enrichment
Format the matches for consumption by the requesting agent:

```
## Relevant Patterns Found

### 1. [Pattern Name] — Score: [x.xx]
- **Approach**: [summary]
- **Tools**: [list]
- **Confidence**: [x.xx] (used [N] times, [N] successes)
- **Last used**: [date]

### 2. [Pattern Name] — Score: [x.xx]
...
```

### 7. Pass to Requesting Agent
Inject the context enrichment block into the agent's prompt or task description. The agent can choose to follow a matched pattern or ignore it if the current task differs.

## Output
- Top-5 ranked pattern matches with scores and approach summaries
- Context enrichment block ready for agent consumption

## Review Checklist
- [ ] Task keywords were extracted accurately from the current task
- [ ] All four scoring factors were applied with correct weights
- [ ] Low-confidence patterns (< 0.2) were excluded
- [ ] Full pattern details were loaded for top-5 matches only (not all patterns)
- [ ] Output is formatted for easy consumption by the requesting agent
