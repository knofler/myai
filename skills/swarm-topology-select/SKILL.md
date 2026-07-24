---
name: swarm-topology-select
description: "Choose the optimal agent coordination topology for a task based on its characteristics. Topologies: hierarchical, mesh, ring, star. Triggers: topology, coordination, select topology, how to coordinate, agent layout"
---

# Swarm Topology Select Playbook

## When to Use
- Before dispatching a multi-agent task that involves 3 or more agents
- When the default hierarchical topology may not be optimal
- When a task has unusual coordination requirements (e.g., strict pipeline, full peer review)

## Prerequisites
- The task tree from `swarm-decompose` is available in `state/task-tree.md`
- Agent assignments and dependency graph are defined
- Task characteristics (scope, cross-cutting nature, review needs) are understood

## Playbook

### 1. Analyse Task Characteristics
Evaluate the task across four dimensions:

| Dimension | Question |
|-----------|----------|
| **Parallelism** | Can sub-tasks run independently, or are they tightly sequential? |
| **Cross-cutting** | Does the task touch many domains (frontend + API + DB + infra)? |
| **Review intensity** | Does each output need review before downstream tasks proceed? |
| **Pipeline nature** | Does output flow linearly from one agent to the next? |

### 2. Match to Topology
Use this decision matrix:

| Task Pattern | Best Topology | Example |
|-------------|--------------|---------|
| Standard feature (UI + API + DB) | **Hierarchical** | tech-lead coordinates, agents report up |
| Cross-cutting refactor (many files, many domains) | **Mesh** | all agents work simultaneously, peer sync |
| Document pipeline (spec → design → implement → test) | **Ring** | each agent passes output to the next |
| Audit or review (one reviewer, many targets) | **Star** | central agent reviews all others' output |
| Simple single-lane task | **None** | direct dispatch, no coordination overhead |

### 3. Configure Topology Parameters

**Hierarchical:**
- Coordinator: `tech-lead` (default) or `solution-architect`
- Review gate: every sub-task output reviewed before next dispatch
- Escalation: coordinator decides conflicts

**Mesh:**
- All agents see all other agents' outputs in real time
- No central coordinator — agents self-organise
- Conflict resolution via `swarm-consensus`

**Ring:**
- Define the agent order explicitly (e.g., product-manager → frontend → api → qa)
- Each agent receives predecessor's output as input
- No parallel execution — strictly sequential

**Star:**
- Central agent: typically `tech-lead`, `security-specialist`, or `solution-architect`
- All other agents submit to central for review
- Central agent can request revisions before accepting

### 4. Document the Selection
Record in `state/STATE.md`:
```
### Topology Selection — [timestamp]
- Task: [title]
- Selected topology: [hierarchical/mesh/ring/star]
- Rationale: [why this topology fits]
- Coordinator: [agent name, if applicable]
- Agent order: [if ring topology]
```

### 5. Pass to Swarm Dispatch
The selected topology informs how `swarm-dispatch` executes. Ensure the task tree in `state/task-tree.md` is annotated with the topology choice.

## Output
- Topology recommendation documented in `state/STATE.md`
- `state/task-tree.md` annotated with topology type and parameters

## Review Checklist
- [ ] All four task dimensions were evaluated before selecting topology
- [ ] The selected topology matches the decision matrix
- [ ] Coordinator agent is named (for hierarchical and star topologies)
- [ ] Ring order is defined (for ring topology)
- [ ] Selection is recorded in STATE.md with rationale
