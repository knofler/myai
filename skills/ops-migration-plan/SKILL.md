---
name: ops-migration-plan
description: "Create migration plan with rollback strategy. Triggers: migration plan, data migration, database migration, rollback plan"
---
# Migration Plan Playbook

## When to Use
- Migrating data between databases or schemas
- Upgrading database versions or restructuring collections
- Moving services between environments or providers
- Any change requiring coordinated data movement with rollback safety

## Prerequisites
- Access to source and target environments
- Understanding of current data schema and volumes
- Backup strategy confirmed
- Maintenance window agreed with stakeholders

## Playbook

### 1. Pre-Migration Assessment
- Inventory all data sources, volumes, and dependencies
- Document current schema, indexes, and constraints
- Identify downstream consumers (APIs, reports, jobs)
- Estimate migration duration based on data volume
- Define success criteria and acceptable data loss threshold

### 2. Build Pre-Migration Checklist
- [ ] Full backup of source database completed and verified
- [ ] Target environment provisioned and accessible
- [ ] Migration scripts tested against staging data
- [ ] Rollback scripts tested and ready
- [ ] Monitoring and alerting configured
- [ ] Communication sent to stakeholders
- [ ] Maintenance window confirmed

### 3. Migration Steps
- Run pre-migration validation queries on source
- Execute migration in batches (define batch size based on volume)
- Log progress: records processed, errors encountered, elapsed time
- Pause and verify after each batch checkpoint

### 4. Data Verification
- Row count comparison: source vs target
- Checksum or hash comparison on critical fields
- Spot-check random samples across data segments
- Verify referential integrity and index correctness
- Run application smoke tests against migrated data

### 5. Rollback Triggers
- Error rate exceeds threshold (define: e.g., >0.1% failures)
- Migration duration exceeds 2x estimated window
- Data verification fails on critical fields
- Downstream services report errors post-cutover
- Stakeholder requests abort

### 6. Rollback Procedure
- Stop migration process immediately
- Restore from pre-migration backup
- Verify restored data integrity
- Re-enable original service connections
- Notify stakeholders of rollback and new timeline

### 7. Post-Migration Validation
- Full data verification suite passes
- Application integration tests pass
- Performance benchmarks meet baseline
- Monitoring confirms normal operation for 24 hours
- Decommission source (only after validation period)

## Output
- Migration plan document with timeline and owners
- Pre-migration checklist (completed)
- Migration scripts and rollback scripts
- Data verification report
- Post-migration sign-off record

## Review Checklist
- [ ] Backup verified and restorable before starting
- [ ] Rollback tested independently of migration
- [ ] Batch sizes tuned for acceptable duration
- [ ] All downstream consumers identified and notified
- [ ] Success criteria defined and measurable
- [ ] Post-migration monitoring in place for 24-48 hours
