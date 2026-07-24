---
name: neural-context-build
description: "Assemble optimal context from the memory store for a specific task. Load patterns, preferences, and error history. Build a token-efficient context block for agent consumption. Triggers: build context, assemble context, enrich prompt, load memory, context for task"
---

# Neural Context Build Playbook

## When to Use
- At the start of any task to give the executing agent relevant historical context
- When dispatching sub-tasks via `swarm-dispatch` to enrich each agent's prompt
- When an agent encounters a problem and needs to check past solutions

## Prerequisites
- `memory/patterns/index.json` exists with stored patterns
- User preferences are available in `.claude/projects/*/memory/MEMORY.md`
- `state/STATE.md` contains recent task history
- The target task description is known

## Playbook

### 1. Define the Token Budget
Context must stay within a reasonable budget to avoid overwhelming the agent:
- **Small task** (single agent, single file): 500 tokens max
- **Medium task** (multi-file, single agent): 1000 tokens max
- **Large task** (multi-agent swarm): 1500 tokens max

### 2. Gather Context Sources
Collect context from four sources in priority order:

| Priority | Source | Content |
|----------|--------|---------|
| 1 (highest) | User preferences | From MEMORY.md — Docker-only, workflow prefs, project-specific rules |
| 2 | Matched patterns | Top-3 from `neural-pattern-match` for this task |
| 3 | Recent errors | Last 3 errors from the current project's logs |
| 4 (lowest) | State context | Current sprint, active work, recent completions from STATE.md |

### 3. Run Pattern Matching
Invoke `neural-pattern-match` with the current task keywords. Take the top 3 results (not top 5 — context budget is tighter here).

### 4. Extract Error History
Scan `logs/claude_log.md` for recent error entries related to the current task domain. Look for:
- Failed builds, test failures, deployment errors
- Patterns that previously failed (confidence decreases)
- User-reported issues

Extract the 3 most relevant errors with their root cause and resolution.

### 5. Assemble the Context Block
Build the context block in this format:

```
## Agent Context — [task summary]

### Preferences
- [Key preference 1]
- [Key preference 2]

### Relevant Patterns
1. **[Pattern name]** (confidence: [x.xx]): [one-line approach]
2. **[Pattern name]** (confidence: [x.xx]): [one-line approach]

### Recent Errors to Avoid
- [Error]: [root cause] → [resolution]

### Current State
- Sprint: [current sprint/milestone]
- Related completed work: [recent relevant tasks]
```

### 6. Trim to Token Budget
If the assembled block exceeds the token budget:
1. Remove state context first (lowest priority)
2. Reduce error history to 1 entry
3. Reduce patterns to top 1
4. Truncate preference list to top 3 items
5. Never remove user preferences entirely — they are highest priority

### 7. Inject into Agent Prompt
Prepend the context block to the agent's task description. Mark it clearly so the agent knows it is background context, not part of the task itself.

## Output
- A token-efficient context block tailored to the current task
- Context block formatted for direct injection into agent prompts

## Review Checklist
- [ ] Token budget was set appropriate to task size
- [ ] All four context sources were consulted
- [ ] User preferences were always included (highest priority)
- [ ] Context block stays within the token budget
- [ ] Error history is relevant to the current task domain
- [ ] Context is clearly labelled as background, not task instructions
