---
name: neural-pattern-prune
description: "Remove stale or low-confidence patterns from the memory store. Consolidate similar patterns and rebuild the index. Triggers: prune patterns, clean memory, remove stale, consolidate patterns, memory cleanup"
---

# Neural Pattern Prune Playbook

## When to Use
- On a regular maintenance cadence (e.g., weekly or monthly)
- When the pattern store exceeds 50 entries and needs consolidation
- When `neural-pattern-score` flags a pattern with confidence < 0.1
- Before a major project milestone to ensure clean memory

## Prerequisites
- `memory/patterns/` directory contains pattern JSON files
- `memory/patterns/index.json` exists and is populated
- Current date is known for age calculations

## Playbook

### 1. Load All Patterns
Read `memory/patterns/index.json` and load full details from each `pat-*.json` file. Build a complete inventory:
- ID, name, tags, confidence, usage_count, last_used, created

### 2. Identify Candidates for Removal
A pattern is a **removal candidate** if ANY of these conditions are true:

| Condition | Threshold |
|-----------|-----------|
| Low confidence AND stale | confidence < 0.1 AND last_used > 90 days ago |
| Zero usage AND old | usage_count == 0 AND created > 60 days ago |
| High failure rate | failure_count > success_count AND usage_count >= 3 |
| Superseded | A newer pattern with the same tags has confidence > 0.7 |

### 3. Identify Candidates for Consolidation
Two patterns should be **consolidated** if:
- They share 80%+ of their tags
- Their approach descriptions are semantically similar
- They were extracted from similar task types

When consolidating:
- Keep the pattern with the higher confidence
- Merge unique tags and context keywords from both
- Sum usage counts
- Set confidence to the higher of the two
- Delete the lower-confidence duplicate

### 4. Review Before Deletion
Before deleting any pattern, produce a removal list:
```
## Patterns Flagged for Removal
| ID | Name | Reason | Confidence | Last Used |
|----|------|--------|-----------|-----------|
| pat-old-approach | ... | low confidence + stale | 0.05 | 2025-01-15 |
```

If running in interactive mode, present the list to the user for confirmation. If running as part of automated maintenance, proceed with deletion.

### 5. Execute Removals
For each confirmed removal:
1. Delete the `memory/patterns/pat-[slug].json` file
2. Remove the entry from `memory/patterns/index.json`

### 6. Execute Consolidations
For each consolidation pair:
1. Merge fields into the surviving pattern
2. Update the surviving pattern's JSON file
3. Delete the deprecated pattern's JSON file
4. Update `memory/patterns/index.json`

### 7. Rebuild the Index
After all removals and consolidations:
1. Scan `memory/patterns/` for all remaining `pat-*.json` files
2. Rebuild `memory/patterns/index.json` from scratch to ensure consistency
3. Validate that every index entry has a corresponding JSON file

### 8. Log the Pruning
Append to `logs/claude_log.md`:
```
### Memory Pruned — [timestamp]
- Patterns before: [N]
- Removed: [N] (low confidence: [N], stale: [N], superseded: [N])
- Consolidated: [N] pairs merged
- Patterns after: [N]
```

## Output
- Cleaned `memory/patterns/` directory with stale patterns removed
- Rebuilt `memory/patterns/index.json`
- Pruning report in `logs/claude_log.md`

## Review Checklist
- [ ] All removal candidates met at least one threshold condition
- [ ] Consolidation preserved the higher-confidence pattern
- [ ] No active, high-confidence patterns were accidentally removed
- [ ] Index was rebuilt from actual files, not from memory
- [ ] Pruning summary was logged with before/after counts
