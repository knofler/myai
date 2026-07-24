// Public /security page — the customer-facing data-locality & security page a
// buyer reads before paying. Derived from SECURITY.md (the source of truth);
// keep the two in sync when the outbound surface, ports, or token model change.
// Reachable without a login (added to middleware PUBLIC_PREFIXES + AppShell
// FULL_BLEED). Server component, no data fetch — pure static content.
import { LegalShell, Section } from '@/components/legal-shell';

export const metadata = {
  title: 'Security & Data Locality — myAI',
  description:
    'How myAI keeps your context on your own machine: the data-locality guarantee, the exhaustive outbound surface, ports & tokens, threat model, and disclosure policy.',
};

const LOCAL: { data: string; where: string; leaves: string }[] = [
  { data: 'Memory corpus (state, handoffs, patterns, archives)', where: 'myai-mongo container, local volume', leaves: 'Never' },
  { data: 'Vector embeddings', where: 'Same store; computed in-process on your CPU (all-MiniLM-L6-v2)', leaves: 'Never' },
  { data: 'Brain store (session atoms, compiled briefs)', where: 'Local gateway + git-versioned files in your repos', leaves: 'Only via your own git push' },
  { data: 'State files (STATE.md, handoff, logs)', where: 'Plain files in your repos', leaves: 'Only via your own git push' },
  { data: 'Memory export bundles', where: 'A local folder you choose', leaves: 'Only if you copy them — secret-scanned first' },
];

const OUTBOUND: { dest: string; when: string; purpose: string }[] = [
  { dest: 'api.anthropic.com', when: 'LLM_MODE=api + ANTHROPIC_API_KEY', purpose: 'Channel/LLM responses (chat, LLM router)' },
  { dest: 'api.openai.com (embeddings)', when: 'provider: openai + OPENAI_API_KEY', purpose: 'Optional remote embeddings — default is the local model' },
  { dest: 'api.telegram.org', when: 'TELEGRAM_BOT_TOKEN', purpose: 'Phone control (outbound long-poll; no inbound port)' },
  { dest: 'discord.com/api', when: 'DISCORD_BOT_TOKEN', purpose: 'Discord channel (outbound poll)' },
  { dest: 'Moonshot / DeepSeek', when: 'their API keys', purpose: 'Optional cheap-tier LLM routing (ollama is fully local)' },
  { dest: 'Sentry', when: 'SENTRY_DSN', purpose: 'Error tracking' },
  { dest: 'MongoDB Atlas', when: 'MONGODB_URI pointed at Atlas', purpose: 'Multi-machine queue — point it local to stay local' },
  { dest: 'GitHub', when: 'your own gh / git remotes', purpose: 'The normal git workflow, driven by you' },
];

const THREATS: { threat: string; mitigation: string }[] = [
  { threat: 'Spoofing local access (X-Forwarded-For)', mitigation: 'Loopback decided from the raw socket address only' },
  { threat: 'Spoofing / guessing a tenant API key', mitigation: 'Full-entropy keys, SHA-256 at rest, constant-time compare' },
  { threat: 'Tampering with the task queue', mitigation: 'Tenancy enforced by default (401 without key); bind loopback to remove the surface' },
  { threat: 'Secrets leaking into git', mitigation: 'Pre-commit secret scan blocks credentials, .env, .pem, .key' },
  { threat: 'Secrets leaking in an export bundle', mitigation: 'Export path re-scans & redacts every file it writes' },
  { threat: 'Default-cred Mongo exposed on the LAN', mitigation: 'Host port bound to 127.0.0.1 by default' },
  { threat: 'Agent pushing to production', mitigation: 'block-push-main hook + branch protection; work lands via test → PR' },
];

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-left font-medium text-zinc-300 px-3 py-2 border-b border-zinc-800">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 border-b border-zinc-900 text-zinc-400 align-top">{children}</td>;
}

export default function SecurityPage() {
  return (
    <LegalShell
      title="Security & Data Locality"
      updated="2026-07-18"
      intro={
        <>
          <strong className="text-zinc-200">The headline guarantee: your context never leaves your machine.</strong>{' '}
          Every byte of agent memory — session state, handoffs, brain atoms, the embedded recall corpus — lives in a
          database container on your hardware and is embedded by a model running in-process on your CPU. In the default
          configuration, myAI makes <strong className="text-zinc-200">zero outbound network calls</strong>. This page is
          a plain-English summary of{' '}
          <a
            href="https://github.com/knofler/ai_management/blob/main/SECURITY.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            SECURITY.md
          </a>
          , which is the authoritative, version-controlled source.
        </>
      }
    >
      <Section heading="1. What stays local, always">
        <p>myAI is self-hosted and user-owned. Nothing below ever leaves your hardware in the default configuration.</p>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th>Data</Th>
                <Th>Where it lives</Th>
                <Th>Leaves the machine?</Th>
              </tr>
            </thead>
            <tbody>
              {LOCAL.map((r) => (
                <tr key={r.data}>
                  <Td>{r.data}</Td>
                  <Td>{r.where}</Td>
                  <Td>{r.leaves}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section heading="2. The exhaustive outbound surface">
        <p>
          Nothing below is contacted unless <strong className="text-zinc-200">you</strong> put a credential in{' '}
          <code className="text-teal-300">.env</code>. No credential → no call. There is no telemetry, no phone-home, no
          silent upload — and none of these destinations ever receive your memory corpus.
        </p>
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th>Destination</Th>
                <Th>Only when you set</Th>
                <Th>Purpose</Th>
              </tr>
            </thead>
            <tbody>
              {OUTBOUND.map((r) => (
                <tr key={r.dest}>
                  <Td>{r.dest}</Td>
                  <Td>{r.when}</Td>
                  <Td>{r.purpose}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      <Section heading="3. Ports, tokens & authentication">
        <p>
          The database is host-published on <code className="text-teal-300">127.0.0.1:27200</code> only. Set{' '}
          <code className="text-teal-300">HOST_BIND=127.0.0.1</code> to lock the whole stack to the local machine.
          Authentication (ADR-010):
        </p>
        <ul className="list-disc pl-5 space-y-2">
          <li>Per-tenant API keys are full-entropy CSPRNG secrets, stored SHA-256 hashed and verified in constant time.</li>
          <li>Loopback trust is decided from the raw socket address, so a forged X-Forwarded-For header cannot fake local access.</li>
          <li>Inbound webhooks are HMAC-signature-verified when configured.</li>
          <li>Every memory/task query is tenant-scoped — one tenant&apos;s corpus is invisible to another.</li>
        </ul>
      </Section>

      <Section heading="4. Memory export is secret-scanned">
        <p>
          The one bundle designed to leave the machine (migration, backup, hand-off) is scanned with the same secret
          patterns the commit hook enforces, and matches are redacted in place before anything is written. If the
          pattern library is missing, export refuses to write an unscanned bundle rather than failing open.
        </p>
      </Section>

      <Section heading="5. Threat model (summary)">
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th>Threat</Th>
                <Th>Mitigation</Th>
              </tr>
            </thead>
            <tbody>
              {THREATS.map((r) => (
                <tr key={r.threat}>
                  <Td>{r.threat}</Td>
                  <Td>{r.mitigation}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-zinc-500">
          Full STRIDE analysis, ports diagram, and the hardening checklist are in SECURITY.md.
        </p>
      </Section>

      <Section heading="6. Always-on safety hooks">
        <p>
          These run independent of permission mode (bypass/YOLO does not disable them): no direct pushes to main; no
          credentials, <code className="text-teal-300">.env</code>, <code className="text-teal-300">.pem</code>, or{' '}
          <code className="text-teal-300">.key</code> in commits; critical framework files can&apos;t be deleted or
          blanked; npm runs in containers only; and the shared gateway deploys only from the master checkout.
        </p>
      </Section>

      <Section heading="7. Vulnerability disclosure">
        <p>
          Report privately via{' '}
          <a
            href="https://github.com/knofler/ai_management/security/advisories/new"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            GitHub Security Advisories
          </a>{' '}
          (preferred), or email the maintainer with subject <code className="text-teal-300">[SECURITY] myAI</code>.
          Response targets: acknowledgement within 72 hours, triage within 7 days, fix or documented mitigation for
          confirmed issues within 30 days. Good-faith research against your own installation is welcome. Please do not
          open public issues for unpatched vulnerabilities.
        </p>
      </Section>

      <Section heading="8. Bug bounty program">
        <p>
          Beyond the passive channel above, myAI runs a standing, paid bounty program for in-scope findings —
          gateway/dashboard auth, tenant isolation, webhook verification, export redaction, the always-on safety
          hooks, default Docker Compose exposure, and the elevated-trust CLI/setup scripts. Payouts range{' '}
          <strong className="text-zinc-200">$25–$1,500</strong> by severity (Low → Critical), under a good-faith
          safe-harbor policy. Use the same intake as §7, tagged <code className="text-teal-300">[BUG-BOUNTY]</code>.
          Full scope, payout tiers, safe-harbor terms, and the submission → triage → payout workflow are in{' '}
          <a
            href="https://github.com/knofler/ai_management/blob/main/documentation/BUG_BOUNTY_PROGRAM.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            BUG_BOUNTY_PROGRAM.md
          </a>
          .
        </p>
      </Section>
    </LegalShell>
  );
}
