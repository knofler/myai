---
name: security-pen-test-plan
description: "Plan penetration testing scope, targets, tools, rules of engagement, and remediation tracking. Triggers: pen test, penetration test, pentest plan, security testing plan, vulnerability assessment"
---
# Penetration Test Plan Playbook

## When to Use
- Preparing for a scheduled security assessment
- Onboarding a third-party pen testing firm
- Conducting internal security testing before a release
- Validating remediation of previously found vulnerabilities

## Prerequisites
- Inventory of systems, endpoints, and infrastructure in scope
- Authorization from system owners (written approval)
- Test environment available (or production with safeguards)
- Understanding of compliance requirements driving the test

## Playbook

### 1. Define Scope and Objectives
- List target systems: web applications, APIs, infrastructure, mobile
- Define in-scope URLs, IP ranges, and endpoints
- Explicitly list out-of-scope systems (third-party, production DB)
- State objectives: find vulnerabilities, validate controls, compliance requirement
- Define test type: black box, grey box, or white box

### 2. Establish Rules of Engagement
- Define testing window (dates, hours, timezone)
- Set boundaries: no denial-of-service, no data destruction, no social engineering (unless agreed)
- Establish communication channels for emergencies
- Define escalation process if critical vulnerability found during testing
- Agree on data handling: how test data and findings are stored and shared
- Get written authorization signed by system owner

### 3. Select Test Types
- **Network**: Port scanning, service enumeration, firewall testing
- **Web Application**: OWASP Top 10, authentication bypass, injection, XSS
- **API**: Authentication, authorization, input validation, rate limiting
- **Infrastructure**: Cloud configuration, container security, secrets exposure
- **Social Engineering**: Phishing simulation, pretexting (if in scope)

### 4. Define Tools and Methodology
- Reconnaissance: Nmap, Shodan, Amass, WHOIS
- Web scanning: Burp Suite, OWASP ZAP, Nikto
- Exploitation: Metasploit, custom scripts
- API testing: Postman, custom scripts, Burp Suite
- Credential testing: Hydra, custom wordlists
- Follow a methodology: OWASP Testing Guide, PTES, NIST SP 800-115

### 5. Execute Testing Phases
- **Reconnaissance**: Gather information about targets passively and actively
- **Scanning**: Identify open ports, services, and potential vulnerabilities
- **Exploitation**: Attempt to exploit identified vulnerabilities
- **Post-exploitation**: Assess impact, lateral movement potential
- **Documentation**: Record every finding with evidence as you go

### 6. Report Findings
- For each finding: title, severity (Critical/High/Medium/Low/Info), CVSS score
- Include: description, affected component, reproduction steps, evidence (screenshots)
- Provide remediation recommendation for each finding
- Executive summary for non-technical stakeholders
- Include positive findings (controls that worked)

### 7. Remediation Tracking
- Create a remediation ticket per finding with assigned owner
- Set remediation SLAs by severity: Critical (48h), High (1 week), Medium (30 days), Low (90 days)
- Schedule retest after remediation to verify fix
- Track remediation status in a dashboard
- Close findings only after successful retest

## Output
- Pen test plan document with scope, RoE, and methodology
- Written authorization from system owners
- Findings report with severity ratings and remediation steps
- Remediation tracking spreadsheet or ticket list
- Retest report confirming fixes

## Review Checklist
- [ ] Written authorization obtained before testing begins
- [ ] Scope clearly defines in-scope and out-of-scope targets
- [ ] Rules of engagement agreed and signed by all parties
- [ ] Testing methodology aligns with industry standards
- [ ] All findings documented with reproduction steps and evidence
- [ ] Remediation SLAs assigned based on severity
- [ ] Retest scheduled for all Critical and High findings
