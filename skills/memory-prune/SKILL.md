---
name: memory-prune
description: "Remove expired or low-value memories and archive high-usage entries. Triggers: 'prune memory', 'clean memory', 'memory cleanup', 'remove stale memories', 'memory garbage collection'."
---

# Memory Prune Playbook

## When to Use
- Memory store has accumulated stale or low-confidence entries
- Periodic maintenance (recommended: every 20 sessions or monthly)
- Memory retrieval is returning too many irrelevant results
- Storage size needs to be reduced before export

## Prerequisites
- Memory directory structure exists: `memory/{patterns,preferences,errors,context}/`
- Archive directory exists or will be created: `memory/archive/`
- Each subdirectory has a populated `index.json`

## Playbook

### 1. Scan All Entries
- Load `index.json` from each subdirectory
- Load full JSON for every entry across all types
- Calculate age in days from `last_used` to current date
- Build a list with: id, type, confidence, last_used, usage_count, age_days

### 2. Identify Prune Candidates
- **Delete criteria**: confidence < 0.1 AND age_days > 90
- **Archive criteria**: age_days > 90 BUT usage_count > 10 (valuable but stale)
- **Keep criteria**: everything else remains untouched
- Separate entries into three buckets: delete, archive, keep

### 3. Archive High-Value Stale Entries
- Create `memory/archive/` directory if it does not exist
- Move archive-candidate JSON files to `memory/archive/{type}_{id}.json`
- Prepend `archived_at` timestamp and `original_type` to the archived entry
- Create or update `memory/archive/index.json` with archived entry references

### 4. Delete Low-Value Entries
- Remove delete-candidate JSON files from `memory/{type}/`
- Log each deletion: entry id, type, confidence, age, usage_count
- Do not delete entries that have been archived — verify before removal

### 5. Rebuild Indexes
- Regenerate `index.json` for each affected subdirectory
- Scan remaining `.json` files (excluding index.json) in each directory
- Write fresh indexes sorted by `last_used` descending
- Verify entry count matches file count per subdirectory

### 6. Report Results
- Output prune summary table:
  - Total entries scanned
  - Entries deleted (with avg confidence and avg age)
  - Entries archived (with avg usage_count)
  - Entries retained
- Log prune action to `logs/claude_log.md` with timestamp and counts

## Output
- Cleaned memory subdirectories with stale entries removed
- `memory/archive/` with high-value stale entries preserved
- Rebuilt `index.json` files for all affected subdirectories
- Prune report with counts and statistics
- Log entry in `logs/claude_log.md`

## Review Checklist
- [ ] Delete threshold applied: confidence < 0.1 AND last_used > 90 days
- [ ] High-usage entries archived, not deleted (usage_count > 10)
- [ ] Archive directory and index created/updated
- [ ] All indexes rebuilt and verified
- [ ] No accidental deletion of recently-used or high-confidence entries
- [ ] Prune action logged with counts and timestamp
