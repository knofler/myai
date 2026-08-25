/**
 * Legal documents + click-wrap consent (launch-blocking legal pack).
 *
 * Serves the end-user Terms of Service, Privacy Policy, and Acceptable Use
 * Policy as VERSIONED MARKDOWN, and records per-tenant acceptance (version +
 * timestamp + who clicked) at signup and on re-consent. Distinct from the B2B
 * compliance pack (/dpa, /subprocessors — data-processing terms a procurement
 * team reads): this is the click-wrap every self-serve signup agrees to.
 *
 * Copy is env-driven:
 *  - LEGAL_DOCS_DIR      — directory of operator-supplied <slug>.md files
 *                          (frontmatter: version/title/updated) that override
 *                          the built-in defaults below. Bumping `version` in a
 *                          file is what triggers the dashboard re-consent
 *                          prompt for every tenant that accepted an older one.
 *  - LEGAL_APP_NAME / LEGAL_COMPANY_NAME / LEGAL_CONTACT_EMAIL — substituted
 *                          into {{APP_NAME}} / {{COMPANY_NAME}} /
 *                          {{CONTACT_EMAIL}} placeholders in the copy.
 *  - LEGAL_CONSENT_REQUIRED=1 — makes /api/auth/signup REJECT a request that
 *                          doesn't carry acceptTerms:true (hosted posture).
 *                          Default off so self-hosted deploys and existing
 *                          API clients are unaffected; when off, consent is
 *                          still RECORDED whenever the signup UI sends it.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { LegalConsentModel } from '../shared/db.js';
import { getLogger } from '../shared/logger.js';
import { AuthError } from './tenant-context.js';

const log = getLogger().child({ module: 'legal' });

export const LEGAL_SLUGS = ['terms', 'privacy', 'acceptable-use'] as const;
export type LegalSlug = (typeof LEGAL_SLUGS)[number];

export interface LegalDoc {
  slug: LegalSlug;
  title: string;
  /** Opaque version string (semver or date) — equality against the recorded
   *  consent is what decides whether a tenant must re-consent. */
  version: string;
  /** Human-readable last-updated date shown on the page. */
  updated: string;
  markdown: string;
}

export interface LegalVersions {
  terms: string;
  privacy: string;
  acceptableUse: string;
}

export function isConsentRequired(): boolean {
  return process.env.LEGAL_CONSENT_REQUIRED === '1' || process.env.LEGAL_CONSENT_REQUIRED === 'true';
}

// ── Built-in default copy (versioned markdown) ──────────────────────────────
// The version lines below are the click-wrap versions of record for deploys
// that don't supply LEGAL_DOCS_DIR. Bump a `version` whenever its copy changes
// materially — that bump is what re-prompts existing tenants.

const DEFAULTS: Record<LegalSlug, { title: string; version: string; updated: string; body: string }> = {
  terms: {
    title: 'Terms of Service',
    version: '1.0',
    updated: '2026-08-22',
    body: `These terms govern your use of {{APP_NAME}}, an AI management framework distributed as self-hostable software and offered with an optional hosted subscription, provided by {{COMPANY_NAME}}. By creating an account, installing, running, or subscribing to {{APP_NAME}} you agree to these terms, the [Privacy Policy](/privacy), and the [Acceptable Use Policy](/acceptable-use). If you are accepting on behalf of an organisation, you confirm you have authority to bind it.

## 1. The software & your license

The {{APP_NAME}} software is released under the MIT License. That license governs your rights to use, copy, modify, and distribute the code. Nothing in these terms reduces the rights the MIT License grants you over the software itself; these terms add conditions for the hosted service and clarify acceptable use.

## 2. Your account

- You must provide accurate registration information and keep your credentials (password, API keys) confidential.
- You are responsible for all activity under your account and API keys.
- One person or legal entity per account owner; team members join via invites.

## 3. Self-hosted use — your responsibilities

When you run {{APP_NAME}} on your own hardware you are the operator. You are responsible for securing your deployment, for any third-party API keys and accounts you configure (and the costs and terms those providers impose), for the code the autonomous runner executes on your behalf, and for backups of your data.

## 4. Hosted subscription & billing

- Paid tiers bill in advance on a recurring subscription via our payment processor; prices are shown at checkout.
- You may cancel at any time; access continues to the end of the paid period. Fees are non-refundable except where required by law.
- We may change prices with at least 30 days' notice before your next renewal.

## 5. Acceptable use

Use of {{APP_NAME}} is subject to the [Acceptable Use Policy](/acceptable-use), which is part of these terms. We may suspend or terminate accounts that violate it.

## 6. Your data

Your data remains yours. Our handling of personal data is described in the [Privacy Policy](/privacy); business customers can also execute our Data Processing Addendum.

## 7. Warranty disclaimer

The software is provided "AS IS", without warranty of any kind, express or implied. The hosted service is provided on an "as available" basis; we do not warrant it will be uninterrupted or error-free.

## 8. Limitation of liability

To the maximum extent permitted by law, {{COMPANY_NAME}}'s aggregate liability arising out of these terms is limited to the amounts you paid for the service in the 12 months preceding the claim, and neither party is liable for indirect, incidental, special, or consequential damages.

## 9. Changes to these terms

We may update these terms from time to time. When the version above changes materially you will be asked to review and accept the new terms on your next sign-in. Continued use after acceptance constitutes agreement.

## 10. Contact

Questions about these terms: {{CONTACT_EMAIL}}.`,
  },
  privacy: {
    title: 'Privacy Policy',
    version: '1.0',
    updated: '2026-08-22',
    body: `This policy explains what personal data {{COMPANY_NAME}} collects when you use {{APP_NAME}}, why, and the choices you have. The short version: the self-hosted software keeps your data on your machines; the hosted service collects only what it needs to operate your account.

## 1. Data we collect

- **Account data** — email address, display name, password hash, and workspace name, collected at signup to provision and secure your account.
- **Billing data** — handled by our payment processor; we never store card numbers.
- **Usage & telemetry** — API request metadata (endpoint, timing, status) and aggregate feature usage, used for reliability, capacity, and abuse prevention.
- **Consent records** — which version of the legal documents you accepted and when, kept as the record of the agreement.

## 2. How we use it

We use personal data to operate the service, authenticate you, bill subscriptions, send transactional email (verification, security, lifecycle), prevent abuse, and comply with law. We do not sell personal data.

## 3. Self-hosted deployments

When you self-host {{APP_NAME}}, your memory corpus, repositories, tasks, and telemetry live on infrastructure you control. {{COMPANY_NAME}} receives no data from a self-hosted deployment unless you explicitly configure it.

## 4. Retention & deletion

Account data is retained while your account is active. You can request erasure at any time — account deletion removes personal data and anonymises audit records within 30 days, except records we must keep for legal or billing compliance (including consent records).

## 5. Your rights

Depending on your jurisdiction (including GDPR and the Australian Privacy Act), you may have rights to access, correct, export, restrict, or delete your personal data, and to complain to a supervisory authority. Exercise them via {{CONTACT_EMAIL}}.

## 6. Security

Passwords are hashed with bcrypt, API keys are stored only as hashes, transport is TLS, and access to production data is role-gated and audited. See our security page for the full posture.

## 7. Subprocessors & international transfers

The hosted service relies on a small set of vetted subprocessors (hosting, email, payments) listed on our subprocessors page. Where data crosses borders we rely on appropriate safeguards such as standard contractual clauses.

## 8. Changes

We will update this policy as the service evolves; material changes bump the version above and trigger a re-consent prompt in the dashboard.

## 9. Contact

Privacy questions and rights requests: {{CONTACT_EMAIL}}.`,
  },
  'acceptable-use': {
    title: 'Acceptable Use Policy',
    version: '1.0',
    updated: '2026-08-22',
    body: `This policy defines what you may not do with {{APP_NAME}} — whether self-hosted against our hosted APIs or on a hosted subscription. It is part of the [Terms of Service](/terms). We may suspend or terminate accounts that violate it.

## 1. Illegal or harmful activity

You may not use {{APP_NAME}} to violate any law, to infringe others' intellectual-property or privacy rights, or to create, distribute, or operate malware, phishing campaigns, or fraud.

## 2. Abuse of the platform

You may not:

- Probe, scan, or test the vulnerability of the hosted service without written authorisation.
- Circumvent authentication, tenant isolation, rate limits, plan entitlements, or usage metering.
- Resell or white-label the hosted service without a written agreement.
- Use the service to build a directly competing product by systematic extraction of its outputs.

## 3. Autonomous agent responsibility

{{APP_NAME}} can run autonomous agents that write code, execute commands, and interact with third-party services on your behalf. You are responsible for what your agents do: the repositories they modify, the credentials you give them, and the actions they take against external systems. Do not configure agents to perform activity prohibited elsewhere in this policy.

## 4. Resource fairness

Automated workloads must stay within your plan's quotas. Deliberate patterns designed to degrade the service for other tenants — including excessive concurrent connections or storage abuse — are prohibited.

## 5. Content standards

Do not store or transmit content that is unlawful, or that you lack the rights to process. You are the controller of the content your workspace holds.

## 6. Reporting violations

Report suspected violations or abuse to {{CONTACT_EMAIL}}. We investigate all reports and, where required, notify affected parties.

## 7. Enforcement

Violations may result in throttling, suspension, or termination, proportionate to severity. Where practical we will warn you first; for severe or ongoing abuse we may act immediately.`,
  },
};

// ── Loading + caching ────────────────────────────────────────────────────────

let docCache: Map<LegalSlug, LegalDoc> | null = null;

/** Test hook + operator escape hatch: drop the cache so copy/env changes are re-read. */
export function clearLegalDocCache(): void {
  docCache = null;
}

function substituteEnv(text: string): string {
  const appName = process.env.LEGAL_APP_NAME || 'myAI';
  const companyName = process.env.LEGAL_COMPANY_NAME || 'the myAI project';
  const contactEmail = process.env.LEGAL_CONTACT_EMAIL || 'legal@myai.dev';
  return text
    .replaceAll('{{APP_NAME}}', appName)
    .replaceAll('{{COMPANY_NAME}}', companyName)
    .replaceAll('{{CONTACT_EMAIL}}', contactEmail);
}

/** Parse a `--- key: value ---` frontmatter block off an operator-supplied .md file. */
export function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key) meta[key] = value;
  }
  return { meta, body: raw.slice(m[0].length) };
}

function loadDoc(slug: LegalSlug): LegalDoc {
  const def = DEFAULTS[slug];
  const dir = process.env.LEGAL_DOCS_DIR;
  if (dir) {
    const file = path.join(dir, `${slug}.md`);
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const { meta, body } = parseFrontmatter(raw);
      if (!meta.version) {
        // An override without a version can't drive re-consent — refuse it
        // loudly rather than silently serving unversioned click-wrap copy.
        log.error({ file }, 'legal doc override missing frontmatter version — using built-in default');
      } else {
        return {
          slug,
          title: meta.title || def.title,
          version: meta.version,
          updated: meta.updated || def.updated,
          markdown: substituteEnv(body.trim()),
        };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.error({ err, file }, 'failed to read legal doc override — using built-in default');
      }
    }
  }
  return { slug, title: def.title, version: def.version, updated: def.updated, markdown: substituteEnv(def.body) };
}

function docs(): Map<LegalSlug, LegalDoc> {
  if (!docCache) {
    docCache = new Map(LEGAL_SLUGS.map((slug) => [slug, loadDoc(slug)]));
  }
  return docCache;
}

export function getLegalDoc(slug: string): LegalDoc {
  if (!(LEGAL_SLUGS as readonly string[]).includes(slug)) {
    throw new AuthError('unknown legal document', 404, 'NOT_FOUND');
  }
  return docs().get(slug as LegalSlug)!;
}

/** Metadata only (no bodies) — the list endpoint + consent-status comparisons. */
export function listLegalDocs(): Array<Omit<LegalDoc, 'markdown'>> {
  return [...docs().values()].map(({ slug, title, version, updated }) => ({ slug, title, version, updated }));
}

export function currentLegalVersions(): LegalVersions {
  const d = docs();
  return {
    terms: d.get('terms')!.version,
    privacy: d.get('privacy')!.version,
    acceptableUse: d.get('acceptable-use')!.version,
  };
}

// ── Consent recording + status ───────────────────────────────────────────────

export interface RecordConsentInput {
  tenantId: string;
  userId: string;
  email?: string;
  source: 'signup' | 'reconsent';
  ip?: string;
}

/** Append-only consent record at the CURRENT document versions — the legal
 *  evidence of the click. Never updates in place; history is the audit trail. */
export async function recordLegalConsent(input: RecordConsentInput) {
  const versions = currentLegalVersions();
  const doc = await LegalConsentModel.create({
    consentId: `lc_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`,
    tenantId: input.tenantId,
    userId: input.userId,
    email: input.email,
    source: input.source,
    ip: input.ip,
    termsVersion: versions.terms,
    privacyVersion: versions.privacy,
    acceptableUseVersion: versions.acceptableUse,
    acceptedAt: new Date(),
  });
  log.info({ tenantId: input.tenantId, userId: input.userId, source: input.source, versions }, 'legal consent recorded');
  return doc;
}

export interface ConsentStatus {
  required: boolean;
  current: LegalVersions;
  accepted: LegalVersions | null;
  acceptedAt: Date | null;
  /** True when the latest record matches every current version. */
  upToDate: boolean;
  /** What the dashboard acts on: prompt when a past acceptance is stale
   *  (version bump), or when enforcement is on and no record exists at all.
   *  Never-consented tenants are grandfathered while enforcement is off. */
  reconsentNeeded: boolean;
}

export async function getLegalConsentStatus(tenantId: string): Promise<ConsentStatus> {
  const current = currentLegalVersions();
  const latest = await LegalConsentModel.findOne({ tenantId }).sort({ acceptedAt: -1 }).lean();
  if (!latest) {
    return {
      required: isConsentRequired(),
      current,
      accepted: null,
      acceptedAt: null,
      upToDate: false,
      reconsentNeeded: isConsentRequired(),
    };
  }
  const accepted: LegalVersions = {
    terms: latest.termsVersion,
    privacy: latest.privacyVersion,
    acceptableUse: latest.acceptableUseVersion,
  };
  const upToDate =
    accepted.terms === current.terms &&
    accepted.privacy === current.privacy &&
    accepted.acceptableUse === current.acceptableUse;
  return {
    required: isConsentRequired(),
    current,
    accepted,
    acceptedAt: latest.acceptedAt,
    upToDate,
    reconsentNeeded: !upToDate,
  };
}

/** Signup gate — throws when LEGAL_CONSENT_REQUIRED is on and the request
 *  didn't tick the box. Called by signup() before any provisioning happens. */
export function assertSignupConsent(acceptTerms: boolean | undefined): void {
  if (isConsentRequired() && acceptTerms !== true) {
    throw new AuthError(
      'you must accept the Terms of Service, Privacy Policy, and Acceptable Use Policy to create an account',
      400,
      'CONSENT_REQUIRED',
    );
  }
}
