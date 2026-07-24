---
name: session-start
description: "Start a work session by reading project state, assessing status, identifying blockers, and determining next priority. Triggers: start session, session start, begin work, what should I work on, status check"
---

# Session Start

Bootstrap a work session with full project context.

## Playbook

### 0. Multi-Machine Check (MANDATORY)

This developer works across multiple machines via Dropbox. Stale Docker builds are the #1 issue.

- Run `hostname -s` to get the current machine name.
- Read `AI/state/AI_AGENT_HANDOFF.md` — check the `Last machine:` field.
- **If different machine** (or no machine recorded):
  1. Check for Dropbox conflict files: `find . -name "*conflicted*" 2>/dev/null | wc -l` — delete if found.
  2. Remove stale git locks: `rm -f .git/index.lock 2>/dev/null`
  3. Run `git fetch origin && git status` to check for divergence.
  4. **Rebuild Docker**: `docker compose down && docker compose up -d --build`
  5. Wait for healthy: `docker compose ps`
  6. Verify build: `docker compose exec app npx tsc --noEmit --pretty`
  7. Report to user: "Machine switch detected (X → Y). Docker rebuilt. Build verified."
- **If same machine**: Check for Dropbox conflicts only. Restart app container if session was closed with `docker compose stop`.
- See `AI/documentation/MULTI_MACHINE_WORKFLOW.md` for full details.

### 1. Read Project State

- Read `AI/state/STATE.md` for current project status.
- Read `AI/state/AI_AGENT_HANDOFF.md` for context from the previous session.
- Note the last update timestamp in each file.

### 2. Read Rules and Constraints

- Read `AI/documentation/AI_RULES.md` for tech mandates and constraints.
- Note any rules that affect today's planned work.

### 3. Assess Current Status

- List what was completed in the last session.
- List what is currently in progress.
- Identify any items marked as blocked.

### 4. Identify Blockers

- For each blocker, note the type: technical, dependency, or resource.
- Check if any blockers have been resolved since last session.
- Flag any new blockers discovered during state review.

### 5. Load SONA Context (Automatic)

- The SessionStart hook automatically runs `hooks/session/08-sona-context-load.sh`
- This sources `memory/lib/sona.sh` and loads relevant patterns based on STATE.md topics
- Review the SONA context output — it shows top matching patterns with confidence scores
- If patterns are relevant to today's work, keep them in mind:
  - **Error patterns**: Avoid the gotchas listed
  - **Workflow patterns**: Follow the proven steps
  - **Architecture patterns**: Apply the same approach
- If you reuse a pattern successfully, score it: `source memory/lib/sona.sh && sona_score_pattern <id> success`
- If a pattern doesn't apply or fails, score it: `source memory/lib/sona.sh && sona_score_pattern <id> failure`

### 6. Determine Next Priority

- Review the current milestone and its remaining deliverables.
- Pick the highest-priority unblocked item.
- If multiple items are equal priority, prefer the one on the critical path.

### 7. Output Session Briefing

Present a concise briefing to the user:

```
## Session Briefing — [date]

### Machine
- Current: [hostname]
- Last session: [hostname from handoff]
- Docker status: [rebuilt / restarted / already running]

### Last Session Summary
- ...

### Current Status
- In progress: ...
- Blocked: ...

### Today's Priority
1. [Top priority item]
2. [Secondary item]

### Blockers
- [blocker] — [proposed resolution]

### Relevant Rules
- [any documentation/AI_RULES.md constraints that apply]
```

Log session start to `logs/claude_log.md` with timestamp and hostname.
