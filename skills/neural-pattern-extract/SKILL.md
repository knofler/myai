---
name: neural-pattern-extract
description: "Extract reusable patterns from a completed task. Identify approach, tools used, what worked, and produce structured pattern JSON with tags and confidence scoring. Triggers: extract pattern, learn from task, capture pattern, what worked, save approach"
---

# Neural Pattern Extract Playbook

## When to Use
- A task has been completed successfully and the approach should be remembered
- A novel solution was used that may apply to future tasks
- After a session where a non-obvious technique solved a problem effectively

## Prerequisites
- The completed task and its outputs are available for review
- The `memory/patterns/` directory exists (create if not)
- `memory/patterns/index.json` exists for pattern indexing (create if not)

## Playbook

### 1. Review the Completed Task
Read the task description, the approach taken, and the final output. Identify:
- **What was the problem?** — the specific challenge or requirement
- **What approach was used?** — the technique, tool, or pattern applied
- **What made it work?** — the key insight or decision that led to success
- **What was reusable?** — which parts generalize beyond this specific task

### 2. Identify Pattern Boundaries
A good pattern is:
- **Generalizable** — applies to more than just this one task
- **Concrete** — includes enough detail to replicate
- **Scoped** — focused on one technique, not an entire workflow
- **Distinct** — not already captured by an existing pattern

Check `memory/patterns/index.json` for existing patterns. If this approach is already captured, skip extraction and instead update the existing pattern's `usage_count` via `neural-pattern-score`.

### 3. Structure the Pattern
Create a pattern JSON file at `memory/patterns/pat-[slug].json`:

```json
{
  "id": "pat-[slug]",
  "name": "[Human-readable pattern name]",
  "description": "[One-sentence description of when and how to use this pattern]",
  "tags": ["tag1", "tag2", "tag3"],
  "context_keywords": ["keyword1", "keyword2", "keyword3"],
  "approach": "[Step-by-step description of the approach]",
  "tools_used": ["tool1", "tool2"],
  "agents_involved": ["agent1", "agent2"],
  "confidence": 0.5,
  "usage_count": 1,
  "success_count": 1,
  "failure_count": 0,
  "created": "[ISO timestamp]",
  "last_used": "[ISO timestamp]",
  "source_task": "[Brief description of the task this was extracted from]"
}
```

### 4. Assign Tags and Keywords
Tags should be broad categories: `["api", "error-handling", "performance"]`
Context keywords should be specific terms that would appear in a similar task: `["timeout", "retry", "exponential-backoff"]`

Aim for 3-5 tags and 3-8 context keywords per pattern.

### 5. Set Initial Confidence
New patterns always start at confidence `0.5` (neutral). Confidence adjusts over time:
- Successful reuse: +0.05 per use (via `neural-pattern-score`)
- Failed reuse: -0.10 per failure
- Range: 0.0 to 1.0

### 6. Update the Index
Add an entry to `memory/patterns/index.json`:
```json
{
  "id": "pat-[slug]",
  "name": "[name]",
  "tags": ["tag1", "tag2"],
  "confidence": 0.5,
  "last_used": "[ISO timestamp]"
}
```

### 7. Log Extraction
Append to `logs/claude_log.md`:
```
### Pattern Extracted — [timestamp]
- Pattern: [name] (pat-[slug])
- Source: [task description]
- Tags: [tag list]
- Confidence: 0.5 (initial)
```

## Output
- `memory/patterns/pat-[slug].json` — the structured pattern file
- Updated `memory/patterns/index.json` with the new entry
- Log entry in `logs/claude_log.md`

## Review Checklist
- [ ] Pattern is generalizable beyond the source task
- [ ] Pattern does not duplicate an existing entry in the index
- [ ] Tags and context keywords are relevant and specific
- [ ] Confidence is set to 0.5 for new patterns
- [ ] Index file is updated and valid JSON
- [ ] Extraction is logged with timestamp
