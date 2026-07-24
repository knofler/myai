---
name: system-design
description: "Create system architecture design. Define components, interactions, communication patterns, and document decisions as ADRs. Triggers: system design, architecture, system architecture, how should we build, design system architecture"
---

# System Design Playbook

## 1. Gather Context

- Read `state/STATE.md` and `documentation/AI_RULES.md` for current project context and constraints.
- Identify the scope: new system, new service, or extension of existing architecture.
- Ask clarifying questions if the domain or scale is ambiguous.

## 2. Define Requirements

- List **functional requirements** (what the system must do).
- List **non-functional requirements** (performance, scalability, availability, security).
- Document constraints (budget, timeline, team size, existing tech stack).

## 3. Identify Components

- Break the system into logical components/services.
- Define each component's single responsibility.
- Identify shared libraries or cross-cutting concerns (auth, logging, config).

## 4. Design Component Interactions

- Map dependencies between components.
- Choose communication patterns for each interaction:
  - **Synchronous**: REST, GraphQL, gRPC.
  - **Asynchronous**: Event bus, message queues, webhooks.
- Define API contracts (request/response shapes, status codes).

## 5. Create Architecture Diagram

- Produce a text-based diagram (Mermaid or ASCII).
- Show components, data stores, external services, and data flow direction.
- Include a legend if symbols are non-obvious.

## 6. Document Decisions

- For each significant choice, create an ADR in `AI/architecture/`:
  - Title, Status, Context, Decision, Consequences.
- Reference the ADR from the architecture diagram.

## 7. Output

- Save the architecture document to `AI/architecture/`.
- Update `state/STATE.md` with the new architecture summary.
- Log the session in `logs/claude_log.md`.

## 8. Review Checklist

- [ ] All functional requirements addressed by at least one component.
- [ ] Non-functional requirements have explicit strategies (caching, replication, etc.).
- [ ] No circular dependencies between components.
- [ ] Communication patterns justified in ADRs.
- [ ] Diagram is readable and up to date.
