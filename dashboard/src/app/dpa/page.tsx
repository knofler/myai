// Public /dpa page — the Data Processing Addendum an enterprise buyer's
// procurement/legal team asks for before signing. Complements the trust pack
// (/privacy, /terms, /security) with the GDPR art. 28 groundwork the pack
// doesn't cover. Grounded in myAI's architecture: in the default self-hosted
// configuration the customer runs all processing on their own hardware, so
// this DPA only ever activates for the hosted surfaces (account/billing,
// hosted brain remotes, support). Reachable without a login (middleware
// PUBLIC_PREFIXES + AppShell FULL_BLEED). Server component, static content.
import { LegalShell, Section, Bullets } from '@/components/legal-shell';

export const metadata = {
  title: 'Data Processing Addendum — myAI',
  description:
    'The myAI Data Processing Addendum (GDPR art. 28): roles, scope, security measures, subprocessors, international transfers, and deletion — covering only the hosted surfaces, because self-hosted context never reaches the vendor.',
};

export default function DpaPage() {
  return (
    <LegalShell
      title="Data Processing Addendum"
      updated="2026-08-21"
      intro={
        <>
          This Data Processing Addendum (&ldquo;DPA&rdquo;) forms part of the agreement between the customer
          (&ldquo;Customer&rdquo;) and the myAI maintainers (&ldquo;Vendor&rdquo;) whenever the Vendor processes personal
          data on the Customer&apos;s behalf. In myAI&apos;s{' '}
          <strong className="text-[rgb(var(--text-primary))]">default self-hosted configuration this DPA has almost
          nothing to govern</strong>: the working context — agent memory, sessions, handoffs, the recall corpus — is
          processed on the Customer&apos;s own hardware and never transmitted to the Vendor (see{' '}
          <a href="/security" className="text-teal-300 hover:underline">
            Security &amp; Data Locality
          </a>
          ). It applies to the hosted surfaces only: the account/billing service, optional hosted brain remotes, and
          support.
        </>
      }
    >
      <Section heading="1. Roles and scope">
        <Bullets
          items={[
            <>
              <strong className="text-[rgb(var(--text-primary))]">Self-hosted deployment (default):</strong> the Customer is
              the controller and operates the processing themselves, on their own infrastructure. The Vendor receives no
              personal data and is neither controller nor processor for the Customer&apos;s working context.
            </>,
            <>
              <strong className="text-[rgb(var(--text-primary))]">Hosted account &amp; billing:</strong> the Vendor acts as an
              independent controller for the minimal account data described in the{' '}
              <a href="/privacy" className="text-teal-300 hover:underline">
                Privacy Policy
              </a>{' '}
              (email, hashed credentials, subscription state).
            </>,
            <>
              <strong className="text-[rgb(var(--text-primary))]">Hosted brain remote (optional, per-tenant):</strong> when
              the Customer provisions a hosted brain, the Vendor acts as a processor for the content the Customer chooses
              to sync there. This is the surface the obligations below govern.
            </>,
          ]}
        />
      </Section>

      <Section heading="2. Subject matter, duration, nature and purpose">
        <p>
          Processing is limited to storing, replicating and returning the data the Customer&apos;s own myAI instance
          pushes to its hosted brain remote, plus operating the account/billing surface — solely to provide the
          subscribed service, for the duration of the subscription, and never for advertising, profiling, resale, or
          model training.
        </p>
      </Section>

      <Section heading="3. Categories of data and data subjects">
        <Bullets
          items={[
            'Account data — email address, display name, hashed credentials, tenant identifiers (data subjects: the Customer’s named users).',
            'Billing data — customer reference, plan tier, subscription status; card data is held by the payment processor, never by the Vendor.',
            'Hosted brain content — whatever the Customer’s instance syncs (session atoms, compiled briefs). Its contents are determined entirely by the Customer; the Customer is responsible for what they choose to sync.',
            'Support correspondence — whatever the Customer sends when asking for help.',
          ]}
        />
      </Section>

      <Section heading="4. Vendor (processor) obligations">
        <p>Where the Vendor processes personal data on the Customer&apos;s behalf, the Vendor will:</p>
        <Bullets
          items={[
            'Process it only on the Customer’s documented instructions — the subscription itself and the sync operations the Customer’s instance issues — unless required otherwise by law, in which case the Vendor informs the Customer unless legally barred.',
            'Ensure persons authorised to process the data are bound by confidentiality.',
            <>
              Apply the technical and organisational measures published on the{' '}
              <a href="/security" className="text-teal-300 hover:underline">
                Security &amp; Data Locality
              </a>{' '}
              page and in version-controlled{' '}
              <a
                href="https://github.com/knofler/myai/blob/main/SECURITY.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-300 hover:underline"
              >
                SECURITY.md
              </a>{' '}
              — hashed credentials, SHA-256-hashed API keys with constant-time comparison, per-tenant isolation, and
              loopback-bound defaults.
            </>,
            <>
              Engage subprocessors only as listed on the{' '}
              <a href="/subprocessors" className="text-teal-300 hover:underline">
                Subprocessors
              </a>{' '}
              page, under written terms no less protective than this DPA, with advance notice of changes (Section 5).
            </>,
            'Assist the Customer, taking into account the nature of the processing, in responding to data-subject requests (access, rectification, erasure, portability) and in meeting its security, breach-notification and impact-assessment obligations.',
            'Notify the Customer without undue delay after becoming aware of a personal data breach affecting the Customer’s data, with the detail needed for the Customer’s own art. 33/34 obligations.',
            'Delete or return the data at the end of the service (Section 7).',
            'Make available the information necessary to demonstrate compliance, and allow for audits as described in Section 8.',
          ]}
        />
      </Section>

      <Section heading="5. Subprocessors">
        <p>
          The Customer generally authorises the subprocessors on the{' '}
          <a href="/subprocessors" className="text-teal-300 hover:underline">
            maintained subprocessor list
          </a>
          . The Vendor gives at least 30 days&apos; notice before adding or replacing a subprocessor (the list page
          records the change and its date); the Customer may object on reasonable data-protection grounds, and if the
          objection cannot be resolved, may terminate the affected service and receive a pro-rata refund. Integrations
          the Customer configures with their own credentials (LLM providers, messaging bots, error tracking) are the
          Customer&apos;s own vendors, not subprocessors — see the list page.
        </p>
      </Section>

      <Section heading="6. International transfers">
        <p>
          Hosted brain remotes are provisioned in the region chosen at provisioning time and are not moved without the
          notice in Section 5. Where a transfer outside the Customer&apos;s jurisdiction is unavoidable (e.g. the payment
          processor), it relies on the subprocessor&apos;s Standard Contractual Clauses or an equivalent lawful transfer
          mechanism, referenced per-vendor on the subprocessor list.
        </p>
      </Section>

      <Section heading="7. Deletion and return">
        <p>
          Self-hosted data never left the Customer&apos;s hands, so deletion is entirely the Customer&apos;s operation.
          For hosted surfaces: the Customer can deprovision a hosted brain at any time, and on account closure the
          Vendor deletes or anonymises hosted personal data within 30 days, except billing records retained to meet
          legal and tax obligations. Export is available first — the platform&apos;s export tooling (
          <code className="text-teal-300">myai memory export</code>, context export) returns the data in portable form.
        </p>
      </Section>

      <Section heading="8. Audit">
        <p>
          myAI is source-available: the security-relevant implementation (auth, tenancy, hashing, retention jobs) is
          inspectable in the repository, which serves as the primary audit artifact. The Vendor will additionally answer
          reasonable written security questionnaires, no more than once per year absent a genuine incident, at the
          Customer&apos;s expense for extraordinary effort.
        </p>
      </Section>

      <Section heading="9. Liability and order of precedence">
        <p>
          Liability under this DPA is subject to the limitations in the{' '}
          <a href="/terms" className="text-teal-300 hover:underline">
            Terms of Service
          </a>
          . If this DPA conflicts with the Terms on data-protection matters, this DPA prevails.
        </p>
      </Section>

      <Section heading="10. Executing this DPA">
        <p>
          This published DPA applies automatically to hosted subscriptions from the &ldquo;Last updated&rdquo; date
          above. Enterprise customers who need a countersigned copy (or their own DPA template reviewed) can open a
          private thread via{' '}
          <a
            href="https://github.com/knofler/myai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            the repository
          </a>{' '}
          or email the maintainer listed in the repo profile. Material changes are posted on this page with an updated
          date.
        </p>
        <p className="text-xs text-[rgb(var(--text-muted))]">
          This document is a plain-language addendum, not legal advice; have your counsel adapt it to your jurisdiction
          before relying on it commercially.
        </p>
      </Section>
    </LegalShell>
  );
}
