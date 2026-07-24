---
name: neural-learn-rate
description: "Adjust the SONA learning rate based on recent prediction accuracy. Reduce rate when converging (accurate), increase when exploring (inaccurate). Update sona-config.json. Triggers: learning rate, adjust rate, sona config, convergence, exploration rate"
---

# Neural Learn Rate Playbook

## When to Use
- At the end of a session after multiple patterns have been scored
- When pattern match accuracy is noticeably high or low over several tasks
- During periodic SONA maintenance to tune the system

## Prerequisites
- `memory/sona-config.json` exists (create with defaults if not)
- Recent pattern scoring data is available in `logs/claude_log.md`
- At least 5 pattern-use events have occurred since the last rate adjustment

## Playbook

### 1. Load Current Configuration
Read `memory/sona-config.json`:
```json
{
  "learning_rate": 0.05,
  "min_rate": 0.01,
  "max_rate": 0.15,
  "accuracy_window": 10,
  "last_adjusted": "[ISO timestamp]",
  "adjustment_history": []
}
```

If the file does not exist, create it with the defaults above.

### 2. Calculate Recent Accuracy
Review the last N pattern-use events (where N = `accuracy_window`):
1. Read `logs/claude_log.md` for "Pattern Scored" entries
2. Count successes and failures in the window
3. Calculate accuracy: `accuracy = successes / total_events`

### 3. Determine Rate Direction
Apply the adaptive rule:

| Accuracy | Action | Rationale |
|----------|--------|-----------|
| >= 0.8 | Decrease rate by 20% | Patterns are reliable — converge, reduce volatility |
| 0.5–0.8 | No change | Normal operating range |
| < 0.5 | Increase rate by 30% | Patterns are unreliable — explore, allow faster adaptation |

Calculate new rate:
- **Decrease**: `new_rate = current_rate * 0.8`
- **Increase**: `new_rate = current_rate * 1.3`
- **Clamp**: `new_rate = max(min_rate, min(max_rate, new_rate))`

### 4. Update Confidence Deltas
The learning rate controls how much confidence changes on each pattern scoring event:
- **Success delta**: `+learning_rate` (default +0.05)
- **Failure delta**: `-learning_rate * 2` (default -0.10)
- **Partial delta**: `+learning_rate * 0.4` (default +0.02)

These deltas are used by `neural-pattern-score` when adjusting pattern confidence.

### 5. Update Configuration
Write the updated values to `memory/sona-config.json`:
```json
{
  "learning_rate": [new_rate],
  "min_rate": 0.01,
  "max_rate": 0.15,
  "accuracy_window": 10,
  "last_adjusted": "[current ISO timestamp]",
  "adjustment_history": [
    ...previous,
    {
      "timestamp": "[ISO]",
      "accuracy": [value],
      "old_rate": [old],
      "new_rate": [new],
      "direction": "[converge/explore/hold]"
    }
  ]
}
```

### 6. Propagate to Pattern Scoring
Ensure that `neural-pattern-score` reads the current `learning_rate` from `sona-config.json` rather than using hardcoded deltas. The playbook for `neural-pattern-score` references fixed values as defaults — the config file overrides them.

### 7. Log the Adjustment
Append to `logs/claude_log.md`:
```
### Learning Rate Adjusted — [timestamp]
- Accuracy (last [N] events): [x.xx]
- Direction: [converge/explore/hold]
- Rate: [old] → [new]
- Confidence deltas: success=[+x.xx], failure=[-x.xx], partial=[+x.xx]
```

## Output
- Updated `memory/sona-config.json` with new learning rate and history
- Log entry in `logs/claude_log.md`

## Review Checklist
- [ ] At least 5 scoring events were available for accuracy calculation
- [ ] Accuracy was calculated from the correct window size
- [ ] Rate adjustment direction matches the accuracy range
- [ ] New rate is clamped within min/max bounds
- [ ] Configuration file is valid JSON after update
- [ ] Adjustment is logged with old and new values
