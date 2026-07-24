---
name: data-quality-rules
description: "Define data quality rules for completeness, consistency, accuracy, and timeliness. Triggers: data quality, validation rules, data integrity, data completeness, data accuracy"
---
# Data Quality Rules Playbook

## When to Use
- Defining validation rules for a new data model or pipeline
- Auditing existing data for quality issues
- Setting up automated data quality monitoring
- Preparing data for migration or integration

## Prerequisites
- Data model or schema defined
- Business rules documented (what constitutes valid data)
- Access to sample data for rule validation
- Understanding of downstream data consumers

## Playbook

### 1. Completeness Rules (Required Fields)
- Identify all mandatory fields per entity
- Define conditional requirements (field B required when field A = X)
- Set minimum population thresholds for optional fields (e.g., 80% of users should have phone)
- Flag records missing critical identifiers

### 2. Consistency Rules (Cross-Field Validation)
- Define field dependency rules (endDate > startDate)
- Validate referential integrity (referenced IDs exist)
- Check enumerated values match allowed sets
- Verify computed fields match their formula
- Cross-entity consistency (order total = sum of line items)

### 3. Accuracy Rules (Format and Range)
- Define format patterns (email regex, phone format, postal codes)
- Set numeric ranges (age 0-150, price > 0)
- Validate string lengths (name 1-100 chars)
- Check geographic coordinates within valid bounds
- Verify dates are within reasonable ranges (not in future for birthDate)

### 4. Timeliness Rules
- Define freshness requirements per dataset (updated within last 24h)
- Flag stale records that have not been updated within SLA
- Monitor data arrival times for pipeline inputs
- Alert when data latency exceeds threshold

### 5. Uniqueness Rules
- Identify natural keys and enforce uniqueness
- Detect duplicate records using fuzzy matching where appropriate
- Define deduplication strategy (keep newest, merge, flag for review)

### 6. Implement Validation Layer
- Add Mongoose schema validators for field-level rules
- Create middleware for cross-field validation
- Build a scheduled job for batch quality checks
- Output quality scores per entity and per field

### 7. Monitor and Report
- Create data quality dashboard with pass/fail rates
- Set up alerts for quality drops below threshold
- Generate weekly quality trend reports
- Track quality improvements over time

## Output
- Data quality rules document (completeness, consistency, accuracy, timeliness)
- Mongoose schema validators updated
- Validation middleware or service
- Quality monitoring configuration
- Quality score baseline report

## Review Checklist
- [ ] All mandatory fields identified and enforced
- [ ] Cross-field rules cover all business logic dependencies
- [ ] Format and range rules match real-world constraints
- [ ] Timeliness thresholds aligned with business SLAs
- [ ] Uniqueness rules prevent duplicates at insert time
- [ ] Monitoring alerts configured for quality drops
