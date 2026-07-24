// /developers — the public developer portal (distinct from the spec-only
// Redoc/Swagger-style reference the gateway serves itself at /api/docs).
// This is the walkthrough a cold external integrator (Zapier/n8n connector
// author, or anyone scripting against the gateway directly) lands on: how to
// mint an API key, copy-paste curl against the REST and MCP surfaces, and the
// rate-limit / error-code contract they need to handle. No login required —
// see middleware.ts PUBLIC_PREFIXES + app-shell.tsx FULL_BLEED.
//
// The full machine-readable spec still lives at GATEWAY/api/openapi.json,
// rendered at GATEWAY/api/docs (runtime/src/core/openapi.ts) — this page
// links out to that rather than duplicating it.
import Link from 'next/link';
import { CodeBlock } from './code-block';

export const metadata = {
  title: 'myAI Developer Portal',
  description: 'Get an API key, copy-paste curl quickstarts for the REST and MCP gateway, and the rate-limit / error-code contract.',
};

// Same default/override convention as repo-health.tsx + lib/gateway.ts —
// NEXT_PUBLIC_* is inlined at build time, so this resolves identically in a
// server or client component.
const REST_BASE = process.env.NEXT_PUBLIC_GATEWAY_URL || 'http://localhost:3200';
const MCP_BASE = process.env.NEXT_PUBLIC_GATEWAY_MCP_URL || 'http://localhost:3100';

const SCOPES: { scope: string; grants: string }[] = [
  { scope: '*', grants: 'Full access — every tool family below.' },
  { scope: 'brain:read', grants: 'Read brain namespaces, atoms, and search.' },
  { scope: 'brain:write', grants: 'Commit, stash, merge brain atoms.' },
  { scope: 'tasks:read', grants: 'List and read the cross-repo task queue.' },
  { scope: 'tasks:write', grants: 'Create, claim, update, and fail tasks.' },
  { scope: 'memory:read', grants: 'Search SONA memory / RAG context.' },
  { scope: 'memory:write', grants: 'Store new memory chunks.' },
  { scope: 'chat', grants: 'Route messages through a session.' },
];

const PLAN_LIMITS: { plan: string; perMin: string; perMonth: string }[] = [
  { plan: 'Free', perMin: '60 req/min', perMonth: '10,000 req/month' },
  { plan: 'Solo', perMin: '300 req/min', perMonth: '200,000 req/month' },
  { plan: 'Team', perMin: '1,000 req/min', perMonth: '2,000,000 req/month' },
  { plan: 'Scale', perMin: 'Unlimited', perMonth: 'Unlimited' },
];

const ERROR_CODES: { code: string; status: string; meaning: string }[] = [
  { code: 'UNAUTHORIZED', status: '401', meaning: 'Missing, malformed, or invalid API key.' },
  { code: 'FORBIDDEN', status: '403', meaning: "Key is valid but the caller's role/capability doesn't permit this route (RBAC v1)." },
  { code: 'RATE_LIMITED', status: '429', meaning: 'Burst rate limit hit (per-plan requests/min). Respect the `Retry-After` header (seconds).' },
  { code: 'QUOTA_EXCEEDED', status: '429', meaning: 'Monthly plan request quota hit. `Retry-After` is seconds until the UTC month rolls over; `limit`/`used` are included in the body.' },
  { code: 'PLAN_LIMIT_EXCEEDED', status: '402', meaning: 'A plan resource cap (e.g. connected repos) was exceeded — upgrade to proceed.' },
  { code: 'REGION_MISMATCH', status: '403', meaning: 'Tenant is pinned to a data-residency region this gateway endpoint does not serve (ADR-023). Body includes the correct regional endpoint.' },
  { code: 'BAD_REQUEST', status: '400', meaning: 'Request body/params failed validation.' },
  { code: 'NOT_FOUND', status: '404', meaning: 'Resource does not exist (or is not visible to this tenant).' },
  { code: 'SESSION_REVOKED', status: '401', meaning: 'The session/device behind this call was revoked — re-authenticate.' },
  { code: 'ADMIN_DISABLED', status: '503', meaning: 'An admin-only route was called but no admin token is configured on this deployment.' },
  { code: 'INTERNAL_ERROR', status: '500', meaning: 'Unexpected server error — safe to retry with backoff.' },
];

function Section({ id, step, title, children }: { id: string; step?: number; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-20">
      <h2 className="text-lg font-semibold text-zinc-100 flex items-baseline gap-2">
        {step != null && <span className="text-brand-orange">{step}.</span>}
        {title}
      </h2>
      <div className="mt-3 text-sm text-zinc-400 leading-relaxed space-y-4">{children}</div>
    </section>
  );
}

const TOC = [
  { id: 'api-key', label: '1. Get an API key' },
  { id: 'authenticate', label: '2. Authenticate requests' },
  { id: 'rest-quickstart', label: '3. REST quickstart' },
  { id: 'mcp-quickstart', label: '4. MCP quickstart' },
  { id: 'webhooks', label: '5. Outbound webhooks' },
  { id: 'rate-limits', label: '6. Rate limits & quotas' },
  { id: 'error-codes', label: '7. Error codes' },
];

export default function DevelopersPage() {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      {/* Header */}
      <header className="border-b border-zinc-900">
        <div className="max-w-5xl mx-auto px-5 md:px-8 py-4 flex items-center justify-between">
          <Link href="/welcome" className="font-bold text-brand-orange">
            myAI
          </Link>
          <nav className="flex items-center gap-4 text-xs text-zinc-500">
            <a
              href={`${REST_BASE}/api/docs`}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-zinc-200"
            >
              Full API reference
            </a>
            <Link href="/pricing" className="hover:text-zinc-200">
              Pricing
            </Link>
            <Link href="/login" className="hover:text-zinc-200">
              Sign in
            </Link>
          </nav>
        </div>
      </header>

      {/* Body */}
      <main className="max-w-5xl mx-auto px-5 md:px-8 py-10 md:py-14">
        <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Developer portal</h1>
        <p className="mt-2 text-sm text-zinc-400 max-w-2xl">
          Everything an external integrator needs to call the myAI gateway directly: mint a
          scoped API key, copy-paste curl against the REST and MCP surfaces, and the
          rate-limit / error-code contract to build against. Building a Zapier or n8n
          connector? Start here, then wire outbound webhooks in{' '}
          <a href="#webhooks" className="text-brand-orange hover:underline">
            step 5
          </a>
          .
        </p>
        <p className="mt-2 text-xs text-zinc-500 max-w-2xl">
          Looking for the full endpoint-by-endpoint spec instead?{' '}
          <a href={`${REST_BASE}/api/docs`} target="_blank" rel="noopener noreferrer" className="text-brand-orange hover:underline">
            Browse the OpenAPI reference
          </a>{' '}
          (machine-readable spec at{' '}
          <code className="text-zinc-400">/api/openapi.json</code>).
        </p>

        {/* Table of contents */}
        <nav className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          {TOC.map((t) => (
            <a key={t.id} href={`#${t.id}`} className="text-zinc-500 hover:text-zinc-200">
              {t.label}
            </a>
          ))}
        </nav>

        <div className="mt-10 space-y-12">
          <Section id="api-key" step={1} title="Get an API key">
            <p>
              API keys are scoped and rotatable per tenant (ADR-010 §3.6). The raw key is shown{' '}
              <strong>once</strong>, at creation — myAI never stores or displays it again, so copy
              it into a secrets manager immediately.
            </p>
            <ol className="list-decimal pl-5 space-y-2">
              <li>
                <Link href="/welcome/start" className="text-brand-orange hover:underline">
                  Sign up
                </Link>{' '}
                for a tenant (or{' '}
                <Link href="/login" className="text-brand-orange hover:underline">
                  sign in
                </Link>{' '}
                if you already have one).
              </li>
              <li>
                Open{' '}
                <Link href="/api-keys" className="text-brand-orange hover:underline">
                  API Keys
                </Link>{' '}
                in the dashboard (owner/admin role required).
              </li>
              <li>
                Click <strong>Create key</strong>. Give it a name, pick an environment
                (<code>live</code> or <code>test</code>), and choose scopes — leave scopes empty
                for full access, or grant only what the integration needs (see the table below).
              </li>
              <li>
                Copy the raw key from the show-once banner. It looks like{' '}
                <code className="text-zinc-300">myai_live_8Kf2…</code> — the prefix is safe to log,
                the rest is not.
              </li>
            </ol>
            <p className="text-xs text-zinc-500">
              Rotating a key (same page) keeps the old one valid for a 60-minute grace window by
              default, so you can swap credentials with zero downtime. Revoking is instant, no
              grace.
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-xs">
                <thead className="bg-zinc-900/60 text-zinc-500">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Scope</th>
                    <th className="text-left px-3 py-2 font-medium">Grants</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {SCOPES.map((s) => (
                    <tr key={s.scope}>
                      <td className="px-3 py-2 font-mono text-zinc-300 whitespace-nowrap">{s.scope}</td>
                      <td className="px-3 py-2 text-zinc-400">{s.grants}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="authenticate" step={2} title="Authenticate your requests">
            <p>
              Send the key as a bearer token, or via the dedicated header — both are accepted
              identically on every REST and MCP route:
            </p>
            <CodeBlock
              label="either header works"
              code={`Authorization: Bearer myai_live_8Kf2...\n# — or —\nx-api-key: myai_live_8Kf2...`}
            />
            <p className="text-xs text-zinc-500">
              A missing or invalid key on a route that requires one returns{' '}
              <code>401 UNAUTHORIZED</code> — see the full error-code table in step 7.
            </p>
          </Section>

          <Section id="rest-quickstart" step={3} title="REST quickstart">
            <p>
              The REST gateway is a plain JSON HTTP API. <code>/health</code> is unauthenticated —
              a good first call to confirm you can reach the endpoint at all:
            </p>
            <CodeBlock
              label="curl — health check (no auth)"
              code={`curl ${REST_BASE}/health`}
            />
            <p>List your tenant's task queue:</p>
            <CodeBlock
              label="curl — list tasks"
              code={`curl ${REST_BASE}/api/tasks \\\n  -H "Authorization: Bearer $MYAI_API_KEY"`}
            />
            <p>Queue a new task:</p>
            <CodeBlock
              label="curl — create a task"
              code={`curl -X POST ${REST_BASE}/api/tasks \\\n  -H "Authorization: Bearer $MYAI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "repo": "my-app",\n    "title": "Sync inventory from Zapier",\n    "priority": "P2"\n  }'`}
            />
          </Section>

          <Section id="mcp-quickstart" step={4} title="MCP quickstart">
            <p>
              The same gateway also speaks{' '}
              <a
                href="https://modelcontextprotocol.io"
                target="_blank"
                rel="noopener noreferrer"
                className="text-brand-orange hover:underline"
              >
                MCP
              </a>{' '}
              (JSON-RPC 2.0 over streamable HTTP) at a single <code>POST /mcp</code> endpoint —
              same auth header, same API key. Handshake first:
            </p>
            <CodeBlock
              label="curl — initialize"
              code={`curl -X POST ${MCP_BASE}/mcp \\\n  -H "Authorization: Bearer $MYAI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}'`}
            />
            <p>Discover the available tools:</p>
            <CodeBlock
              label="curl — tools/list"
              code={`curl -X POST ${MCP_BASE}/mcp \\\n  -H "Authorization: Bearer $MYAI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'`}
            />
            <p>
              Call one — <code>tasks_list</code> mirrors the REST <code>GET /api/tasks</code>{' '}
              example above:
            </p>
            <CodeBlock
              label="curl — tools/call"
              code={`curl -X POST ${MCP_BASE}/mcp \\\n  -H "Authorization: Bearer $MYAI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "jsonrpc": "2.0",\n    "id": 3,\n    "method": "tools/call",\n    "params": { "name": "tasks_list", "arguments": { "repo": "my-app" } }\n  }'`}
            />
            <p className="text-xs text-zinc-500">
              Add an <code>Idempotency-Key</code> header on write tools (e.g. <code>tasks_create</code>)
              to safely retry a call without double-creating the resource.
            </p>
          </Section>

          <Section id="webhooks" step={5} title="Outbound webhooks (Zapier / n8n)">
            <p>
              Rather than polling, register an HTTPS endpoint and subscribe to lifecycle events —
              this is the trigger side of a Zapier or n8n connector. Each matching event delivers
              an HMAC-signed POST with at-least-once delivery.
            </p>
            <CodeBlock
              label="curl — register a webhook"
              code={`curl -X POST ${REST_BASE}/api/webhooks \\\n  -H "Authorization: Bearer $MYAI_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "url": "https://hooks.zapier.com/hooks/catch/xxxx/yyyy/",\n    "events": ["task.completed", "task.blocked"]\n  }'`}
            />
            <p className="text-xs text-zinc-500">
              Valid event names: <code>task.created</code>, <code>task.claimed</code>,{' '}
              <code>task.review</code>, <code>task.blocked</code>, <code>task.completed</code>,{' '}
              <code>plan.updated</code>, <code>runner.fired</code> — or <code>["*"]</code> for all
              of them. Verify deliveries with the <code>X-Myai-Signature</code> header (HMAC of the
              raw body using the secret returned once at creation); the event name and a delivery
              id ride along on <code>X-Myai-Event</code> / <code>X-Myai-Delivery</code>.
            </p>
          </Section>

          <Section id="rate-limits" step={6} title="Rate limits & quotas">
            <p>Two independent limits apply per tenant, both plan-scoped:</p>
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-xs">
                <thead className="bg-zinc-900/60 text-zinc-500">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Plan</th>
                    <th className="text-left px-3 py-2 font-medium">Burst (per minute)</th>
                    <th className="text-left px-3 py-2 font-medium">Monthly quota</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {PLAN_LIMITS.map((p) => (
                    <tr key={p.plan}>
                      <td className="px-3 py-2 text-zinc-300">{p.plan}</td>
                      <td className="px-3 py-2 font-mono text-zinc-400">{p.perMin}</td>
                      <td className="px-3 py-2 font-mono text-zinc-400">{p.perMonth}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Exceeding either returns <code>429</code> with a <code>Retry-After</code> header
              (seconds to wait) and a JSON body carrying the code:
            </p>
            <CodeBlock
              label="429 — burst limit"
              code={`HTTP/1.1 429 Too Many Requests\nRetry-After: 12\n\n{ "error": "Too many requests", "code": "RATE_LIMITED", "retryAfter": 12 }`}
            />
            <CodeBlock
              label="429 — monthly quota"
              code={`HTTP/1.1 429 Too Many Requests\nRetry-After: 1382400\n\n{\n  "error": "monthly request quota exceeded — upgrade your plan or wait for the next billing period",\n  "code": "QUOTA_EXCEEDED",\n  "retryAfter": 1382400,\n  "limit": 10000,\n  "used": 10000\n}`}
            />
            <p className="text-xs text-zinc-500">
              Back off exponentially on <code>RATE_LIMITED</code>; on <code>QUOTA_EXCEEDED</code>{' '}
              either wait for the UTC month to roll over or upgrade the plan from{' '}
              <Link href="/pricing" className="text-brand-orange hover:underline">
                Pricing
              </Link>
              .
            </p>
          </Section>

          <Section id="error-codes" step={7} title="Error codes">
            <p>
              Every rejected request returns a flat JSON body — <code>{'{ error, code }'}</code> at
              minimum, never the offending key. <code>code</code> is the stable field to branch on;
              the message text may change.
            </p>
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-xs">
                <thead className="bg-zinc-900/60 text-zinc-500">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Code</th>
                    <th className="text-left px-3 py-2 font-medium">HTTP</th>
                    <th className="text-left px-3 py-2 font-medium">Meaning</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-900">
                  {ERROR_CODES.map((e) => (
                    <tr key={e.code}>
                      <td className="px-3 py-2 font-mono text-zinc-300 whitespace-nowrap">{e.code}</td>
                      <td className="px-3 py-2 font-mono text-zinc-400">{e.status}</td>
                      <td className="px-3 py-2 text-zinc-400">{e.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-zinc-900">
        <div className="max-w-5xl mx-auto px-5 md:px-8 py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-600">
          <span className="font-bold text-brand-orange">myAI</span>
          <div className="flex items-center gap-4">
            <a href={`${REST_BASE}/api/docs`} target="_blank" rel="noopener noreferrer" className="hover:text-zinc-400">
              API reference
            </a>
            <Link href="/pricing" className="hover:text-zinc-400">
              Pricing
            </Link>
            <Link href="/security" className="hover:text-zinc-400">
              Security
            </Link>
            <Link href="/privacy" className="hover:text-zinc-400">
              Privacy
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
