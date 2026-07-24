---
name: swarm-merge-outputs
description: "Merge outputs from parallel agents into a coherent unified deliverable. Resolve conflicts, ensure consistency, remove duplicates, and validate the merged result. Triggers: merge, combine, unify, consolidate, assemble outputs"
---

# Swarm Merge Outputs Playbook

## When to Use
- Multiple agents have completed sub-tasks in parallel and their outputs must be combined
- After a mesh-topology execution where agents worked independently
- When assembling a final deliverable from a completed task tree

## Prerequisites
- All sub-tasks to be merged have status `done` in `state/task-tree.md`
- Each agent's output artifacts are accessible (files, code, documents)
- The original task description is available for validation

## Playbook

### 1. Inventory All Outputs
List every artifact produced by completed sub-tasks:
- Files created or modified (with paths)
- Schemas, API contracts, or configurations defined
- Documentation produced
- Test files written

### 2. Detect Conflicts
Scan for contradictions across agent outputs:

| Conflict Type | Detection Method |
|--------------|-----------------|
| **File conflicts** | Two agents modified the same file |
| **Schema conflicts** | Incompatible field names, types, or structures |
| **API conflicts** | Mismatched request/response contracts between frontend and API |
| **Style conflicts** | Inconsistent naming conventions, formatting, or patterns |
| **Logic conflicts** | Contradictory business logic in different modules |

For each conflict found, document the two positions and which agents produced them.

### 3. Resolve Conflicts
Apply resolution rules in order:
1. **Tech mandates win** — if one output follows `documentation/AI_RULES.md` and the other does not, use the compliant version
2. **Domain specialist wins** — the agent whose domain the conflict falls in takes precedence
3. **Existing patterns win** — the output consistent with the existing codebase takes precedence
4. **Simpler wins** — if all else is equal, choose the simpler approach
5. **Escalate** — if resolution is unclear, invoke `swarm-consensus`

### 4. Remove Duplicates
Identify duplicate work:
- Shared utility functions defined by multiple agents
- Identical type definitions or interfaces
- Repeated configuration entries

Keep one canonical version, remove duplicates, and ensure all references point to the canonical location.

### 5. Validate Consistency
After merging, verify:
- All imports and references resolve correctly
- API contracts match between frontend calls and backend handlers
- Database schemas match what the API layer expects
- Environment variables are consistent across all configurations
- No orphaned files or dead code from conflict resolution

### 6. Produce the Merged Deliverable
Assemble the final output:
- Apply all non-conflicting changes as-is
- Apply resolved conflicts using the winning version
- Run a consistency check across the merged files
- Document any manual follow-up needed

### 7. Log the Merge
Update `state/STATE.md`:
```
### Merge Report — [timestamp]
- Sub-tasks merged: [list of IDs]
- Conflicts found: [N] — all resolved
- Duplicates removed: [N]
- Manual follow-up: [list or "none"]
```

## Output
- Unified, conflict-free deliverable ready for review or deployment
- Merge report in `state/STATE.md`
- Updated `state/task-tree.md` marking the merge as complete

## Review Checklist
- [ ] All completed sub-task outputs were inventoried
- [ ] Conflicts were detected and resolved using the priority rules
- [ ] Duplicates were removed with references updated
- [ ] Cross-module consistency was validated (imports, contracts, schemas)
- [ ] Merge report is logged in STATE.md
