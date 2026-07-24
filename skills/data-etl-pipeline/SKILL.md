---
name: data-etl-pipeline
description: "Design ETL/ELT pipeline with sources, transformations, scheduling, and monitoring. Triggers: ETL, ELT, data pipeline, data ingestion, data transformation"
---
# Data ETL Pipeline Playbook

## When to Use
- Ingesting data from external sources into your database
- Transforming data between formats or schemas
- Building recurring data sync between systems
- Migrating historical data with transformations

## Prerequisites
- Source and destination systems identified and accessible
- Data format and schema documentation for source
- Authentication credentials for source APIs or databases
- Target schema defined (use data-model-design skill first if needed)

## Playbook

### 1. Map Data Sources
- Document each source: type (API, CSV, database, webhook)
- Record connection details, auth method, rate limits
- Identify data volume and update frequency
- Note data format (JSON, CSV, XML, Parquet)

### 2. Design Extract Phase
- Define extraction method per source (full load, incremental, CDC)
- Implement pagination for large datasets
- Add retry logic with exponential backoff for API sources
- Store raw extracted data in staging (for auditability)

### 3. Design Transform Phase
- Map source fields to target schema (field mapping table)
- Define transformation rules: type casting, normalization, enrichment
- Handle missing/null values with default or skip strategy
- Implement data validation at transform boundary
- Log rejected records with reason codes

### 4. Design Load Phase
- Choose load strategy: upsert, append, replace
- Batch inserts for performance (define batch size)
- Maintain referential integrity during load
- Update indexes after bulk operations if needed

### 5. Configure Scheduling
- Define run frequency (real-time, hourly, daily, weekly)
- Use cron syntax or queue-based triggers
- Implement idempotency so re-runs are safe
- Add lock mechanism to prevent concurrent runs

### 6. Implement Error Handling
- Categorize errors: transient (retry) vs permanent (dead-letter)
- Set up dead-letter queue for failed records
- Define alerting thresholds (e.g., >5% failure rate)
- Implement circuit breaker for source unavailability

### 7. Add Monitoring
- Track records extracted, transformed, loaded per run
- Measure pipeline duration and throughput
- Alert on run failures, SLA breaches, data quality drops
- Dashboard with run history and success rates

## Output
- Pipeline architecture diagram
- Field mapping document (source to target)
- Pipeline scripts or job definitions
- Monitoring and alerting configuration
- Runbook for manual intervention scenarios

## Review Checklist
- [ ] All sources documented with auth and rate limits
- [ ] Incremental extraction implemented where possible
- [ ] Transform rules handle nulls and edge cases
- [ ] Pipeline is idempotent and safe to re-run
- [ ] Error handling covers transient and permanent failures
- [ ] Monitoring tracks volume, duration, and error rate
- [ ] Scheduling avoids peak-hour conflicts
