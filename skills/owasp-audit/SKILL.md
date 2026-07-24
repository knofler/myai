---
name: owasp-audit
description: "Perform an OWASP Top 10 security audit — check injection, broken auth, data exposure, XSS, access control, misconfigurations, and known vulnerabilities. Triggers: OWASP, security audit, vulnerability scan, security review, penetration test"
---

# OWASP Audit

Perform a security audit based on the OWASP Top 10 vulnerability categories.

## Playbook

### 1. A01 — Broken Access Control

- Verify all endpoints enforce authorization middleware.
- Check for IDOR (users accessing others' resources).
- Confirm CORS is restricted and RBAC applied consistently.

### 2. A02 — Cryptographic Failures

- Passwords hashed with bcrypt (12+ rounds).
- JWTs use 256-bit+ secrets. HTTPS enforced (HSTS).
- No sensitive data in logs, URLs, or error messages.

### 3. A03 — Injection

- NoSQL: use Mongoose validation, avoid `$where` and raw queries.
- SQL: parameterized queries or ORM only.
- Command: no `exec()`/`eval()` with user input.

### 4. A04 — Insecure Design

- Review data flows for trust boundary violations.
- Rate limiting on login/registration. Business logic enforced server-side.

### 5. A05 — Security Misconfiguration

- Debug mode off in production. Default credentials changed.
- Unnecessary endpoints removed. `helmet.js` configured.

### 6. A06 — Vulnerable Components

- Run `npm audit` for critical/high findings.
- Check `npm outdated`. Set up Dependabot or Renovate.

### 7. A07 — Authentication Failures

- Strong password policy. Account lockout after failed attempts.
- Session tokens invalidated on logout. Token rotation in place.

### 8. A08 — Data Integrity Failures

- CI/CD pipeline integrity verified. Dependencies pinned.
- Deserialized data from untrusted sources validated.

### 9. A09 — Logging and Monitoring Failures

- Auth events logged. No sensitive data in logs.
- Alerting configured for suspicious activity.

### 10. A10 — SSRF

- Whitelist URLs fetched server-side. Block internal/private IPs.

### 11. Document findings

- Create findings table: category, severity, description, remediation.
- Prioritize critical/high first. Update `state/STATE.md`.
