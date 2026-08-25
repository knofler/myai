// Public /subprocessors page — the maintained subprocessor list the DPA
// (Section 5) points at. This page IS the notice mechanism: every addition,
// replacement or removal lands as a dated row in CHANGE_LOG below and a new
// "Last updated" date, at least 30 days before a new subprocessor handles
// customer data. Keep the data in the const arrays (not prose) so an update
// is a one-row diff a reviewer can see. Reachable without a login
// (middleware PUBLIC_PREFIXES + AppShell FULL_BLEED).
import { LegalShell, Section, Bullets } from '@/components/legal-shell';

export const metadata = {
  title: 'Subprocessors — myAI',
  description:
    'The maintained list of subprocessors myAI engages for its hosted surfaces, what each one processes, where, and under which transfer mechanism — plus the change log that serves as advance notice.',
};

const SUBPROCESSORS: {
  name: string;
  purpose: string;
  data: string;
  location: string;
  terms: { label: string; href: string };
}[] = [
  {
    name: 'Stripe, Inc.',
    purpose: 'Payment processing, subscriptions, invoices, marketplace payouts',
    data: 'Billing contact details, payment method (held by Stripe, never by the Vendor), transaction history',
    location: 'United States / global (SCCs + Stripe DPA)',
    terms: { label: 'Stripe DPA', href: 'https://stripe.com/legal/dpa' },
  },
  {
    name: 'MongoDB, Inc. (Atlas)',
    purpose: 'Hosted brain remotes — only for tenants that explicitly provision one',
    data: 'The brain content the customer’s instance syncs (session atoms, compiled briefs)',
    location: 'Region selected by the customer at provisioning; not moved without notice',
    terms: { label: 'MongoDB DPA', href: 'https://www.mongodb.com/legal/dpa' },
  },
  {
    name: 'Vercel, Inc.',
    purpose: 'Hosting of the public marketing/dashboard site',
    data: 'Standard web server request logs (IP address, user agent) processed transiently to serve the site',
    location: 'United States / global edge (SCCs + Vercel DPA)',
    terms: { label: 'Vercel DPA', href: 'https://vercel.com/legal/dpa' },
  },
  {
    name: 'GitHub, Inc.',
    purpose: 'Source hosting, release distribution, and the support channel (issues/private threads)',
    data: 'Support correspondence and any details a customer includes in it',
    location: 'United States (SCCs + GitHub DPA)',
    terms: { label: 'GitHub DPA', href: 'https://github.com/customer-terms/github-data-protection-agreement' },
  },
];

// Newest first. Every list change gets a dated row — this log is the advance
// notice the DPA promises, so a change ships ≥30 days before taking effect.
const CHANGE_LOG: { date: string; change: string }[] = [
  { date: '2026-08-21', change: 'Initial published list: Stripe, MongoDB Atlas, Vercel, GitHub.' },
];

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-left font-medium text-[rgb(var(--text-primary))] px-3 py-2 border-b border-[rgb(var(--border-subtle))]">
      {children}
    </th>
  );
}
function Td({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-3 py-2 border-b border-[rgb(var(--border-subtle))] text-[rgb(var(--text-secondary))] align-top">
      {children}
    </td>
  );
}

export default function SubprocessorsPage() {
  return (
    <LegalShell
      title="Subprocessors"
      updated="2026-08-21"
      intro={
        <>
          These are the third parties myAI engages to process personal data on customers&apos; behalf for the{' '}
          <strong className="text-[rgb(var(--text-primary))]">hosted surfaces only</strong> — account/billing, optional
          hosted brain remotes, and support. In the default self-hosted configuration none of them touch your data,
          because your working context never leaves your machine (see{' '}
          <a href="/security" className="text-teal-300 hover:underline">
            Security &amp; Data Locality
          </a>
          ). This page is the maintained list referenced by Section 5 of the{' '}
          <a href="/dpa" className="text-teal-300 hover:underline">
            Data Processing Addendum
          </a>
          ; the change log at the bottom is the advance-notice record.
        </>
      }
    >
      <Section heading="Current subprocessors">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th>Subprocessor</Th>
                <Th>Purpose</Th>
                <Th>Data processed</Th>
                <Th>Location &amp; transfer mechanism</Th>
                <Th>Terms</Th>
              </tr>
            </thead>
            <tbody>
              {SUBPROCESSORS.map((s) => (
                <tr key={s.name}>
                  <Td>
                    <span className="text-[rgb(var(--text-primary))] font-medium">{s.name}</span>
                  </Td>
                  <Td>{s.purpose}</Td>
                  <Td>{s.data}</Td>
                  <Td>{s.location}</Td>
                  <Td>
                    <a href={s.terms.href} target="_blank" rel="noopener noreferrer" className="text-teal-300 hover:underline">
                      {s.terms.label}
                    </a>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section heading="Not subprocessors: integrations you configure yourself">
        <p>
          The software you self-host contacts an external service only when you supply the corresponding credential in
          your own <code className="text-teal-300">.env</code>. Those are your own vendors under your own accounts — the
          Vendor is not in the data path and they are deliberately absent from the table above:
        </p>
        <Bullets
          items={[
            'LLM providers (Anthropic, OpenAI, Moonshot, DeepSeek) — your API keys, your calls.',
            'Messaging channels (Telegram, Discord) — your bot tokens.',
            'Error tracking (Sentry) — only if you set a DSN.',
            'Your own MongoDB Atlas cluster — if you point your database URI at Atlas yourself.',
            'GitHub/git remotes for your repositories — your credentials, your pushes.',
          ]}
        />
      </Section>

      <Section heading="Change notice & objections">
        <Bullets
          items={[
            'Additions or replacements are posted here at least 30 days before the new subprocessor handles customer data, as a dated change-log row.',
            'To be notified actively, watch the repository — this page is version-controlled, so every change is a reviewable commit.',
            <>
              Objections: raise a reasonable data-protection objection via{' '}
              <a
                href="https://github.com/knofler/myai"
                target="_blank"
                rel="noopener noreferrer"
                className="text-teal-300 hover:underline"
              >
                the repository
              </a>{' '}
              or the maintainer email before the effective date; unresolved objections carry the termination right in
              DPA Section 5.
            </>,
          ]}
        />
      </Section>

      <Section heading="Change log">
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th>Date</Th>
                <Th>Change</Th>
              </tr>
            </thead>
            <tbody>
              {CHANGE_LOG.map((c) => (
                <tr key={c.date + c.change}>
                  <Td>{c.date}</Td>
                  <Td>{c.change}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </LegalShell>
  );
}
