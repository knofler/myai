---
name: neural-session-train
description: "End-of-session pattern training. Review all tasks completed in the session, extract new patterns, score reused patterns, update usage counts, and produce a training report. Triggers: session train, end of session learn, train patterns, session review, learn from session"
---

# Neural Session Train Playbook

## When to Use
- At the end of every work session, before `session-close`
- After completing a large multi-agent task to capture all learnings
- When the user explicitly requests a review of what was learned

## Prerequisites
- The current session has completed at least one task
- `logs/claude_log.md` contains entries from the current session
- `memory/patterns/` directory exists with index.json
- `memory/sona-config.json` exists for learning rate reference

## Playbook

### 1. Inventory Session Tasks
Scan `logs/claude_log.md` and `state/STATE.md` for all tasks completed in the current session. For each task, capture:
- Task description
- Approach taken
- Outcome (success, partial, failure)
- Agents involved
- Whether a memory pattern was reused

### 2. Score Reused Patterns
For each task that used an existing pattern from memory:
1. Identify the pattern ID that was matched
2. Determine the outcome (success/partial/failure)
3. Invoke `neural-pattern-score` logic to update confidence and usage stats
4. Record the scoring event

### 3. Extract New Patterns
For each task that did NOT use an existing pattern:
1. Evaluate whether the approach is generalizable (skip one-off fixes)
2. If generalizable, invoke `neural-pattern-extract` logic to create a new pattern
3. Assign initial confidence of 0.5
4. Add to the index

### 4. Check for Consolidation Opportunities
After adding new patterns, scan for near-duplicates:
- New pattern tags overlap 80%+ with an existing pattern
- Approach descriptions are semantically similar
- Flag these for consolidation but do not auto-merge during training — let `neural-pattern-prune` handle it

### 5. Update Learning Rate
If 5 or more pattern-use events occurred this session:
1. Calculate session accuracy from scoring results
2. Invoke `neural-learn-rate` logic to adjust the rate if warranted
3. If fewer than 5 events, skip rate adjustment

### 6. Produce Training Report
```
## Session Training Report — [timestamp]

### Tasks Reviewed: [N]

### Patterns Reused
| Pattern | Task | Outcome | Confidence Change |
|---------|------|---------|-------------------|
| pat-retry-backoff | Fix timeout errors | success | 0.65 → 0.70 |

### New Patterns Extracted
| Pattern | Source Task | Tags | Confidence |
|---------|-----------|------|-----------|
| pat-docker-layer-cache | Optimize build time | docker, performance | 0.50 |

### Patterns Flagged
- Near-duplicate: pat-new-approach ≈ pat-existing-approach (80% tag overlap)

### Learning Rate
- Session accuracy: [x.xx]
- Rate adjustment: [old] → [new] ([converge/explore/hold])

### Memory Store Summary
- Total patterns: [N]
- Average confidence: [x.xx]
- Patterns above 0.7: [N] (reliable)
- Patterns below 0.2: [N] (candidates for pruning)
```

### 7. Save and Log
- Write the training report to `state/STATE.md` under the session section
- Append a summary to `logs/claude_log.md`
- Ensure all pattern files and index.json are saved

## Output
- Updated pattern files in `memory/patterns/` with new scores and entries
- Updated `memory/patterns/index.json`
- Updated `memory/sona-config.json` (if learning rate was adjusted)
- Session training report in `state/STATE.md` and `logs/claude_log.md`

## Review Checklist
- [ ] Every completed task in the session was reviewed
- [ ] Reused patterns had their confidence and usage updated
- [ ] New patterns were only extracted for generalizable approaches
- [ ] Near-duplicates were flagged but not auto-merged
- [ ] Learning rate was adjusted only if 5+ scoring events occurred
- [ ] Training report includes all sections with accurate data
- [ ] All memory files are valid JSON after updates
