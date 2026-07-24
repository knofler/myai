---
name: data-analytics-query
description: "Build MongoDB aggregation pipelines for business metrics, dashboards, and KPIs with index optimization. Triggers: analytics query, business metrics, KPI query, dashboard query, reporting aggregation"
---
# Data Analytics Query Playbook

## When to Use
- Building dashboard queries for business metrics and KPIs
- Creating reporting aggregations for stakeholder visibility
- Optimizing slow analytical queries on MongoDB
- Designing data exports for business intelligence tools

## Prerequisites
- MongoDB collections with production-like data volume
- Business requirements defining the metrics needed
- Access to MongoDB Compass or Atlas for query profiling
- Understanding of collection schemas and indexes

## Playbook

### 1. Define Metrics Requirements
- List each metric: name, description, formula, granularity (daily/weekly/monthly)
- Identify dimensions for slicing (by user, by product, by region)
- Define time ranges and comparison periods (MoM, YoY)
- Confirm acceptable query latency (real-time vs batch)

### 2. Design Aggregation Pipeline
- Start with `$match` to filter early and reduce working set
- Use `$project` early to drop unneeded fields
- Apply `$group` for aggregation (sum, avg, count, min, max)
- Use `$lookup` sparingly for joins (prefer denormalized data)
- Add `$sort` and `$limit` for top-N queries
- Use `$facet` for multi-metric queries in a single pass

### 3. Optimize with Indexes
- Ensure `$match` fields have supporting indexes
- Create compound indexes matching `$match` + `$sort` order
- Use covered queries where possible (all fields in index)
- Check with `.explain("executionStats")` that index is used
- Consider partial indexes for filtered subsets

### 4. Handle Time-Series Patterns
- Use date bucketing with `$dateTrunc` or `$dateToString`
- Pre-aggregate into summary collections for historical data
- Implement materialized views for frequently-accessed metrics
- Schedule aggregation jobs for heavy computations

### 5. Build Dashboard Queries
- Create one aggregation per dashboard widget
- Return data in chart-ready format (labels + values arrays)
- Include comparison data (previous period) in same query
- Add `$addFields` for computed ratios and percentages

### 6. Test and Validate
- Verify results against known data points or manual calculations
- Test with production-scale data volumes
- Profile query performance: execution time, docs examined
- Ensure queries complete within latency budget

## Output
- Aggregation pipeline code per metric (JavaScript/Mongoose)
- Index definitions for supporting queries
- Query performance benchmark results
- Dashboard data contract (response shape per widget)

## Review Checklist
- [ ] All required metrics covered with correct formulas
- [ ] `$match` appears first in every pipeline for early filtering
- [ ] Supporting indexes created and verified with explain
- [ ] Query latency within acceptable threshold
- [ ] Time-series queries use date bucketing correctly
- [ ] Results validated against known data points
