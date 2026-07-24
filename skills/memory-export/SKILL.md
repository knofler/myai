---
name: memory-export
description: "Export memory store for backup or migration, with import capability for restoring. Triggers: 'export memory', 'backup memory', 'memory dump', 'migrate memory', 'import memory'."
---

# Memory Export Playbook

## When to Use
- Creating a backup of the memory store before major changes
- Migrating memory between projects or machines
- Sharing learned patterns across managed repositories
- Restoring memory from a previous backup after data loss

## Prerequisites
- Memory directory structure exists: `memory/{patterns,preferences,errors,context}/`
- Each subdirectory has a populated `index.json`
- Write access to the export destination directory

## Playbook

### 1. Inventory Current Store
- Scan all memory subdirectories: patterns, preferences, errors, context, archive
- Count entries per subdirectory by reading each `index.json`
- Calculate total confidence score (sum of all entry confidences)
- Record total file sizes for the export metadata

### 2. Build Export Package
- Create a single JSON export object with this structure:
  ```
  {
    "metadata": { "exported_at", "source_project", "entry_counts", "total_confidence", "version" },
    "patterns": [ ...all pattern entries... ],
    "preferences": [ ...all preference entries... ],
    "errors": [ ...all error entries... ],
    "context": [ ...all context entries... ],
    "archive": [ ...all archived entries... ]
  }
  ```
- Load every entry JSON file from each subdirectory
- Include the full entry object (not just index references)
- Set `version` to "1.0" for format compatibility tracking

### 3. Write Export File
- Default export path: `memory/exports/memory_export_{YYYYMMDD_HHmmss}.json`
- Create `memory/exports/` directory if it does not exist
- Write the JSON with 2-space indentation for readability
- Calculate and append SHA256 checksum as `metadata.checksum`

### 4. Verify Export Integrity
- Read the exported file back
- Parse JSON and verify all sections are present
- Compare entry counts against the inventory from step 1
- Confirm checksum matches

### 5. Import (Restore) Procedure
- When restoring: read the export JSON file
- For each entry in each section, check for existing entry by id
- If entry exists: skip (or overwrite if `--force` flag set)
- If entry is new: write to appropriate `memory/{type}/{id}.json`
- Rebuild all `index.json` files after import
- Log import action with counts: imported, skipped, overwritten

### 6. Report
- Output export/import summary: file path, entry counts per type, total size
- Log action to `logs/claude_log.md` with timestamp

## Output
- `memory/exports/memory_export_{timestamp}.json` — full memory dump
- Integrity verification result (pass/fail)
- Export/import summary with per-type counts
- Log entry in `logs/claude_log.md`

## Review Checklist
- [ ] All subdirectories included in export (patterns, preferences, errors, context, archive)
- [ ] Full entry objects exported, not just index references
- [ ] Metadata includes export date, counts, and checksum
- [ ] Export file verified by read-back and count comparison
- [ ] Import handles duplicates gracefully (skip or overwrite)
- [ ] Indexes rebuilt after import
