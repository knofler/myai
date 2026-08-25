/**
 * brain-search-dataset — a small, hand-labelled query→atom gold set for the
 * `brain_search` (searchAtoms) eval harness (BRAIN W3.2).
 *
 * Fixture atoms mimic real brain content (session/handoff/memory atoms across
 * several repo namespaces plus cross-repo memory) so the harness exercises the
 * real `writeAtom` → `searchAtoms` path end-to-end with no gateway or Mongo.
 * Each labelled query names the atom slug(s) a correct search MUST surface.
 * Keep it small and curated — this is a regression *fixture*, not the
 * production brain. Add a labelled row whenever a real recall miss is found.
 */

export type FixtureAtomKind = 'session' | 'handoff' | 'memory';

export interface FixtureAtom {
  /** Unique slug — also the ground-truth id queries are labelled against. */
  slug: string;
  kind: FixtureAtomKind;
  /** Repo namespace; omit for cross-repo memory atoms. */
  repo?: string;
  topic: string;
  content: string;
}

export interface LabelledAtomQuery {
  query: string;
  /** Atom slugs that are relevant answers (the gold set). */
  relevant: string[];
  /** Narrow the search to one repo namespace, mirroring searchAtoms({ repo }). */
  repo?: string;
}

export interface BrainSearchDataset {
  atoms: FixtureAtom[];
  queries: LabelledAtomQuery[];
  /**
   * Queries with NO correct atom in the fixture set at all — a sanity check
   * that the retriever doesn't hallucinate hits, not a recall/precision case
   * (precision/recall are undefined when the relevant set is empty, so these
   * are scored separately as a false-positive check, not folded into the
   * aggregate metrics).
   */
  noMatchQueries: string[];
}

const REPO = 'ai_management';
const CONNECT = 'connect';

export const BRAIN_SEARCH_DATASET: BrainSearchDataset = {
  atoms: [
    {
      slug: 'gateway-image-stale-fix',
      kind: 'session',
      repo: REPO,
      topic: 'gateway-infra',
      content:
        'Session: fixed the gateway image staleness detector — machine_selfheal now compares the built image timestamp against runtime/ mtimes and flags a rebuild instead of silently running stale code. Fix: docker compose build gateway && docker compose up -d gateway.',
    },
    {
      slug: 'mongo-atlas-vector-search',
      kind: 'session',
      repo: REPO,
      topic: 'gateway-infra',
      content:
        'Session: wired Atlas $vectorSearch as the server-side ANN path for recallSession with tenant isolation pinned in the pre-filter, falling back to the embedded LSH index when the Atlas index is missing.',
    },
    {
      slug: 'stripe-billing-checkout',
      kind: 'session',
      repo: REPO,
      topic: 'billing',
      content:
        'Session: added Stripe checkout session creation and webhook handling for subscription billing — invoice.paid updates the tenant plan tier, checkout.session.completed provisions the seat.',
    },
    {
      slug: 'revenue-dashboard-handoff',
      kind: 'handoff',
      repo: REPO,
      topic: 'billing',
      content:
        'Handoff: revenue dashboard in progress — MRR, ARR, churn and LTV computed from Stripe subscription events, annual and promo billing plus doctor --fix auto-remediation still pending.',
    },
    {
      slug: 'two-tier-state-rotation',
      kind: 'session',
      repo: REPO,
      topic: 'continuity',
      content:
        'Session: split STATE.md into a hot tier (top 3 sessions) and a cold archive tier. rotate_state.sh pushes the 4th-oldest session block into a month bucket. Fixed agent mode startup breaking on a 41k-token STATE.md.',
    },
    {
      slug: 'handoff-staleness-hook',
      kind: 'session',
      repo: REPO,
      topic: 'continuity',
      content:
        'Session: added the CHECKPOINT OVERDUE hook — handoff-staleness.sh fires when AI_AGENT_HANDOFF.md is stale and 40+ weighted tool calls have accrued since the last write, nudging a checkpoint commit.',
    },
    {
      slug: 'ghsa-token-leak-fix',
      kind: 'session',
      repo: REPO,
      topic: 'security',
      content:
        'Session: closed the GHSA advisory — a debug endpoint was leaking session tokens in error responses. Added redaction middleware and a regression test asserting 401 on the unauthenticated path.',
    },
    {
      slug: 'rbac-role-gating',
      kind: 'session',
      repo: REPO,
      topic: 'security',
      content:
        'Session: added role-gated RBAC checks to brain_namespace_share and brain_host_provision — only the configure role can grant cross-tenant namespace access.',
    },
    {
      slug: 'bug-report-triage',
      kind: 'session',
      repo: CONNECT,
      topic: 'general',
      content:
        'Session: Connect Hub bug-report triage flow — auto-labels new BugReport documents by severity heuristics and assigns to the owning specialist agent.',
    },
    {
      slug: 'feature-request-backlog',
      kind: 'handoff',
      repo: CONNECT,
      topic: 'general',
      content:
        'Handoff: feature-request backlog groomed — top 5 requests ranked by RICE score, MVP scope trimmed to the must-haves for the next milestone.',
    },
    {
      slug: 'npm-publish-mirror-policy',
      kind: 'memory',
      topic: 'distribution',
      content:
        'Memory: a version release is a two-repo deal — npm publish must run alongside publish_public_mirror.sh so the public showcase mirror never drifts from the published package.',
    },
    {
      slug: 'schedule-consent-list',
      kind: 'memory',
      topic: 'runner-ops',
      content:
        'Memory: repos in schedule_ignore.txt get no autonomous scheduled work without explicit user consent — schedule_task.sh and push_schedule.sh both refuse to queue them silently.',
    },
    {
      slug: 'brain-w14-observe-tool',
      kind: 'session',
      repo: REPO,
      topic: 'brain',
      content:
        'Session: brain_observe MCP tool added, writing to the same scratch/ ring buffer the W1.1 hook already appends to — same append semantics, exposed as a callable tool instead of only a hook.',
    },
    {
      slug: 'openapi-scalar-docs',
      kind: 'session',
      repo: REPO,
      topic: 'docs',
      content:
        'Session: added the OpenAPI 3.0 spec at /api/openapi.json and wired Scalar interactive docs at /docs so every new endpoint has a documented contract before merge.',
    },
  ],

  queries: [
    { query: 'gateway image stale rebuild machine selfheal', relevant: ['gateway-image-stale-fix'] },
    { query: 'atlas vector search tenant isolation ann fallback', relevant: ['mongo-atlas-vector-search'] },
    { query: 'stripe checkout webhook subscription billing', relevant: ['stripe-billing-checkout'] },
    { query: 'MRR ARR churn revenue dashboard', relevant: ['revenue-dashboard-handoff'] },
    { query: 'STATE.md hot cold tier rotation archive', relevant: ['two-tier-state-rotation'] },
    { query: 'checkpoint overdue handoff stale hook', relevant: ['handoff-staleness-hook'] },
    { query: 'GHSA token leak redaction security advisory', relevant: ['ghsa-token-leak-fix'] },
    { query: 'RBAC role gated namespace share configure', relevant: ['rbac-role-gating'] },
    { query: 'bug report triage severity connect hub', relevant: ['bug-report-triage'], repo: CONNECT },
    { query: 'feature request backlog RICE MVP', relevant: ['feature-request-backlog'] },
    { query: 'npm publish public mirror release', relevant: ['npm-publish-mirror-policy'] },
    { query: 'schedule consent ignore list autonomous', relevant: ['schedule-consent-list'] },
    { query: 'brain observe scratch ring buffer mcp tool', relevant: ['brain-w14-observe-tool'] },
    { query: 'openapi scalar docs endpoint spec', relevant: ['openapi-scalar-docs'] },
    // Both atoms mention billing/Stripe — a correct retriever surfaces both.
    { query: 'billing', relevant: ['stripe-billing-checkout', 'revenue-dashboard-handoff'] },
    // Paraphrase with no deliberate keyword overlap with the atom body — a
    // stress case for the pure term-frequency scorer. Whether it lands at
    // rank 1 or gets buried behind common-word substring noise (see the
    // benchmark report's per-query table) is exactly the headroom this
    // fixture exists to make visible before any semantic/embedding tuning.
    {
      query: "prevent one customer's data from leaking into another customer's search results",
      relevant: ['mongo-atlas-vector-search'],
    },
  ],

  noMatchQueries: [
    'kubernetes helm chart ingress nginx',
    'watercolor painting brush technique canvas',
    'penguin migration antarctic glacier',
  ],
};
