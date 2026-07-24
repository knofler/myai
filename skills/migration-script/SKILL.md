---
name: migration-script
description: "Create database migration scripts — up/down functions, data transformation, Docker-local testing. Triggers: 'migration', 'schema change', 'data migration', 'database update'."
---

# Migration Script

Create safe, reversible database migration scripts for MongoDB schema changes.

## Tech Stack

- MongoDB (Atlas in production, Docker locally)
- Mongoose ODM
- Docker Compose for local MongoDB

## Playbook

### Step 1 — Identify the Schema Change

- Describe what is changing: new field, renamed field, removed field, index change, data reshape.
- Determine if existing documents need transformation or if the change is additive-only.
- Check if the change is backward-compatible with the current application code.

### Step 2 — Write the Migration Script (Up / Down)

- Create file: `src/migrations/<timestamp>-<description>.js` (e.g., `20260305-add-status-to-orders.js`).
- Export two async functions: `up(db)` and `down(db)`.
- `up` applies the change: `db.collection('orders').updateMany(...)`.
- `down` reverses it: restore previous field values, drop added indexes, etc.
- Use bulk operations (`bulkWrite`) for large datasets to avoid timeouts.
- Wrap operations in a try/catch and log progress.

```js
// Template
module.exports = {
  async up(db) {
    await db.collection('orders').updateMany(
      { status: { $exists: false } },
      { $set: { status: 'pending' } }
    );
  },
  async down(db) {
    await db.collection('orders').updateMany(
      { status: 'pending' },
      { $unset: { status: '' } }
    );
  },
};
```

### Step 3 — Handle Data Transformation

- For field renames: copy data to new field, verify, then unset old field.
- For type changes: cast values explicitly; handle nulls and edge cases.
- For large collections: use cursor-based iteration with batch size to control memory.
- Never drop a collection in `up` — archive or rename instead.

### Step 4 — Test on Local Docker MongoDB

- Start local MongoDB: `docker compose up -d mongo`.
- Seed with representative data (use `seed-data` skill if needed).
- Run the migration: `node src/migrations/<file>.js up`.
- Verify with a quick query or count check.
- Run rollback: `node src/migrations/<file>.js down`.
- Confirm data is restored to pre-migration state.

### Step 5 — Document in Changelog

- Add an entry to the project changelog or `state/STATE.md` describing the migration.
- Note any manual steps required (e.g., Atlas index builds).
- Record the migration order if multiple migrations are pending.
- Update `state/AI_AGENT_HANDOFF.md` if the migration affects other agents' work.

## Checklist

- [ ] `up` and `down` functions both implemented.
- [ ] Bulk operations used for large collections.
- [ ] Tested locally against Docker MongoDB.
- [ ] Rollback verified.
- [ ] Changelog / state/STATE.md updated.
