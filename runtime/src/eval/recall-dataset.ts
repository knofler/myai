/**
 * recall-dataset — a small, hand-labelled query→session gold set for the
 * recall_session eval harness (RAG Phase B).
 *
 * The corpus mimics the real recall sources (STATE.md blocks, handoff notes,
 * rotated archive sessions) so the harness can run end-to-end with no live
 * gateway or Mongo. Each query names the session id(s) a good retriever MUST
 * surface. Keep it small and curated — this is a regression *fixture*, not the
 * production corpus. Add a labelled row whenever a real recall miss is found.
 */

export interface CorpusDoc {
  id: string;
  source: 'state' | 'handoff' | 'archive';
  repo: string;
  /** The block text that gets embedded / indexed. */
  content: string;
}

export interface LabelledQuery {
  query: string;
  /** Session ids that are relevant answers (the gold set). */
  relevant: string[];
}

export interface RecallDataset {
  corpus: CorpusDoc[];
  queries: LabelledQuery[];
}

const REPO = 'ai_management';

export const RECALL_DATASET: RecallDataset = {
  corpus: [
    {
      id: 'sess-pr347-redoc',
      source: 'archive',
      repo: REPO,
      content:
        'Session 2026-07-07: PR #347 shipped the interactive Redoc API reference generated from the OpenAPI spec. Added docs(api) build step and Swagger UI fallback. Also brain gc compaction landed.',
    },
    {
      id: 'sess-status-page',
      source: 'archive',
      repo: REPO,
      content:
        'Session 2026-07-07: public /status uptime page — gateway + dashboard health history, incident log and runner health aggregation. Tests cover the /status aggregation route.',
    },
    {
      id: 'sess-revenue-dashboard',
      source: 'archive',
      repo: REPO,
      content:
        'Session 2026-07-06: operator revenue dashboard — MRR, ARR, churn and LTV computed from Stripe subscription events. Annual and promo billing plus doctor --fix auto-remediation.',
    },
    {
      id: 'sess-two-tier-state',
      source: 'archive',
      repo: REPO,
      content:
        'Session 2026-05-19: split STATE.md into a hot tier (top 3 sessions) and a cold archive tier. rotate_state.sh pushes the 4th-oldest session block into a month bucket. Fixed agent mode startup breaking on a 41k-token STATE.md.',
    },
    {
      id: 'sess-vector-ann',
      source: 'archive',
      repo: REPO,
      content:
        'Session 2026-06-02: replaced the brute-force cosine scan in vector-store with an embedded random-projection LSH ANN index, cached per filter signature with a TTL. Recall now runs sublinear on the local backend.',
    },
    {
      id: 'sess-atlas-vector-search',
      source: 'archive',
      repo: REPO,
      content:
        'Session 2026-06-10: wired Atlas $vectorSearch as the server-side ANN path with tenant isolation pinned in the pre-filter. Falls back to the embedded index when the Atlas index is missing.',
    },
    {
      id: 'sess-schedule-runner',
      source: 'archive',
      repo: REPO,
      content:
        'Session 2026-06-20: launchd CLI task runner works the gateway queue during the free Fable window. reprioritize_queue.sh caps secondary repos at P3 so the core product tasks always outrank sandbox apps.',
    },
    {
      id: 'sess-zero-prompt',
      source: 'archive',
      repo: REPO,
      content:
        'Session 2026-05-30: zero-prompt policy fleet-wide via committed settings.json bypassPermissions. Safety rails stay active as hooks: block-push-main, secret-scan, protected-files.',
    },
    {
      id: 'sess-handoff-current',
      source: 'handoff',
      repo: REPO,
      content:
        'Handoff: RAG recall-quality eval harness in progress — labelled query set plus precision@k and MRR scoring so threshold and chunking changes are measured, not guessed. Emits a report and a regression baseline.',
    },
    {
      id: 'sess-ci-thrift',
      source: 'state',
      repo: REPO,
      content:
        'State: CI/Vercel thrift policy — CI runs once at PR-to-main, Vercel deploys main only, a pre-push Docker gate verifies locally. local-ci.sh fallback posts green statuses when Actions billing is exhausted.',
    },
  ],
  queries: [
    { query: 'redoc openapi api reference documentation', relevant: ['sess-pr347-redoc'] },
    { query: 'public status page uptime health history', relevant: ['sess-status-page'] },
    { query: 'MRR ARR churn revenue dashboard stripe', relevant: ['sess-revenue-dashboard'] },
    { query: 'STATE.md hot cold tier rotation archive', relevant: ['sess-two-tier-state'] },
    {
      query: 'vector store ANN index cosine recall performance',
      relevant: ['sess-vector-ann', 'sess-atlas-vector-search'],
    },
    { query: 'atlas vectorSearch tenant isolation', relevant: ['sess-atlas-vector-search'] },
    { query: 'schedule runner queue reprioritize fable window', relevant: ['sess-schedule-runner'] },
    { query: 'zero prompt permissions bypass safety rails hooks', relevant: ['sess-zero-prompt'] },
    { query: 'RAG recall eval precision MRR baseline', relevant: ['sess-handoff-current'] },
    { query: 'CI thrift vercel deploy local-ci fallback', relevant: ['sess-ci-thrift'] },
  ],
};
