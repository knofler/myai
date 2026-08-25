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

const RETENTION_HOSTED: { collection: string; window: string; env: string }[] = [
  { collection: 'Task rows (terminal: done / dead_letter)', window: '90 days', env: 'TASK_RETENTION_DAYS' },
  { collection: 'PlanDay rows (terminal: done)', window: '180 days', env: 'PLAN_RETENTION_DAYS' },
  { collection: 'Audit log day-files', window: '400 days', env: 'AUDIT_RETENTION_DAYS' },
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
  return <th className="text-left font-medium text-[rgb(var(--text-primary))] px-3 py-2 border-b border-[rgb(var(--border-subtle))]">{children}</th>;
}
function Td({ children }: { children: React.ReactNode }) {
  return <td className="px-3 py-2 border-b border-[rgb(var(--border-subtle))] text-[rgb(var(--text-secondary))] align-top">{children}</td>;
}

export default function SecurityPage() {
  return (
    <LegalShell
      title="Security & Data Locality"
      updated="2026-08-16"
      intro={
        <>
          <strong className="text-[rgb(var(--text-primary))]">The headline guarantee: your context never leaves your machine.</strong>{' '}
          Every byte of agent memory — session state, handoffs, brain atoms, the embedded recall corpus — lives in a
          database container on your hardware and is embedded by a model running in-process on your CPU. In the default
          configuration, myAI makes <strong className="text-[rgb(var(--text-primary))]">zero outbound network calls</strong>. This page is
          a plain-English summary of{' '}
          <a
            href="https://github.com/knofler/myai/blob/main/SECURITY.md"
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
        <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
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
          Nothing below is contacted unless <strong className="text-[rgb(var(--text-primary))]">you</strong> put a credential in{' '}
          <code className="text-teal-300">.env</code>. No credential → no call. There is no telemetry, no phone-home, no
          silent upload — and none of these destinations ever receive your memory corpus.
        </p>
        <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
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

      <Section heading="3. BYO-model-key posture">
        <p>
          myAI does not sell inference. There is no default LLM key baked into the product, no proxy that routes your
          prompts through our infrastructure, and no usage-based inference billing on our side. Every model call is made{' '}
          <strong className="text-[rgb(var(--text-primary))]">from your machine, with your own API key, directly to the provider you
          chose</strong> — we never see the key, the prompt, or the response, because we don&apos;t operate any request path
          between you and the model vendor. That keeps our COGS on inference at zero and means your prompts stay governed
          by your own agreement with your own model vendor. The only thing we ever hold is the minimal hosted account and
          billing record for a paid subscription tier — see the{' '}
          <a href="/privacy" className="text-teal-300 hover:underline">
            Privacy Policy
          </a>{' '}
          for that list — never inference traffic.
        </p>
      </Section>

      <Section heading="4. Retention windows">
        <p>
          Your local memory corpus is retained until <strong className="text-[rgb(var(--text-primary))]">you</strong> delete it —
          there is no server-side copy to separately purge. State-file rotation moves older sessions into a local archive
          rather than deleting them, and the brain store is git-versioned, so it persists per your own repo history.
        </p>
        <p>
          Hosted account/control-plane data (only relevant if you run the multi-tenant gateway) ages out on fixed,
          env-configurable windows, unless a tenant is flagged for legal hold:
        </p>
        <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
          <table className="w-full text-sm border-collapse">
            <thead>
              <tr>
                <Th>Collection</Th>
                <Th>Default window</Th>
                <Th>Env override</Th>
              </tr>
            </thead>
            <tbody>
              {RETENTION_HOSTED.map((r) => (
                <tr key={r.collection}>
                  <Td>{r.collection}</Td>
                  <Td>{r.window}</Td>
                  <Td>{r.env}</Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          User-initiated right-to-erasure requests purge after a 14-day grace window; a billing-driven cancellation purge
          runs after 30 days and additionally wipes the audit trail. Full detail is in SECURITY.md §2.
        </p>
      </Section>

      <Section heading="5. Ports, tokens & authentication">
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

      <Section heading="6. Memory export is secret-scanned">
        <p>
          The one bundle designed to leave the machine (migration, backup, hand-off) is scanned with the same secret
          patterns the commit hook enforces, and matches are redacted in place before anything is written. If the
          pattern library is missing, export refuses to write an unscanned bundle rather than failing open.
        </p>
      </Section>

      <Section heading="7. Threat model (summary)">
        <div className="overflow-x-auto rounded-lg border border-[rgb(var(--border-subtle))]">
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
        <p className="text-xs text-[rgb(var(--text-muted))]">
          Full STRIDE analysis, ports diagram, and the hardening checklist are in SECURITY.md.
        </p>
      </Section>

      <Section heading="8. Guardrail model — how autonomous agents are kept on a leash">
        <p>
          The autonomous runner executes code changes, commits, and pushes without a human watching every action.
          Guardrails hold regardless of permission mode (interactive, timed YOLO, or god-mode YOLO):
        </p>
        <ul className="list-disc pl-5 space-y-2">
          <li>
            <strong className="text-[rgb(var(--text-primary))]">Hooks are always-on, not a permission-mode feature</strong> — no
            direct pushes to main; no credentials, <code className="text-teal-300">.env</code>,{' '}
            <code className="text-teal-300">.pem</code>, or <code className="text-teal-300">.key</code> in commits; critical
            framework files can&apos;t be deleted or blanked; npm runs in containers only; the shared gateway deploys only
            from the master checkout. YOLO mode does not disable any of these.
          </li>
          <li>
            <strong className="text-[rgb(var(--text-primary))]">Autonomy is scoped, not unlimited</strong> — timed YOLO
            auto-expires; god-mode YOLO auto-deactivates on the next commit or plan completion. Destructive git operations
            (force-push, hard reset, branch deletion) stay behind explicit confirmation even inside YOLO.
          </li>
          <li>
            <strong className="text-[rgb(var(--text-primary))]">Failure is bounded</strong> — a 3-strikes rule stops an agent
            that fails the same fix three times running, rather than retrying forever against production state.
          </li>
          <li>
            <strong className="text-[rgb(var(--text-primary))]">Every task runs in an isolated worktree</strong>, so a
            runaway task can only merge output through the same test-branch → PR path every human contributor uses.
          </li>
          <li>
            <strong className="text-[rgb(var(--text-primary))]">Fully auditable after the fact</strong> — runner transcripts,
            git history, and the gateway&apos;s task audit trail answer &ldquo;what did the autonomous runner do
            overnight.&rdquo;
          </li>
        </ul>
      </Section>

      <Section heading="9. Vulnerability disclosure">
        <p>
          Report privately via{' '}
          <a
            href="https://github.com/knofler/myai/security/advisories/new"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            GitHub Security Advisories
          </a>{' '}
          and click <strong className="text-[rgb(var(--text-primary))]">&quot;Report a vulnerability&quot;</strong> — title it{' '}
          <code className="text-teal-300">[SECURITY] myAI</code>. This is the supported private channel; there is no
          email intake. Response targets: acknowledgement within 72 hours, triage within 7 days, fix or documented
          mitigation for confirmed issues within 30 days. Good-faith research against your own installation is welcome
          and credited in the release notes on request. This is a responsible-disclosure program only — there is no
          paid bounty. Please do not open public issues for unpatched vulnerabilities.
        </p>
      </Section>
    </LegalShell>
  );
}
