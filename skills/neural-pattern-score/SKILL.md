---
name: neural-pattern-score
description: "Score and rank patterns by effectiveness after reuse. Adjust confidence up on success, down on failure, and update usage statistics. Triggers: score pattern, rate pattern, pattern feedback, pattern worked, pattern failed"
---

# Neural Pattern Score Playbook

## When to Use
- After a pattern from memory was applied to a task and the outcome is known
- During `neural-session-train` to batch-update patterns used in the current session
- When a user explicitly reports that a past approach worked or failed

## Prerequisites
- The pattern that was reused is identified by ID (e.g., `pat-retry-backoff`)
- The outcome is known: success (task completed correctly) or failure (pattern did not help)
- The pattern JSON file exists at `memory/patterns/pat-[slug].json`

## Playbook

### 1. Identify the Pattern
Locate the pattern file at `memory/patterns/pat-[slug].json`. Read the current values:
- `confidence` (current score)
- `usage_count` (total times applied)
- `success_count` (times it led to success)
- `failure_count` (times it led to failure)
- `last_used` (timestamp of last application)

### 2. Determine Outcome
Classify the outcome:
- **Success** — the pattern was applied and the task completed correctly, on time, without rework
- **Partial success** — the pattern helped but required significant modification
- **Failure** — the pattern was applied but did not solve the problem or caused rework

### 3. Apply Confidence Adjustment
Update the confidence score based on outcome:

| Outcome | Adjustment | Rationale |
|---------|-----------|-----------|
| Success | confidence += 0.05 | Reinforces the pattern |
| Partial success | confidence += 0.02 | Mild reinforcement |
| Failure | confidence -= 0.10 | Penalises more heavily to avoid repeated failures |

Clamp the result: `confidence = max(0.0, min(1.0, confidence))`

### 4. Update Usage Statistics
```
usage_count += 1
if outcome == success:
    success_count += 1
elif outcome == failure:
    failure_count += 1
last_used = [current ISO timestamp]
```

### 5. Write Updated Pattern
Save the updated values back to `memory/patterns/pat-[slug].json`. Preserve all other fields unchanged.

### 6. Update the Index
Update the pattern's entry in `memory/patterns/index.json` with the new `confidence` and `last_used` values.

### 7. Check for Deprecation Threshold
If the updated confidence drops below 0.1:
- Flag the pattern for review by `neural-pattern-prune`
- Add a warning to the log: "Pattern [name] confidence dropped to [value] — candidate for pruning"

### 8. Log the Scoring Event
Append to `logs/claude_log.md`:
```
### Pattern Scored — [timestamp]
- Pattern: [name] (pat-[slug])
- Outcome: [success/partial/failure]
- Confidence: [old] → [new]
- Usage: [count] total ([successes] success, [failures] failure)
```

## Output
- Updated `memory/patterns/pat-[slug].json` with new confidence and usage stats
- Updated `memory/patterns/index.json`
- Log entry in `logs/claude_log.md`
- Deprecation warning if confidence < 0.1

## Review Checklist
- [ ] Correct pattern file was identified and loaded
- [ ] Outcome was classified accurately (success/partial/failure)
- [ ] Confidence adjustment applied the correct delta for the outcome
- [ ] Confidence was clamped to the 0.0–1.0 range
- [ ] Usage counts were incremented correctly
- [ ] Index file was updated to reflect new confidence
- [ ] Low-confidence patterns were flagged for pruning
