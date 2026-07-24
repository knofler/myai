---
name: data-flow-diagram
description: "Create data flow diagrams. Identify external entities, processes, and data stores, then map data flows as Level 0 and Level 1 DFDs. Triggers: data flow, DFD, data flow diagram, how data moves, information flow"
---

# Data Flow Diagram Playbook

## 1. Define Scope

- Read `state/STATE.md` for current system context.
- Clarify which system or feature the DFD covers.
- Identify the boundary: what is inside vs outside the system.

## 2. Identify External Entities

- List actors that interact with the system (users, third-party APIs, cron jobs).
- Note the data each entity sends to or receives from the system.

## 3. Identify Processes

- List the major processes/transformations the system performs.
- Name each process with a verb-noun pattern (e.g., "Validate Order").
- Number each process for reference (1.0, 2.0, etc.).

## 4. Identify Data Stores

- List databases, file systems, caches, and queues.
- Name each store clearly (e.g., "User DB", "Order Queue").

## 5. Create Level 0 (Context Diagram)

- Single process bubble representing the entire system.
- Show all external entities and their data flows to/from the system.
- Use text-based or Mermaid format:

```
[User] --order request--> (System) --confirmation--> [User]
[Payment API] <--charge request-- (System)
```

## 6. Create Level 1 (Detail Diagram)

- Decompose the Level 0 process into sub-processes.
- Show data flows between sub-processes and data stores.
- Keep to 5-9 processes per diagram (cognitive limit).

## 7. Document and Save

- Save diagrams to `AI/architecture/` with descriptive filenames.
- Include a legend explaining notation.
- Update `state/STATE.md` with a reference to the new DFD.
- Log the session in `logs/claude_log.md`.

## 8. Review Checklist

- [ ] All external entities identified.
- [ ] Every data flow is labeled with its data content.
- [ ] Level 0 and Level 1 diagrams are consistent.
- [ ] No process has only inputs or only outputs.
- [ ] Data stores are accessed by at least one process.
