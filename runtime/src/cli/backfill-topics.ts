/**
 * backfill-topics CLI — ADR-020 one-time topic backfill over the brain store.
 *
 *   npx tsx src/cli/backfill-topics.ts                 # dry-run (default): table only
 *   npx tsx src/cli/backfill-topics.ts --llm           # + agents_invoke budget-tier pass on ambiguous atoms
 *   npx tsx src/cli/backfill-topics.ts --apply         # write topic: tags on idea/topic-backfill
 *   npx tsx src/cli/backfill-topics.ts --repo ai-management --report state/reports/topic-backfill.md
 *
 * Host-npm rule: run via Docker (`docker run --rm -v "$PWD":/w -w /w/runtime node:22 …`)
 * or through the gateway container — never bare npx on the host.
 *
 * The --llm pass calls the gateway's `agents_invoke` MCP tool (tier=budget —
 * the cheap classification tier) once per ambiguous atom, capped by --llm-max.
 * A gateway that is down, or a reply that is not EXACTLY a BRAIN_TOPICS slug,
 * leaves the atom in the drift report — the pass can only improve the plan,
 * never corrupt it. Apply stays on a review branch: merge with
 * `myai brain merge idea/topic-backfill` after spot-checking the report, then
 * `myai brain distill` recompiles the multi-branch GOLD TOC.
 */

import { parseArgs } from 'node:util';
import { writeFileSync } from 'node:fs';
import { BRAIN_TOPICS } from '../core/brain.js';
import {
  applyTopicBackfill,
  planTopicBackfill,
  refinePlan,
  renderBackfillReport,
  type ScannedAtom,
} from '../core/backfill-topics.js';

const { values: args } = parseArgs({
  options: {
    apply: { type: 'boolean', default: false },
    llm: { type: 'boolean', default: false },
    repo: { type: 'string' },
    branch: { type: 'string', default: 'idea/topic-backfill' },
    report: { type: 'string' },
    agent: { type: 'string', default: 'documentation-specialist' },
    'llm-max': { type: 'string', default: '40' },
  },
});

const SLUGS = BRAIN_TOPICS.filter((t) => t !== 'general').join(', ');

async function agentsInvokeClassify(atom: ScannedAtom): Promise<string | undefined> {
  const mcp = process.env.GATEWAY_MCP || 'http://localhost:3100/mcp';
  const token = process.env.GATEWAY_LOCAL_TOKEN || 'myai-local-bridge-dev';
  const message = [
    `Classify this agent-memory atom into exactly ONE topic slug from: ${SLUGS}.`,
    'Reply with ONLY the slug — no punctuation, no explanation.',
    '',
    `slug: ${atom.slug}`,
    `kind: ${atom.kind}${atom.ns ? ` · repo: ${atom.ns}` : ''}`,
    '',
    atom.body.slice(0, 1500),
  ].join('\n');
  const res = await fetch(mcp, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-gateway-local-token': token },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'agents_invoke',
        arguments: { agent: args.agent, message, tier: 'budget', maxTokens: 16 },
      },
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  const rpc = (await res.json()) as { result?: { content?: Array<{ text?: string }> } };
  const text = rpc.result?.content?.[0]?.text ?? '';
  // The agent reply may be JSON-wrapped or chatty — extract the first known slug.
  const lower = text.toLowerCase();
  return BRAIN_TOPICS.find((t) => t !== 'general' && lower.includes(t));
}

let plan = planTopicBackfill({ repo: args.repo });

if (args.llm) {
  const cap = Math.max(0, Number(args['llm-max']) || 0);
  let used = 0;
  plan = await refinePlan(plan, async (atom) => {
    if (used >= cap) return undefined;
    used++;
    return agentsInvokeClassify(atom);
  });
  console.error(`[llm] budget-tier classification calls used: ${used}/${cap}`);
}

let mode = args.llm ? 'dry-run+llm' : 'dry-run';
if (args.apply) {
  const result = applyTopicBackfill(plan, { branch: args.branch });
  mode = `apply → ${result.branch}`;
  console.error(
    `[apply] ${result.updated.length} atom(s) tagged on ${result.branch}` +
      (result.alreadyTagged.length ? ` · ${result.alreadyTagged.length} already tagged (no-op)` : '') +
      (result.committed ? ` · commit ${result.sha?.slice(0, 8)}` : ' · nothing to commit') +
      ` — review the report, then \`myai brain merge ${result.branch}\``,
  );
}

const report = renderBackfillReport(plan, { mode });
if (args.report) {
  writeFileSync(args.report, report + '\n');
  console.error(`[report] written to ${args.report}`);
} else {
  console.log(report);
}
