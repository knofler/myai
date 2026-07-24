---
name: data-model-design
description: "Design data model with ERD, entities, relationships, and Mongoose schemas. Triggers: data model, ERD, entity relationship, model design, domain model"
---
# Data Model Design Playbook

## When to Use
- Starting a new project that needs a database schema
- Adding a major feature requiring new entities or relationships
- Refactoring an existing data model for performance or clarity
- Documenting an existing schema with a visual ERD

## Prerequisites
- Business requirements or feature spec available
- Target database identified (MongoDB assumed by default)
- Understanding of read/write patterns and query needs

## Playbook

### 1. Identify Entities
- List all domain objects from requirements (e.g., User, Order, Product)
- For each entity, list core attributes with types
- Identify which fields are required vs optional
- Mark unique fields and natural keys

### 2. Define Relationships
- Map relationships between entities: one-to-one, one-to-many, many-to-many
- Decide embedding vs referencing for each relationship (MongoDB)
- Embedding: data accessed together, bounded size, no independent queries
- Referencing: large/unbounded arrays, independent access, shared across entities

### 3. Apply Normalization Rules
- Eliminate data duplication where practical
- Denormalize intentionally for read performance (document the trade-off)
- Identify computed/derived fields and their refresh strategy

### 4. Generate Mermaid ER Diagram
- Create an `erDiagram` block with all entities and relationships
- Use standard cardinality notation: `||--o{`, `}o--||`, etc.
- Include key attributes on each entity
- Place diagram in documentation or ADR

### 5. Write Mongoose Schemas
- Create a schema file per entity in `models/` directory
- Add field-level validation (required, enum, min/max, regex)
- Define indexes for query patterns (compound, unique, sparse)
- Add timestamps (`createdAt`, `updatedAt`)
- Include virtual fields and instance methods where appropriate

### 6. Define Seed Data
- Create realistic sample documents for each entity
- Ensure referential integrity across seed data
- Include edge cases (empty arrays, optional fields missing)

## Output
- Mermaid ER diagram in documentation
- Mongoose schema files in `models/`
- Seed data script or fixtures
- Data model ADR documenting key decisions

## Review Checklist
- [ ] All entities from requirements are represented
- [ ] Relationships match business rules (cardinality correct)
- [ ] Embedding vs referencing decisions documented with rationale
- [ ] Indexes defined for all frequent query patterns
- [ ] Validation rules match business constraints
- [ ] Seed data covers happy path and edge cases
