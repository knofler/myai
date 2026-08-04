# Bug Bounty Program — myAI

> Standing, paid vulnerability-research program. Distinct from the passive
> disclosure channel in `SECURITY.md` §7 (which stays open for anyone who
> just wants to report something with no expectation of payment) — this is
> the incentivized, triaged, paid track enterprises expect from a mature
> security posture. One intake surface, two programs: reporters select which
> one they're submitting under.

---

## 1. Scope

### In scope

| Component | Examples of qualifying issues |
|---|---|
| Gateway REST/MCP API (`:3100`, `:3200`, `:3201`) | Auth bypass, tenant-isolation break (`scopedFind` escape, ADR-010), timing side-channel on API-key compare, SSRF via a gateway-initiated request |
| Dashboard web app (`:3210`) | Stored/reflected XSS with demonstrated impact, CSRF on a state-changing route, auth/session flaw, IDOR across tenants |
| Webhook verification | HMAC bypass or replay on `GITHUB_WEBHOOK_SECRET` / `CONNECT_WEBHOOK_SECRET` verification |
| Memory export / context bundle redaction (`scripts/myai_memory.sh`, `scripts/myai_context.sh`) | A secret pattern that should be redacted but ships live in an export bundle |
| Always-on safety hooks (`hooks/pre-tool/01,03,04,05,16-*.sh`) | A reproducible bypass of the push-to-main block, secret-scan, protected-files guard, or workspace-gateway-deploy guard |
| Default Docker Compose configuration as shipped | A default-config flaw that exposes a service beyond `127.0.0.1` when `HOST_BIND` is left at its documented default |
| CLI/setup scripts run with elevated trust (`init_ai.sh`, `update_all.sh`, `scripts/init_connect.sh`) | Command/argument injection, path traversal, arbitrary file write outside the target project |

### Out of scope

- Anything already listed as **out of scope in the threat model** (`SECURITY.md` §4): a hostile local user on the same machine, supply-chain compromise of upstream npm/base images, secrets a user pastes into chat with a cloud LLM they configured themselves.
- Vulnerabilities in third-party dependencies with no demonstrated myAI-specific exploit path — report those upstream (we'll still credit a heads-up).
- Denial-of-service via request/traffic volume, resource exhaustion, or rate-limit saturation — this is a self-hosted, local-first system; the blast radius is the reporter's own box.
- Missing security headers, best-practice nits, or theoretical weaknesses with no working proof of concept — these are welcome as **informational** feedback but are not paid.
- Findings that require a user's own misconfiguration beyond the documented defaults (e.g., they set `HOST_BIND=0.0.0.0` and exposed Mongo on their LAN — that trade-off is documented, not a vulnerability).
- Social engineering, physical access attacks, or testing against any installation you don't own or have written permission to test.
- Automated scanner output with no manual verification or reproduction steps.
- Duplicate reports (see §5).

---

## 2. Severity tiers & payout

Severity is scored against impact and exploitability (CVSS-v3.1-informed, not a mechanical score). Payouts are **per unique, valid, in-scope report** and are set by maintainer judgment within the ranges below — a plausible-but-low-impact Critical-class bug pays toward the bottom of its band; a wormable, no-interaction Critical pays the top.

| Tier | CVSS band | Example | Payout |
|---|---|---|---|
| **Critical** | 9.0–10.0 | Unauthenticated RCE on gateway/dashboard; auth bypass reading/writing another tenant's memory corpus; a secret-scan bypass that ships a live credential in an export bundle | **$500 – $1,500** |
| **High** | 7.0–8.9 | Cross-tenant data read requiring some auth; webhook signature bypass; stored XSS leading to session hijack; timing side-channel that recovers an API key | **$200 – $500** |
| **Medium** | 4.0–6.9 | CSRF on a state-changing route; rate-limit bypass; reflected XSS requiring interaction; non-secret info disclosure via verbose errors/logs | **$75 – $200** |
| **Low** | 0.1–3.9 | Minor info disclosure with a working PoC; a hardening gap with demonstrated (not theoretical) impact | **$25 – $75**, or credit-only at reporter's option |
| **Informational** | — | Best-practice suggestions, defense-in-depth ideas, missing headers with no demonstrated impact | Credit only — folds into the `SECURITY.md` §6 hardening checklist |

**Program funding:** payouts draw from a maintainer-funded pool refreshed each quarter. If a quarter's pool is exhausted, a valid report is still acknowledged, triaged, fixed, and credited on the normal timeline — payout is deferred to the next quarter's pool rather than refused.

---

## 3. Safe harbor

We consider security research conducted under this policy to be **authorized**:

- Authorized against **your own self-hosted myAI instance** or a lab environment you control, within the scope in §1.
- We will not pursue legal action, and will not report you to law enforcement, for good-faith research that:
  - stays within scope,
  - avoids privacy violations, data destruction, or service interruption to anyone other than your own test instance,
  - stops at proof-of-impact (don't exfiltrate more data than needed to demonstrate the issue, don't pivot into other systems),
  - gives us a reasonable window to fix the issue before any public disclosure (§6), and
  - does not test against another user's hosted instance without that user's explicit written consent.
- If a third party's legal action is threatened over research that met the conditions above, we will state publicly that the research was authorized.
- This safe harbor does **not** extend to testing that violates the law in ways outside our ability to authorize (e.g., accessing a third party's infrastructure without their consent) — myAI can only authorize testing against myAI-controlled or reporter-controlled scope.

This is a good-faith, self-issued safe harbor (in the spirit of [disclose.io](https://disclose.io)), not a substitute for legal advice.

---

## 4. Submission — shared intake, program selector

Submissions go through the **same intake channel** as passive disclosure (`SECURITY.md` §7): GitHub Security Advisories on [`knofler/myai`](https://github.com/knofler/myai/security/advisories/new) — the public repo external reporters can reach (the private `knofler/ai_management` is **not** a valid external intake). What changes for the bounty track:

- **Advisory title prefix:** `[BUG-BOUNTY]` (vs. plain `[SECURITY]` for the passive track) — this is the routing signal until the intake form (tracked separately, not this task) exists with a native program selector.
- **Required fields:** affected component (from the §1 in-scope table), reproduction steps, impact, a self-assessed severity tier (§2) with justification, and preferred payout method (see §5).
- Once the standalone security.txt / intake-form task lands, it should surface a `program: responsible-disclosure | bug-bounty` field and pass it through unchanged into the same triage flow below — this doc is the schema those fields should satisfy.

---

## 5. Triage → payout workflow

```
Submit (GitHub Security Advisory, [BUG-BOUNTY] title prefix)
   │
   ▼
New ── security-specialist creates a tracked task (tag: security-bounty,
   │    severity: unscored) in the gateway task queue — same queue that
   │    drives every other autonomous unit of work in this framework.
   ▼
Triage (ack ≤ 72h, verdict ≤ 7 days — matches SECURITY.md §7 targets)
   │  security-specialist reproduces in an isolated environment, scores
   │  severity per §2, and resolves to one of:
   ├─→ Not applicable — out of scope, invalid, or a duplicate of an
   │   earlier report (first valid report wins; duplicates get credit,
   │   no payout) → reporter notified with reason, task closed.
   ├─→ Informational — real but non-payable (§2) → credited in
   │   SECURITY.md §6 hardening checklist, task closed.
   └─→ Accepted — valid, in-scope, severity assigned → continue below.
   ▼
Fix — a normal priority task (P0 for Critical, P1 for High, P2/P3 below)
   │  goes through the standard `ship it` flow: test branch → CI →
   │  PR → main. The bounty task tracks the fix task's PR number.
   ▼
Payout — triggered on fix merge to main (Critical/High may pay on
   │       confirmed-valid if a fix will take materially longer, at
   │       maintainer discretion) — paid within 30 days via the
   │       reporter's chosen method (bank transfer / PayPal / crypto),
   │       subject to program-pool availability (§2).
   ▼
Disclosure — coordinated: a public GitHub Security Advisory is
            published once the fix has shipped, or 90 days from the
            original report, whichever comes first. Reporter may
            co-author the advisory and is credited by name (or stays
            anonymous on request).
```

**SLA summary:** acknowledgement 72h · triage verdict 7 days · fix timeline follows existing severity-based targets in `SECURITY.md` §7 (critical: as fast as possible; confirmed issues: 30 days) · payout within 30 days of a merged fix (or confirmed-valid, for Critical/High at maintainer discretion) · disclosure within 90 days of report or on fix-ship, whichever is first.

---

## 6. Relationship to the passive disclosure channel

`SECURITY.md` §7 remains the always-open, no-payment-expected reporting path for anyone who finds an issue and just wants it fixed responsibly. This program is additive: the **same intake**, a **paid, triaged, SLA-bound track** for in-scope findings. `SECURITY.md` §7 should link here rather than duplicate scope/payout detail, so the two never drift out of sync.

---

*Maintained by the security-specialist lane. Changes to scope, payout tiers, or the triage workflow MUST update this file in the same PR — the program is only as credible as its documented terms.*

*Last updated: 2026-07-18.*
