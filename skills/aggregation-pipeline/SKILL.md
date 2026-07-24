---
name: aggregation-pipeline
description: "Build MongoDB aggregation pipelines — $match, $group, $lookup, $project, index optimization. Triggers: 'aggregation', 'pipeline', 'complex query', '$group', '$lookup', 'reporting query'."
---

# Aggregation Pipeline

Build and optimize MongoDB aggregation pipelines for complex queries and reporting.

## Tech Stack

- MongoDB (Atlas in production, Docker locally)
- Mongoose ODM
- Node.js

## Playbook

### Step 1 — Define Query Requirements

- Clarify the business question: What data is needed and in what shape?
- Identify input filters (date range, status, user ID, etc.).
- Determine the expected output structure (flat document, nested groups, counts, sums).
- Note performance targets: acceptable response time, expected data volume.

### Step 2 — Build Pipeline Stages

- Start with `$match` to filter early and reduce the working set.
- Use `$lookup` for joins; prefer `pipeline` sub-queries over simple `localField/foreignField` when you need to filter or project the joined data.
- Use `$unwind` after `$lookup` only when you need to flatten arrays for grouping.
- Use `$group` for aggregation: `$sum`, `$avg`, `$min`, `$max`, `$push`, `$addToSet`.
- Use `$project` or `$addFields` to reshape output.
- Use `$sort` and `$limit` at the end for pagination or top-N queries.

```js
// Template
const pipeline = [
  { $match: { status: 'completed', createdAt: { $gte: startDate, $lte: endDate } } },
  { $group: { _id: '$category', total: { $sum: '$amount' }, count: { $sum: 1 } } },
  { $sort: { total: -1 } },
  { $limit: 10 },
];

const results = await Order.aggregate(pipeline);
```

### Step 3 — Optimize with Indexes

- Ensure a compound index exists that covers the `$match` stage fields.
- Place `$match` and `$sort` as early as possible to leverage indexes.
- Use `explain('executionStats')` to verify index usage and scan counts.
- For `$lookup`, ensure the foreign collection has an index on the join field.
- Avoid `$unwind` on large arrays when `$filter` or `$reduce` can achieve the same result.

### Step 4 — Add to Service Layer

- Place the pipeline in a service function, not directly in a route handler.
- File location: `src/services/<domain>Service.js` (e.g., `src/services/reportService.js`).
- Accept filter parameters as function arguments; build `$match` dynamically.
- Return plain objects (aggregation already returns POJOs, not Mongoose documents).
- Add JSDoc describing parameters, return shape, and example usage.

### Step 5 — Test with Sample Data

- Use the `seed-data` skill to populate test collections.
- Write a test that seeds known data, runs the pipeline, and asserts on counts/sums.
- Test edge cases: empty result set, single document, null fields in grouped data.
- For performance-sensitive pipelines, test against a larger dataset (1k-10k docs) and log execution time.

## Checklist

- [ ] `$match` is the first stage (or as early as possible).
- [ ] Supporting indexes created and verified with `explain()`.
- [ ] Pipeline lives in the service layer, not in route handlers.
- [ ] Output shape matches the consumer's expectation.
- [ ] Tests cover happy path and edge cases.
- [ ] state/STATE.md updated if a new reporting capability was added.
