// Public /acceptable-use page — the Acceptable Use Policy every self-serve
// signup click-wraps alongside /terms and /privacy. PRIMARY SOURCE is the
// gateway's versioned markdown (GET /api/legal/docs/acceptable-use — copy is
// env-driven there via LEGAL_DOCS_DIR / LEGAL_* vars, and its `version` is
// what drives the dashboard re-consent prompt). The static fallback below
// keeps the page readable when the gateway is unreachable — a trust page must
// never 500 in front of a buyer. Reachable without a login (middleware
// PUBLIC_PREFIXES + AppShell FULL_BLEED).
import { GATEWAY_HTTP_URL } from '@/lib/gateway';
import { fetchLegalDoc, LegalMarkdown } from '@/lib/legal-markdown';
import { LegalShell, Section, Bullets } from '@/components/legal-shell';

export const metadata = {
  title: 'Acceptable Use Policy — myAI',
  description:
    'What you may not do with myAI: illegal or harmful activity, platform abuse, autonomous-agent responsibility, resource fairness, and enforcement.',
};

export default async function AcceptableUsePage() {
  const doc = await fetchLegalDoc(GATEWAY_HTTP_URL, 'acceptable-use');

  if (doc) {
    return (
      <LegalShell title={doc.title} updated={`${doc.updated} (v${doc.version})`}>
        <LegalMarkdown markdown={doc.markdown} />
      </LegalShell>
    );
  }

  // Gateway unreachable — static fallback mirroring the built-in default copy.
  return (
    <LegalShell
      title="Acceptable Use Policy"
      updated="2026-08-22"
      intro={
        <>
          This policy defines what you may not do with myAI — whether self-hosted against our hosted APIs or on a
          hosted subscription. It is part of the Terms of Service; accounts that violate it may be suspended or
          terminated.
        </>
      }
    >
      <Section heading="1. Illegal or harmful activity">
        <p>
          You may not use myAI to violate any law, to infringe others&apos; intellectual-property or privacy rights, or
          to create, distribute, or operate malware, phishing campaigns, or fraud.
        </p>
      </Section>

      <Section heading="2. Abuse of the platform">
        <Bullets
          items={[
            'No probing, scanning, or vulnerability-testing of the hosted service without written authorisation.',
            'No circumventing authentication, tenant isolation, rate limits, plan entitlements, or usage metering.',
            'No reselling or white-labelling the hosted service without a written agreement.',
            'No building a directly competing product by systematic extraction of the service’s outputs.',
          ]}
        />
      </Section>

      <Section heading="3. Autonomous agent responsibility">
        <p>
          myAI can run autonomous agents that write code, execute commands, and interact with third-party services on
          your behalf. You are responsible for what your agents do: the repositories they modify, the credentials you
          give them, and the actions they take against external systems.
        </p>
      </Section>

      <Section heading="4. Resource fairness">
        <p>
          Automated workloads must stay within your plan&apos;s quotas. Deliberate patterns designed to degrade the
          service for other tenants are prohibited.
        </p>
      </Section>

      <Section heading="5. Reporting & enforcement">
        <p>
          Report suspected violations to the contact listed on the privacy page. Violations may result in throttling,
          suspension, or termination, proportionate to severity — where practical we warn first; for severe or ongoing
          abuse we may act immediately.
        </p>
      </Section>
    </LegalShell>
  );
}
