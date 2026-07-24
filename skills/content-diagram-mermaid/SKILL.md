---
name: content-diagram-mermaid
description: "Generate Mermaid diagrams from code or docs. Sequence, flowchart, ER, state, class diagrams. Triggers: Mermaid diagram, sequence diagram, flowchart, ER diagram, state diagram, class diagram"
---
# Mermaid Diagram Generation Playbook

## When to Use
- Visualizing system architecture or component interactions
- Documenting API request flows as sequence diagrams
- Creating ER diagrams from database schemas
- Mapping state machines or workflow logic
- Adding visual context to technical documentation

## Prerequisites
- Source material: code, docs, or verbal description of the system
- Understanding of which diagram type best communicates the concept
- Target location for the diagram (README, ADR, technical doc)

## Playbook

### 1. Choose Diagram Type
- **Flowchart** (`graph TD/LR`): Decision trees, process flows, architecture overview
- **Sequence** (`sequenceDiagram`): API calls, request lifecycle, multi-service interactions
- **ER** (`erDiagram`): Database schemas, entity relationships
- **State** (`stateDiagram-v2`): Workflow states, lifecycle management
- **Class** (`classDiagram`): Object models, service interfaces
- **Gantt** (`gantt`): Project timelines, milestone planning

### 2. Gather Information
- Read relevant source code (routes, models, services)
- Identify actors, components, or entities to include
- Map the interactions, transitions, or relationships
- Determine the level of detail (high-level vs detailed)

### 3. Build the Diagram
- Start with the diagram type declaration
- Add nodes/participants with clear, short labels
- Define connections with appropriate arrow types
- Add labels to connections describing the interaction
- Group related elements with subgraphs where helpful

### 4. Apply Styling
- Use consistent node shapes (rounded for services, square for data stores)
- Apply directional flow: top-down for hierarchies, left-right for sequences
- Keep labels concise (3-5 words max)
- Limit diagram to 10-15 nodes for readability
- Split into multiple diagrams if complexity requires it

### 5. Validate Rendering
- Verify syntax renders correctly in GitHub Markdown
- Check that all connections are visible and not overlapping
- Ensure labels are readable at normal zoom level
- Test in Mermaid Live Editor if unsure about syntax

### 6. Embed in Documentation
- Place diagram in a fenced code block with `mermaid` language tag
- Add a brief caption above or below explaining what the diagram shows
- Cross-reference the diagram from related documentation
- Keep diagram source in the same file as the documentation

## Output
- Mermaid diagram code block embedded in Markdown
- Caption describing the diagram's purpose
- Updated documentation file with diagram

## Review Checklist
- [ ] Diagram type matches the concept being communicated
- [ ] All relevant actors/components included
- [ ] Labels are concise and clear
- [ ] Diagram renders correctly in GitHub Markdown
- [ ] Complexity is manageable (split if needed)
- [ ] Caption provided for context
