---
name: schema-design
description: "Design MongoDB schemas — Mongoose models with validation, indexes, relationships. Triggers: 'schema', 'model', 'data model', 'collection design', 'Mongoose schema'."
---

# Schema Design

Design MongoDB schemas with Mongoose, including validation, indexes, and relationship strategies.

## Tech Stack

- MongoDB (Atlas in production, Docker locally)
- Mongoose ODM
- Node.js

## Playbook

### Step 1 — Gather Data Requirements

- Identify the entity and its attributes (field names, types, constraints).
- Clarify access patterns: What queries will run most often?
- Determine cardinality: one-to-few, one-to-many, one-to-millions.
- Note any fields that require uniqueness, full-text search, or TTL.

### Step 2 — Identify Relationships (Embed vs Reference)

- **Embed** when: data is read together, cardinality is low, updates are infrequent.
- **Reference** when: data is shared across collections, cardinality is high, or documents would exceed 16 MB.
- Use `populate()` for referenced documents; avoid deep nesting beyond 2 levels.
- Document the decision rationale in a code comment or ADR.

### Step 3 — Define Schema with Types, Validation, and Indexes

- Use explicit Mongoose types (`String`, `Number`, `ObjectId`, `Date`, `Boolean`, `[SubSchema]`).
- Add `required`, `enum`, `minlength`, `maxlength`, `min`, `max`, `match` validators as needed.
- Define compound indexes for frequent query patterns.
- Add unique indexes where business rules demand it.
- Use sparse indexes for optional unique fields.

### Step 4 — Create Model File

- Place the file in `src/models/<EntityName>.js` (or `.ts`).
- Export the model as a named export: `module.exports = mongoose.model('EntityName', entitySchema);`.
- Keep one model per file.

### Step 5 — Add Timestamps and Virtuals

- Enable `{ timestamps: true }` for automatic `createdAt` / `updatedAt`.
- Add virtuals for computed fields (e.g., `fullName` from `firstName` + `lastName`).
- Set `toJSON: { virtuals: true }` and `toObject: { virtuals: true }` in schema options.

### Step 6 — Document Schema Decisions

- Add a JSDoc block at the top of the model file describing the collection purpose.
- Note embedding/referencing decisions and why.
- If the schema is non-trivial, add an entry to `architecture/` as an ADR.
- Update `state/STATE.md` with the new or modified model.

## Checklist

- [ ] All fields have explicit types and required validators where appropriate.
- [ ] Indexes match the most common query patterns.
- [ ] Embed vs reference decision is documented.
- [ ] Timestamps enabled.
- [ ] Model file lives in `src/models/`.
- [ ] state/STATE.md updated.
