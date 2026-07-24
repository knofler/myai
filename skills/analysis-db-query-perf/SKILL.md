---
name: analysis-db-query-perf
description: "Review Mongoose queries for performance issues. Check for missing indexes, N+1 query patterns, unbounded finds, and suggest aggregation pipeline optimizations. Triggers: query performance, slow query, N+1, missing index, db optimization, mongoose performance"
---

# Database Query Performance Playbook

## When to Use

- API response times are slow and database is suspected
- MongoDB Atlas alerts on slow queries
- Before launching a feature with new database queries
- During periodic performance review

## Prerequisites

- Mongoose models and query code accessible
- MongoDB Atlas access for index review (or Compass)
- Understanding of the data model and collection sizes

## Playbook

### 1. Inventory All Queries

Scan the codebase for every Mongoose operation:
- `Model.find()`, `findOne()`, `findById()`
- `Model.aggregate()`
- `Model.updateOne()`, `updateMany()`
- `Model.deleteOne()`, `deleteMany()`
- `Model.countDocuments()`
- `Model.distinct()`

Record file path, line number, model name, and query pattern for each.

### 2. Check for N+1 Patterns

Look for queries inside loops or `.map()` / `.forEach()` calls:

```javascript
// BAD: N+1 pattern
const users = await User.find({});
for (const user of users) {
  const posts = await Post.find({ userId: user._id }); // N queries!
}
```

Flag every instance. Recommend `populate()` or `$lookup` aggregation instead.

### 3. Check for Missing Indexes

For each query, extract the filter fields and sort fields. Compare against the model's index definitions:
- Filter fields without indexes → full collection scan
- Sort fields without indexes → in-memory sort
- Compound queries needing compound indexes
- Text search without text indexes

Recommend specific indexes:

```javascript
schema.index({ userId: 1, createdAt: -1 });
```

### 4. Check for Unbounded Queries

Flag queries that could return unlimited results:
- `find()` without `.limit()`
- `find()` without `.select()` (fetching all fields)
- `find()` on large collections without pagination
- `aggregate()` without `$limit` stage

### 5. Check for Inefficient Patterns

- **Fetching then filtering in JS**: should use MongoDB `$match`
- **Multiple queries that could be one aggregation**: combine with `$lookup`
- **Using `find()` + manual grouping**: should use `$group`
- **Counting by fetching all docs**: should use `countDocuments()`
- **Not using `lean()`**: for read-only queries, skip Mongoose hydration

### 6. Review Aggregation Pipelines

For existing pipelines, check:
- `$match` should be the first stage (uses indexes)
- `$project` early to reduce document size in pipeline
- `$lookup` with `let` + `pipeline` for filtered joins
- Avoid `$unwind` on large arrays when `$filter` suffices

### 7. Produce Performance Report

| Query Location | Model | Pattern | Issue | Fix | Priority |
|---------------|-------|---------|-------|-----|----------|

Include estimated impact (collection size, query frequency, current latency).

## Output

- Query inventory with all database operations cataloged
- N+1 pattern list with refactoring recommendations
- Missing index list with exact index definitions to add
- Unbounded query list with pagination recommendations
- Aggregation optimization suggestions
- Priority-ranked fix list

## Review Checklist

- [ ] All Mongoose queries inventoried across the codebase
- [ ] N+1 patterns identified and alternatives proposed
- [ ] Index coverage verified for all filter and sort fields
- [ ] Unbounded queries flagged with limit/pagination fixes
- [ ] `lean()` recommended for read-only queries
- [ ] Aggregation pipelines reviewed for stage ordering
- [ ] Fixes prioritized by query frequency and collection size
