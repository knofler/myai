---
name: security-threat-model
description: "Threat modeling using STRIDE. Identify assets, threats, risk scoring, and mitigations. Triggers: threat model, STRIDE, threat analysis, risk assessment, attack surface, threat modeling"
---
# Threat Modeling (STRIDE) Playbook

## When to Use
- Designing a new system or major feature with security implications
- Reviewing an existing system's attack surface
- Preparing for a security audit or compliance review
- After a security incident to reassess the threat landscape

## Prerequisites
- System architecture diagram (or build one first)
- Data flow diagrams showing trust boundaries
- List of system components, interfaces, and data stores
- Understanding of user roles and access levels

## Playbook

### 1. Identify Assets
- List all valuable assets: user data, credentials, API keys, business logic
- Identify data classifications: public, internal, confidential, restricted
- Map where each asset is stored, processed, and transmitted
- Prioritize assets by business impact if compromised

### 2. Map Attack Surface
- Identify all entry points: web UI, API endpoints, webhooks, admin panels
- Document trust boundaries: client/server, service/service, internal/external
- List all data flows crossing trust boundaries
- Identify third-party integrations and their access level
- Create a data flow diagram with trust boundary annotations

### 3. Apply STRIDE Per Component
For each component crossing a trust boundary, assess:

- **Spoofing** (Authentication): Can an attacker pretend to be another user or service?
  - Weak authentication, missing MFA, session hijacking, token theft
- **Tampering** (Integrity): Can an attacker modify data in transit or at rest?
  - Man-in-the-middle, SQL injection, parameter tampering, unsigned data
- **Repudiation** (Non-repudiation): Can an attacker deny performing an action?
  - Missing audit logs, unsigned transactions, no timestamp verification
- **Information Disclosure** (Confidentiality): Can an attacker access unauthorized data?
  - Verbose errors, insecure API responses, missing encryption, log leakage
- **Denial of Service** (Availability): Can an attacker make the system unavailable?
  - Missing rate limits, resource exhaustion, unprotected endpoints
- **Elevation of Privilege** (Authorization): Can an attacker gain higher access?
  - Broken access control, IDOR, privilege escalation, missing role checks

### 4. Score Risks
For each identified threat, assign:
- **Likelihood**: Low (1), Medium (2), High (3)
- **Impact**: Low (1), Medium (2), High (3)
- **Risk Score**: Likelihood x Impact (1-9)
- **Priority**: Critical (7-9), High (5-6), Medium (3-4), Low (1-2)

### 5. Define Mitigations
For each threat, specify:
- Mitigation strategy (prevent, detect, respond, accept)
- Specific technical control to implement
- Owner responsible for implementation
- Implementation timeline based on risk priority
- Verification method to confirm mitigation effectiveness

### 6. Document Threat Model
- Create a threat model document with:
  - System overview and architecture diagram
  - Trust boundary diagram
  - STRIDE analysis table per component
  - Risk scoring matrix
  - Mitigation plan with owners and timelines
- Store in `documentation/` or as an ADR

### 7. Review and Update
- Review threat model when architecture changes
- Reassess after security incidents
- Update risk scores based on new threat intelligence
- Schedule annual threat model review

## Output
- Threat model document with STRIDE analysis
- Trust boundary diagram (Mermaid)
- Risk scoring matrix (sorted by priority)
- Mitigation plan with implementation timeline
- ADR documenting key security decisions

## Review Checklist
- [ ] All components crossing trust boundaries analyzed
- [ ] All six STRIDE categories assessed per component
- [ ] Risk scores assigned with consistent criteria
- [ ] Mitigations defined for all High and Critical risks
- [ ] Mitigation owners and timelines assigned
- [ ] Trust boundary diagram is current and accurate
- [ ] Threat model scheduled for periodic review
