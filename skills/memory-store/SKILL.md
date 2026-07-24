---
name: memory-store
description: "Persist a new memory entry with validation, deduplication, and indexing. Triggers: 'store memory', 'save memory', 'remember this', 'persist memory', 'add memory entry'."
---

# Memory Store Playbook

## When to Use
- Agent needs to persist a learning, preference, error pattern, or context for future sessions
- A new pattern or preference has been identified during work
- Error resolution should be remembered to avoid repeating investigation

## Prerequisites
- Memory directory structure exists: `memory/{patterns,preferences,errors,context}/`
- Each subdirectory has an `index.json` catalog file
- Entry must have: id, type, tags, content, confidence (0.0-1.0)

## Playbook

### 1. Validate Entry Format
- Confirm required fields: `id` (UUID), `type` (pattern|preference|error|context), `tags` (string[]), `content` (string), `confidence` (float 0.0-1.0)
- Reject entries missing any required field — log validation error
- Auto-generate `id` if not provided (use timestamp-based UUID)
- Set `created_at` and `last_used` to current ISO timestamp
- Set `usage_count` to 1

### 2. Check for Duplicates
- Load `index.json` from the target subdirectory (`memory/{type}/`)
- Compare incoming tags against existing entries using Jaccard similarity
- If tag overlap > 80% AND content similarity > 70%, flag as duplicate
- On duplicate: update existing entry confidence (take max), merge any new tags, increment `usage_count`, update `last_used` — skip creating new file

### 3. Write Entry File
- Filename: `memory/{type}/{id}.json`
- Structure: `{ id, type, tags, content, confidence, created_at, last_used, usage_count, source_session }`
- Include `source_session` with current session identifier for traceability

### 4. Update Index
- Read `memory/{type}/index.json`
- Append new entry reference: `{ id, tags, confidence, created_at, last_used }`
- Sort index by `last_used` descending
- Write updated index back

### 5. Confirm Storage
- Read back the written file to verify integrity
- Log storage action to `logs/claude_log.md` with entry id and type

## Output
- `memory/{type}/{id}.json` — the persisted memory entry
- Updated `memory/{type}/index.json` — catalog with new entry
- Log entry in `logs/claude_log.md`

## Review Checklist
- [ ] All required fields present and correctly typed
- [ ] Duplicate check performed before writing
- [ ] Confidence value is between 0.0 and 1.0
- [ ] Index.json updated and sorted
- [ ] File written and verified by read-back
- [ ] Storage action logged with timestamp
