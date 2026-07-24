---
name: memory-consolidate
description: "Merge similar memories to reduce duplication and strengthen high-value entries. Triggers: 'consolidate memory', 'merge memories', 'deduplicate memory', 'clean up memory', 'memory maintenance'."
---

# Memory Consolidate Playbook

## When to Use
- Memory store has grown large with many similar entries
- Periodic maintenance (recommended: every 10 sessions)
- Before exporting memory for backup or migration
- When retrieval returns multiple near-identical results

## Prerequisites
- Memory directory structure exists: `memory/{patterns,preferences,errors,context}/`
- Each subdirectory has a populated `index.json`
- At least 5 entries exist in the target subdirectory

## Playbook

### 1. Load All Entries
- Read `index.json` from each subdirectory (or target subdirectory if specified)
- Load full JSON for every entry in scope
- Build an in-memory list of all entries with their tags and content

### 2. Compute Similarity Matrix
- For each pair of entries within the same type, compute tag overlap using Jaccard similarity
- Flag pairs where tag overlap exceeds 70% as merge candidates
- Secondary check: compare content strings for semantic similarity (keyword overlap > 50%)
- Group merge candidates into clusters (transitive closure of pairs)

### 3. Merge Clusters
- For each cluster of similar entries:
  - Select the entry with highest confidence as the primary
  - Merge tags from all entries into the primary (union of all tag sets)
  - Concatenate unique content from secondary entries into the primary
  - Set confidence to the maximum confidence value in the cluster
  - Set `usage_count` to the sum of all usage counts in the cluster
  - Set `last_used` to the most recent timestamp in the cluster
  - Preserve the original `created_at` from the oldest entry

### 4. Remove Merged Entries
- Delete the secondary entry JSON files from `memory/{type}/`
- Keep only the primary (merged) entry file
- Log each deletion with the entry id and merge target

### 5. Rebuild Indexes
- Regenerate `index.json` for each affected subdirectory
- Scan all remaining `.json` files in the directory (excluding index.json)
- Write fresh index sorted by `last_used` descending
- Verify entry count matches file count

### 6. Report Results
- Output consolidation summary: entries before, entries after, clusters merged
- List each merge with source entry ids and target entry id
- Log consolidation action to `logs/claude_log.md` with timestamp

## Output
- Consolidated memory entries with merged tags and content
- Cleaned `index.json` files with no orphaned references
- Consolidation report with before/after counts
- Log entry in `logs/claude_log.md`

## Review Checklist
- [ ] Tag overlap threshold of 70% applied correctly
- [ ] Highest confidence retained in merged entries
- [ ] Usage counts summed across merged entries
- [ ] Secondary entries deleted from disk
- [ ] Indexes rebuilt and verified against file count
- [ ] No data loss — all unique content preserved in merged entries
