---
name: seed-data
description: "Create seed data for development and testing — realistic fixtures, idempotent runs, npm scripts. Triggers: 'seed', 'test data', 'sample data', 'mock data', 'fixtures'."
---

# Seed Data

Create seed data scripts that populate MongoDB with realistic development and testing data.

## Tech Stack

- MongoDB (Docker locally, Atlas in production)
- Mongoose ODM
- Node.js

## Playbook

### Step 1 — Identify Required Collections

- List every collection that needs seed data.
- Note dependencies between collections (e.g., `orders` reference `users`).
- Determine the insertion order to satisfy foreign key references.
- Decide on record counts: enough to be useful, small enough to run fast (10-50 per collection is typical).

### Step 2 — Create Seed Script with Realistic Data

- Place the script in `src/seeds/seed.js` (or per-collection files in `src/seeds/`).
- Use realistic but obviously fake data (e.g., `jane.doe@example.com`, not production emails).
- Generate ObjectIds deterministically so references are stable across runs.
- Include edge cases: empty arrays, null optional fields, maximum-length strings.

```js
// Template
const mongoose = require('mongoose');
const User = require('../models/User');

const users = [
  { _id: new mongoose.Types.ObjectId('aaaaaaaaaaaaaaaaaaaaaaaa'), name: 'Jane Doe', email: 'jane@example.com' },
  { _id: new mongoose.Types.ObjectId('bbbbbbbbbbbbbbbbbbbbbbbb'), name: 'John Smith', email: 'john@example.com' },
];

module.exports = { users };
```

### Step 3 — Support Idempotent Runs

- Before inserting, drop or clear the target collections: `await User.deleteMany({});`.
- Use `insertMany` with `{ ordered: true }` so failures stop early.
- Guard the script so it refuses to run against a production URI (check `MONGODB_URI` for `localhost` or `mongo` hostname).
- Print a summary after completion: number of documents inserted per collection.

### Step 4 — Add NPM Script Command

- Add to `package.json`:
  ```json
  "scripts": {
    "seed": "node src/seeds/seed.js",
    "seed:fresh": "node src/seeds/seed.js --fresh"
  }
  ```
- If the project uses Python, add an equivalent entry in `Makefile` or a CLI command.
- Ensure the script connects to MongoDB, runs seeds in dependency order, then disconnects.

### Step 5 — Document Seed Data Structure

- Add a comment block or a `src/seeds/README.md` listing collections, record counts, and notable test scenarios.
- Note any deterministic ObjectIds so other developers can use them in tests.
- Update `state/STATE.md` to reflect available seed data.

## Checklist

- [ ] All referenced collections seeded in correct dependency order.
- [ ] Data is realistic but obviously non-production.
- [ ] Script is idempotent (safe to run repeatedly).
- [ ] Production-safety guard in place.
- [ ] NPM script or Makefile command added.
- [ ] state/STATE.md updated.
