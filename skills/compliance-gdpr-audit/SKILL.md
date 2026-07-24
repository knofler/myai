---
name: compliance-gdpr-audit
description: "GDPR compliance checklist. Data inventory, consent, right to erasure, processing agreements, breach notification. Triggers: GDPR, data privacy, data protection, privacy audit, personal data compliance"
---
# GDPR Compliance Audit Playbook

## When to Use
- Launching a product that handles EU user data
- Auditing an existing application for GDPR compliance
- Preparing for a data protection impact assessment (DPIA)
- Responding to a data subject access request (DSAR)

## Prerequisites
- Access to the codebase and database schemas
- List of all data collection points (forms, APIs, tracking)
- Understanding of data flows between services and third parties
- Legal or DPO guidance on organizational obligations

## Playbook

### 1. Data Inventory
- Catalog all personal data collected (name, email, IP, cookies, etc.)
- Document where each data point is stored (database, logs, analytics, third-party)
- Identify the lawful basis for each data point (consent, contract, legitimate interest)
- Map data flows: collection -> processing -> storage -> sharing -> deletion
- Classify data sensitivity (standard PII vs special category data)

### 2. Consent Management
- Verify consent is collected before processing (not pre-checked boxes)
- Ensure consent is granular (separate consent per purpose)
- Confirm consent is freely given (service not conditional on consent)
- Implement consent withdrawal mechanism (as easy as giving consent)
- Store consent records with timestamp, version, and scope

### 3. Right to Access (Article 15)
- Build endpoint or process to export all user data on request
- Include data from all storage locations (DB, logs, backups, third parties)
- Deliver in a machine-readable format (JSON or CSV)
- Response within 30 days of request
- Verify requester identity before fulfilling

### 4. Right to Erasure (Article 17)
- Implement user deletion that removes data from all locations
- Handle cascading deletes across related collections
- Address data in backups (mark for exclusion on restore)
- Notify third-party processors to delete shared data
- Log deletion for compliance records (without retaining deleted data)

### 5. Data Processing Agreements
- Identify all third-party processors (analytics, email, hosting, CDN)
- Verify DPA is in place with each processor
- Document what data is shared with each processor and why
- Ensure processors provide adequate security measures
- Review processor compliance annually

### 6. Data Minimization and Retention
- Collect only data necessary for the stated purpose
- Define retention periods per data category
- Implement automated deletion when retention period expires
- Remove unnecessary fields from API responses
- Anonymize data used for analytics where possible

### 7. Breach Notification (Article 33-34)
- Define what constitutes a personal data breach
- Establish 72-hour notification process to supervisory authority
- Prepare notification template with required information
- Define criteria for notifying affected individuals
- Document incident response procedure and contacts

### 8. Technical Measures
- Encrypt personal data at rest and in transit
- Implement access controls (principle of least privilege)
- Enable audit logging for personal data access
- Pseudonymize data where full identification is unnecessary
- Regular security testing of data handling components

## Output
- GDPR compliance audit report with findings
- Data inventory spreadsheet
- Gap analysis with remediation tasks (prioritized)
- Data processing agreement checklist
- Breach notification template and procedure

## Review Checklist
- [ ] All personal data identified and cataloged
- [ ] Lawful basis documented for each processing activity
- [ ] Consent mechanism meets GDPR requirements
- [ ] Right to access and erasure implemented and tested
- [ ] DPAs in place with all third-party processors
- [ ] Retention periods defined and automated
- [ ] Breach notification procedure documented and tested
- [ ] Technical measures (encryption, access control, logging) verified
