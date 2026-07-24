// Public /terms page — the Terms of Service a buyer accepts before paying.
// Covers both editions: the self-hosted software (MIT-licensed, "as is") and
// the optional hosted/paid subscription. Grounded in the actual architecture:
// the customer runs the software and owns their data, so the vendor's liability
// surface is deliberately narrow. Reachable without a login (middleware
// PUBLIC_PREFIXES + AppShell FULL_BLEED).
import { LegalShell, Section, Bullets } from '@/components/legal-shell';

export const metadata = {
  title: 'Terms of Service — myAI',
  description:
    'The terms governing use of the myAI self-hosted software and the optional hosted subscription: license, acceptable use, subscriptions & billing, warranty, and liability.',
};

export default function TermsPage() {
  return (
    <LegalShell
      title="Terms of Service"
      updated="2026-07-06"
      intro={
        <>
          These terms govern your use of myAI, an AI management framework distributed as self-hostable software and
          offered with an optional hosted subscription. By installing, running, or subscribing to myAI you agree to
          these terms. If you are accepting on behalf of an organisation, you confirm you have authority to bind it.
        </>
      }
    >
      <Section heading="1. The software & your license">
        <p>
          The myAI software is released under the{' '}
          <a
            href="https://github.com/knofler/myai/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            MIT License
          </a>
          . That license governs your rights to use, copy, modify, and distribute the code. Nothing in these terms
          reduces the rights the MIT License grants you over the software itself; these terms add conditions for the
          hosted service and clarify acceptable use.
        </p>
      </Section>

      <Section heading="2. Self-hosted use — your responsibilities">
        <p>When you run myAI on your own hardware you are the operator. You are responsible for:</p>
        <Bullets
          items={[
            'Securing your deployment — credentials in .env, host binding, and the hardening checklist in SECURITY.md.',
            'Any API keys and third-party accounts you configure, and all costs and terms those providers impose.',
            'The code the autonomous runner executes and anything it commits or deploys on your behalf.',
            'Backups of your memory corpus and repositories — the data is yours and lives on your machine.',
          ]}
        />
      </Section>

      <Section heading="3. Hosted subscription & billing">
        <p>If you subscribe to a paid, vendor-hosted tier:</p>
        <Bullets
          items={[
            'Fees, billing cycle, and included limits are shown at checkout. Subscriptions renew automatically until cancelled.',
            'Payments are processed by Stripe; you authorise recurring charges to your chosen payment method.',
            'You may cancel at any time; access continues to the end of the paid period. Fees already paid are non-refundable except where required by law.',
            'We may change pricing with reasonable notice before your next renewal; continued use after the change means acceptance.',
            'We may suspend or terminate an account for non-payment or breach of these terms.',
          ]}
        />
      </Section>

      <Section heading="4. Acceptable use">
        <p>You agree not to use myAI to:</p>
        <Bullets
          items={[
            'Break the law, infringe others’ rights, or violate a third-party provider’s terms.',
            'Attack, overload, probe, or reverse-engineer the hosted service beyond the safe-harbour research described in SECURITY.md.',
            'Resell the hosted service as your own without authorisation, or misrepresent its origin.',
            'Generate or distribute content that is unlawful, harmful, or abusive.',
          ]}
        />
      </Section>

      <Section heading="5. Intellectual property">
        <p>
          The myAI name and marks belong to the maintainer. Your data, repositories, and the output your agents produce
          are yours. Feedback you send us may be used to improve the product without obligation to you.
        </p>
      </Section>

      <Section heading="6. Warranty disclaimer">
        <p>
          The software and the hosted service are provided <strong className="text-zinc-200">&ldquo;as is&rdquo;</strong>{' '}
          and <strong className="text-zinc-200">&ldquo;as available&rdquo;</strong>, without warranties of any kind,
          express or implied, including merchantability, fitness for a particular purpose, and non-infringement. myAI
          orchestrates autonomous agents that write and run code; you are responsible for reviewing their output before
          relying on it in production.
        </p>
      </Section>

      <Section heading="7. Limitation of liability">
        <p>
          To the maximum extent permitted by law, the maintainer will not be liable for any indirect, incidental,
          special, consequential, or punitive damages, or for lost profits, data, or business, arising from your use of
          myAI. For the hosted service, total aggregate liability is limited to the amounts you paid in the twelve months
          before the claim. Some jurisdictions do not allow these limits, so they may not apply to you.
        </p>
      </Section>

      <Section heading="8. Changes & contact">
        <p>
          We may update these terms; material changes will be posted here with a new &ldquo;Last updated&rdquo; date, and
          for the hosted service we will give reasonable notice. Questions: open a thread via{' '}
          <a
            href="https://github.com/knofler/myai"
            target="_blank"
            rel="noopener noreferrer"
            className="text-teal-300 hover:underline"
          >
            the repository
          </a>{' '}
          or email the maintainer listed in the repo profile.
        </p>
        <p className="text-xs text-zinc-500">
          This is a template, not legal advice; have counsel review it against your jurisdiction and business before
          relying on it commercially.
        </p>
      </Section>
    </LegalShell>
  );
}
