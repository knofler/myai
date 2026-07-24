# Swarm Coordination System

> Multi-agent orchestration layer that sits ABOVE the existing 4-lane parallel dispatch system. Decomposes complex tasks, selects optimal topology, dispatches to specialists, and merges outputs.

## Architecture

```
User Task
    │
    ▼
┌─────────────────────────────────────────┐
│         swarm-coordinator               │
│                                         │
│  1. Decompose task into sub-tasks       │
│  2. Select topology                     │
│  3. Map sub-tasks to lanes/agents       │
│  4. Dispatch (parallel where possible)  │
│  5. Checkpoint every 3 sub-tasks        │
│  6. Merge outputs                       │
└─────────────────────────────────────────┘
    │           │           │           │
    ▼           ▼           ▼           ▼
 Lane A     Lane B      Lane C      Lane D
 Frontend   Backend     Infra       Async
 + UI/UX    + DB        + Security  + Docs/PM
```

## When to Use Swarm vs Direct Dispatch

| Scenario | Use |
|----------|-----|
| Single-agent task (e.g., "fix this bug") | Direct dispatch to specialist |
| Two-agent task (e.g., "add API + frontend page") | Sequential dispatch per MULTI_AGENT_ROUTING.md |
| **Three+ agents** or **cross-lane coordination** | **Swarm coordinator** |
| `agent mode` keyword | Always uses swarm coordinator |

## 4 Topologies

### 1. Hierarchical (Default for standard features)

```
        Coordinator
       /     |     \
   Lane A  Lane B  Lane C
   /   \    / \      |
  FE  UX  API DB   DevOps
```

**Best for:** Standard feature work with clear ownership boundaries.
**How it works:** Coordinator delegates to lane leads, who delegate to specialists. Output flows back up the tree.
**Select when:** Task maps cleanly to existing lanes, no cross-cutting concerns.

### 2. Mesh (For cross-cutting changes)

```
  FE ←→ API ←→ DB
  ↕      ↕      ↕
  UX ←→ DevOps ←→ Security
```

**Best for:** Refactors, migrations, and tasks where all agents need shared context.
**How it works:** Every agent can communicate with every other agent. Coordinator tracks global state.
**Select when:** Changes touch files across multiple lanes, or agents need each other's output in real-time.

### 3. Ring (For sequential pipeline work)

```
  Architect → DB → API → Frontend → QA → DevOps
      ↑                                      │
      └──────────────────────────────────────┘
```

**Best for:** End-to-end feature builds where each stage depends on the previous.
**How it works:** Each agent completes their work and passes output to the next in the ring.
**Select when:** Schema → API → Frontend → Tests pipeline, or any sequential dependency chain.

### 4. Star (For independent parallel work)

```
         Coordinator
        /  |  |  |  \
      A1  A2  A3  A4  A5
```

**Best for:** Batch operations where many agents do independent work.
**How it works:** Coordinator dispatches all sub-tasks simultaneously. No inter-agent communication. Merge at the end.
**Select when:** Updating docs across repos, running audits, scaffolding multiple components.

## Topology Selection Guide

```
Is the task sequential (each step depends on previous)?
  YES → Ring topology
  NO  ↓

Does it touch 3+ lanes with shared files?
  YES → Mesh topology
  NO  ↓

Are all sub-tasks independent (no shared state)?
  YES → Star topology
  NO  → Hierarchical topology (default)
```

## Swarm Lifecycle

### 1. Decompose (`/swarm-decompose`)

Break the task into sub-tasks:

```json
{
  "task": "Add user authentication with JWT",
  "sub_tasks": [
    {"id": "st-1", "title": "Design auth schema", "agent": "database-specialist", "lane": "B", "depends_on": []},
    {"id": "st-2", "title": "Implement auth middleware", "agent": "api-specialist", "lane": "B", "depends_on": ["st-1"]},
    {"id": "st-3", "title": "Create login/register pages", "agent": "frontend-specialist", "lane": "A", "depends_on": ["st-2"]},
    {"id": "st-4", "title": "Security review", "agent": "security-specialist", "lane": "C", "depends_on": ["st-2"]},
    {"id": "st-5", "title": "Write auth tests", "agent": "qa-specialist", "lane": "cross", "depends_on": ["st-2", "st-3"]}
  ],
  "topology": "hierarchical",
  "parallel_groups": [
    ["st-1"],
    ["st-2"],
    ["st-3", "st-4"],
    ["st-5"]
  ]
}
```

### 2. Dispatch (`/swarm-dispatch`)

Execute sub-tasks respecting dependencies:
- Group 1: `st-1` (schema) — sequential, must complete first
- Group 2: `st-2` (middleware) — depends on st-1
- Group 3: `st-3` + `st-4` in parallel — both depend on st-2, no shared files
- Group 4: `st-5` (tests) — depends on st-2 + st-3

### 3. Checkpoint (`/swarm-checkpoint`)

After every 3 completed sub-tasks:
- Re-read the original task description
- Compare completed work against requirements
- Calculate drift score (0-100)
- If drift > 30: pause and alert
- If drift <= 30: continue

### 4. Progress Track (`/swarm-progress-track`)

```
Swarm Status: 3/5 sub-tasks complete (60%)

| # | Sub-task | Agent | Status | Notes |
|---|----------|-------|--------|-------|
| 1 | Auth schema | database-specialist | Done | User model updated |
| 2 | Auth middleware | api-specialist | Done | JWT + bcrypt |
| 3 | Login pages | frontend-specialist | In Progress | 70% complete |
| 4 | Security review | security-specialist | Done | No issues |
| 5 | Auth tests | qa-specialist | Blocked | Waiting for st-3 |
```

### 5. Consensus (`/swarm-consensus`)

When agents produce conflicting outputs:
- Collect both positions with evidence
- Weight by agent expertise (security-specialist > frontend-specialist on auth)
- Require 2/3 agreement for contested changes
- Escalate to user if no consensus

### 6. Merge (`/swarm-merge-outputs`)

Combine outputs from all sub-tasks:
- Check for file conflicts (two agents editing same file)
- Resolve conflicts using agent priority or consensus
- Validate merged result builds/passes tests
- Produce unified deliverable

## Integration with Existing Lanes

The swarm system does NOT replace lanes — it orchestrates them:

| Lane | Agents | Swarm Role |
|------|--------|-----------|
| A (Frontend) | frontend-specialist + ui-ux-specialist | Receive sub-tasks for UI work |
| B (Backend) | api-specialist + database-specialist | Receive sub-tasks for API/DB work |
| C (Infra) | devops-specialist + security-specialist | Receive sub-tasks for infra/security |
| D (Async) | docs, architect, PM, BA, project-mgr | Always parallel, never block |
| Cross-Lane | tech-lead + qa-specialist | Review + test across all lanes |

## Integration with `agent mode` Keyword

When user types `agent mode`, the coordinator:

1. Reads state + handoff + AI_RULES
2. Identifies the current priority from STATE.md
3. **Decomposes** the priority into sub-tasks
4. **Selects topology** based on task characteristics
5. **Dispatches** to specialist agents via lanes
6. **Checkpoints** after every 3 sub-tasks
7. **Merges** outputs and updates state
8. Reports to user

## Swarm Agents (7)

| Agent | Role |
|-------|------|
| `swarm-coordinator` | Master orchestrator — decompose, dispatch, track |
| `swarm-hierarchical` | Tree-structured delegation through lane leads |
| `swarm-mesh` | Peer-to-peer for cross-cutting changes |
| `swarm-adaptive` | Analyzes task and auto-selects best topology |
| `swarm-byzantine` | Resolves conflicting agent outputs (2/3 vote) |
| `swarm-raft` | Leader election for contested shared state |
| `swarm-gossip` | Eventual consistency for non-critical state sync |

## Swarm Skills (8)

| Skill | Trigger |
|-------|---------|
| `swarm-decompose` | Break task into sub-tasks with dependency graph |
| `swarm-dispatch` | Assign and execute sub-tasks by topology |
| `swarm-checkpoint` | Anti-drift validation against original requirements |
| `swarm-consensus` | Resolve agent disagreements via weighted voting |
| `swarm-topology-select` | Choose optimal topology for task characteristics |
| `swarm-progress-track` | Status dashboard across all sub-tasks |
| `swarm-escalate` | Unblock stuck sub-tasks |
| `swarm-merge-outputs` | Combine parallel outputs into unified deliverable |

## Anti-Drift Protocol

The swarm system prevents scope creep through:

1. **Task hash**: Original task description is hashed at decomposition time
2. **Checkpoint interval**: Every 3 sub-tasks, re-read the original and score drift
3. **Drift scoring**: Compare completed work against requirements (0-100 scale)
4. **Threshold**: Drift > 30 = pause, drift > 50 = alert user, drift > 70 = rollback
5. **Output validation**: Final merge validates all sub-tasks map back to the original task

## Quick Reference

```bash
# Decompose a task
/swarm-decompose

# Select topology
/swarm-topology-select

# Dispatch sub-tasks
/swarm-dispatch

# Check progress
/swarm-progress-track

# Checkpoint for drift
/swarm-checkpoint

# Resolve conflicts
/swarm-consensus

# Escalate blockers
/swarm-escalate

# Merge final outputs
/swarm-merge-outputs
```
