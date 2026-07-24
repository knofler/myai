---
name: memory-retrieve
description: "Retrieve memories by tags, context, or keywords with relevance scoring. Triggers: 'recall memory', 'retrieve memory', 'search memory', 'what do I know about', 'find pattern'."
---

# Memory Retrieve Playbook

## When to Use
- Starting a task and need prior context, patterns, or preferences
- Looking for past error resolutions to avoid repeated investigation
- Searching for user preferences before making decisions
- Building context for a specialist agent before dispatching work

## Prerequisites
- Memory directory structure exists: `memory/{patterns,preferences,errors,context}/`
- Each subdirectory has a populated `index.json` file
- Query must include at least one keyword or tag

## Playbook

### 1. Parse Query
- Extract keywords from the query string (lowercase, remove stop words)
- Identify explicit tags if provided (prefixed with `tag:`)
- Determine memory type filter if specified (prefixed with `type:`)
- If no type filter, search all subdirectories

### 2. Scan Indexes
- Load `index.json` from each target subdirectory
- For each entry, compute a relevance score using three factors:
  - **Tag overlap** (weight 0.5): Jaccard similarity between query tags and entry tags
  - **Confidence** (weight 0.3): Entry confidence value (0.0-1.0)
  - **Recency** (weight 0.2): Decay function on `last_used` — entries used within 7 days get 1.0, within 30 days get 0.7, within 90 days get 0.3, older get 0.1
- Final score = (tag_overlap * 0.5) + (confidence * 0.3) + (recency * 0.2)

### 3. Rank and Filter
- Sort all matched entries by score descending
- Apply minimum score threshold of 0.2 — discard entries below
- Select top-N results (default N=5, configurable via `limit:` prefix)
- Load full entry JSON for each result from `memory/{type}/{id}.json`

### 4. Update Usage Metadata
- For each returned entry, increment `usage_count` by 1
- Update `last_used` to current ISO timestamp
- Write updated entry back to disk
- Update corresponding `index.json` entry

### 5. Format Response
- Return results as structured list with: id, type, tags, content summary (first 200 chars), confidence, score
- Include total matches found vs returned count
- Flag any entries with confidence < 0.3 as low-confidence

## Output
- Ranked list of memory entries with relevance scores
- Updated `last_used` and `usage_count` on returned entries
- Updated `index.json` files for accessed subdirectories

## Review Checklist
- [ ] Query parsed correctly with keywords extracted
- [ ] All relevant subdirectories scanned
- [ ] Scoring formula applied consistently (tag 0.5, confidence 0.3, recency 0.2)
- [ ] Minimum score threshold enforced
- [ ] Usage metadata updated on returned entries
- [ ] Low-confidence entries flagged in response
