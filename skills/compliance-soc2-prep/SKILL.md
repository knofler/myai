---
name: compliance-soc2-prep
description: "SOC2 preparation. Access controls, change management, monitoring, incident response, vendor management, evidence collection. Triggers: SOC2, SOC 2, compliance prep, audit preparation, trust services criteria"
---
# SOC2 Preparation Playbook

## When to Use
- Preparing for a SOC2 Type I or Type II audit
- Establishing security controls for enterprise customers
- Building an evidence collection process for ongoing compliance
- Assessing current posture against Trust Services Criteria

## Prerequisites
- Management commitment to SOC2 compliance
- Inventory of systems, services, and data stores in scope
- Understanding of Trust Services Criteria (Security, Availability, Confidentiality, Processing Integrity, Privacy)
- Designated compliance owner or team

## Playbook

### 1. Define Scope
- Identify systems and services in scope for the audit
- Document system boundaries (infrastructure, applications, data)
- List Trust Services Criteria to include (Security is mandatory)
- Identify third-party services that are in scope
- Create a system description document

### 2. Access Controls (CC6)
- Implement role-based access control (RBAC) across all systems
- Enforce multi-factor authentication for all admin access
- Document user provisioning and de-provisioning procedures
- Conduct quarterly access reviews and document results
- Implement least-privilege principle for service accounts
- Evidence: access review logs, RBAC configuration, MFA enrollment records

### 3. Change Management (CC8)
- Document change management policy (request, review, approve, deploy)
- Require code review (PR approval) before merge to main
- Maintain CI/CD pipeline with automated tests before deploy
- Log all production changes with who, what, when, why
- Implement rollback procedures for failed deployments
- Evidence: PR history, CI/CD logs, deployment records, rollback logs

### 4. Monitoring and Logging (CC7)
- Centralize logs from all services (application, infrastructure, security)
- Implement real-time alerting for security events
- Monitor system availability and performance metrics
- Retain logs for minimum 12 months
- Enable audit trails for sensitive data access
- Evidence: monitoring dashboard, alert configurations, log retention policy

### 5. Incident Response (CC7.3-CC7.5)
- Document incident response plan with roles and escalation paths
- Define incident severity levels and response SLAs
- Conduct tabletop exercises quarterly
- Maintain incident log with root cause analysis
- Implement post-incident review process
- Evidence: IR plan, tabletop exercise records, incident logs, post-mortems

### 6. Vendor Management (CC9)
- Maintain inventory of all third-party vendors
- Assess vendor security posture (SOC2 reports, security questionnaires)
- Establish data processing agreements with all vendors
- Review vendor compliance annually
- Document vendor risk assessments
- Evidence: vendor inventory, DPAs, security assessments, review records

### 7. Risk Assessment (CC3)
- Conduct annual risk assessment
- Identify threats to each Trust Services Criteria
- Score risks by likelihood and impact
- Define and implement mitigating controls
- Track risk remediation to completion
- Evidence: risk register, assessment reports, remediation tracking

### 8. Evidence Collection Process
- Create evidence collection calendar (what, when, who)
- Automate evidence collection where possible (screenshots, exports)
- Store evidence in organized, auditor-accessible repository
- Label evidence by control ID and collection date
- Review evidence completeness monthly

## Output
- SOC2 readiness assessment report
- Control matrix mapping controls to Trust Services Criteria
- Evidence collection calendar and repository
- Policy documents (access control, change management, IR, vendor management)
- Gap analysis with remediation timeline

## Review Checklist
- [ ] Scope clearly defined with system boundaries
- [ ] Access controls enforce RBAC and MFA
- [ ] Change management requires PR review and CI/CD
- [ ] Monitoring covers security events with alerting
- [ ] Incident response plan documented and tested
- [ ] Vendor inventory complete with risk assessments
- [ ] Risk assessment conducted and remediation tracked
- [ ] Evidence collection automated where possible
