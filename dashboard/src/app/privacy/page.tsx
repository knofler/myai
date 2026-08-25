// Public /privacy page — the privacy policy a buyer reads before paying.
// Grounded in myAI's self-hosted, user-owned architecture (SECURITY.md §1):
// the memory corpus never leaves the customer's machine, so myAI-the-vendor is
// not a data processor for the customer's working context. This page covers the
// two surfaces the vendor DOES touch: the hosted account/billing surface (when
// a customer signs up for a paid tier) and the local product's outbound calls.
// Reachable without a login (middleware PUBLIC_PREFIXES + AppShell FULL_BLEED).
import { LegalShell, Section, Bullets } from '@/components/legal-shell';
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { fetchLegalDoc, LegalMarkdown } from '@/lib/legal-markdown';

export const metadata = {
  title: 'Privacy Policy — myAI',
  description:
    'How myAI handles data: your working context stays on your own machine; the vendor only holds the minimal account and billing data needed to run a paid subscription.',
};

// PRIMARY SOURCE: the gateway's versioned markdown (GET /api/legal/docs/privacy
// — env-driven copy via LEGAL_DOCS_DIR / LEGAL_* vars; its `version` drives
// the signup click-wrap record + the dashboard re-consent prompt). The static
// JSX below is the fallback when the gateway is unreachable — this page must
// never 500 in front of a buyer.
export default async function PrivacyPage() {
  const doc = await fetchLegalDoc(GATEWAY_HTTP_URL, 'privacy');
  if (doc) {
    return (
      <LegalShell title={doc.title} updated={`${doc.updated} (v${doc.version})`}>
        <LegalMarkdown markdown={doc.markdown} />
      </LegalShell>
    );
  }
  return <StaticPrivacyFallback />;
}

function StaticPrivacyFallback() {
  return (
    <LegalShell
      title="Privacy Policy"
      updated="2026-08-21"
      intro={
        <>
          myAI is a self-hosted, user-owned platform. Your working context — agent memory, session state, handoffs, the
          recall corpus — lives in a database on <strong className="text-[rgb(var(--text-primary))]">your</strong> hardware and never
          reaches us. This policy explains the only data we, the vendor, ever touch: the minimal account and billing
          information required to run a paid subscription, plus the optional outbound calls the software you run makes
          when <em>you</em> configure them. See the{' '}
          <a href="/security" className="text-teal-300 hover:underline">
            Security &amp; Data Locality
          </a>{' '}
          page for the technical guarantee.
        </>
      }
    >
      <Section heading="1. Your working context is not our data">
        <p>
          The default myAI configuration makes <strong className="text-[rgb(var(--text-primary))]">zero outbound network calls</strong>.
          Memory is a local database and a folder of markdown you can walk away with (
          <code className="text-teal-300">myai memory export</code>). We are not a processor of your context because it
          is never transmitted to us. There is no telemetry and no silent upload.
        </p>
      </Section>

      <Section heading="2. Data we do collect (hosted account & billing only)">
        <p>If you create an account on our hosted service or subscribe to a paid tier, we collect only:</p>
        <Bullets
          items={[
            'Account identity — the email address and display name you provide, and a securely hashed password.',
            'Workspace/tenant metadata — the tenant identifier and API-key hashes needed to scope your workspace (keys are stored SHA-256 hashed, never in plaintext).',
            'Billing data — handled by our payment processor (Stripe). We store a customer reference, plan tier, and subscription status; we never see or store your full card number.',
            'Support correspondence — anything you send us directly when you ask for help.',
          ]}
        />
        <p>
          We do <strong className="text-[rgb(var(--text-primary))]">not</strong> collect your agent memory, code, repositories, prompts,
          or task history — those stay on your machine.
        </p>
      </Section>

      <Section heading="3. Optional third parties (only when you configure them)">
        <p>
          The software you self-host contacts an external service only when you supply the corresponding credential in
          your own <code className="text-teal-300">.env</code>. These are your integrations under your own accounts, not
          data we share:
        </p>
        <Bullets
          items={[
            'LLM providers (Anthropic, OpenAI, Moonshot, DeepSeek) — only with your API key, for chat/routing you invoke.',
            'Messaging channels (Telegram, Discord) — only with your bot token, for phone/chat control you enable.',
            'Error tracking (Sentry) — only if you set a DSN.',
            'MongoDB Atlas — only if you point your database URI at Atlas for a multi-machine queue; point it local to keep everything local.',
            'GitHub — the normal git workflow, driven by your own credentials.',
          ]}
        />
        <p>None of these receive your memory corpus. Each provider&apos;s own privacy policy governs the data you send it.</p>
      </Section>

      <Section heading="4. How we use hosted account data">
        <Bullets
          items={[
            'To authenticate you and scope your workspace.',
            'To provision, bill, and renew your subscription.',
            'To send transactional messages (receipts, security notices, service changes) — not marketing unless you opt in.',
            'To provide support you request and to protect the service against abuse.',
          ]}
        />
        <p>We do not sell personal data, and we do not use your account data to train models.</p>
      </Section>

      <Section heading="5. Retention & deletion">
        <p>
          Because your context lives on your hardware, deletion is largely in your hands: stop the stack, remove the
          database volume, and it is gone. For hosted account data, we retain it while your account is active and delete
          or anonymise it within 30 days of account closure, except where we must keep billing records to meet legal
          and tax obligations. To request access or deletion of hosted account data, contact us (Section 8).
        </p>
      </Section>

      <Section heading="6. Security">
        <p>
          Account credentials are hashed, API keys are stored SHA-256 hashed and compared in constant time, and the
          local stack ships loopback-bound by default. Full detail is on the{' '}
          <a href="/security" className="text-teal-300 hover:underline">
            Security &amp; Data Locality
          </a>{' '}
          page.
        </p>
      </Section>

      <Section heading="7. Cookies" id="cookies">
        <p>
          The site sets only functional cookies — no advertising trackers, and no analytics unless you opt in via the
          consent banner (none are in use today; the banner records the choice so any future tool is consent-gated):
        </p>
        <Bullets
          items={[
            <>
              <code className="text-teal-300">myai_token</code> / <code className="text-teal-300">myai_operator</code> —
              strictly necessary: your sign-in sessions.
            </>,
            <>
              <code className="text-teal-300">myai_tenant</code> — strictly necessary: scopes the dashboard to your
              workspace (an identifier only, never a credential).
            </>,
            <>
              <code className="text-teal-300">myai_locale</code> — preference: remembers your language choice.
            </>,
            <>
              <code className="text-teal-300">myai_consent</code> — strictly necessary: records your cookie choices so we
              don&apos;t re-ask on every visit.
            </>,
          ]}
        />
        <p>
          You can change your choices at any time via the &ldquo;Cookie settings&rdquo; link in the footer of any policy
          page. Enterprise buyers: the{' '}
          <a href="/dpa" className="text-teal-300 hover:underline">
            Data Processing Addendum
          </a>{' '}
          and the{' '}
          <a href="/subprocessors" className="text-teal-300 hover:underline">
            subprocessor list
          </a>{' '}
          cover the processing side.
        </p>
      </Section>

      <Section heading="8. Contact & changes">
        <p>
          Questions or data requests: open a private thread via{' '}
          <a
            href="https://github.com/knofler/myai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            the repository
          </a>{' '}
          or email the maintainer listed in the repo profile. We will post any material change to this policy on this
          page and update the &ldquo;Last updated&rdquo; date above.
        </p>
        <p className="text-xs text-[rgb(var(--text-muted))]">
          This document is a plain-language policy, not legal advice; adapt it to your jurisdiction before relying on it
          commercially.
        </p>
      </Section>
    </LegalShell>
  );
}
