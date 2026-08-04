/**
 * betaC auto-boot — MCP server-instructions context bundle.
 *
 * On MCP `initialize`, the gateway returns a TIGHT context bundle in the
 * standard `InitializeResult.instructions` field. Cooperating MCP clients
 * (Claude CLI/desktop, etc.) load this into the model's context automatically —
 * so a fresh/blank agent on any machine is bootstrapped with the user's context
 * with NO keyword and NO ritual. This generalizes today's `agent mode -a`
 * startup into a keyword-free, universal auto-boot.
 *
 * Design (jam/betac.md "Approach"):
 *  - CHEAP BY DESIGN. The bundle is a tight summary (identity + active project +
 *    last-handoff summary + active plan), hard-capped by a char budget. Deeper
 *    context is pulled LAZILY via the existing `recall_session` / `handoff_read`
 *    / `memory_search` tools — this module builds ON them, it does not recreate
 *    them, and it never dumps full state.
 *  - RESILIENT. Every data fetch is best-effort; a DB outage degrades to an
 *    identity-only bundle rather than failing the MCP handshake.
 *  - OPT-OUT. Set BETAC_AUTOBOOT=0 (or false) to disable; the handshake then
 *    omits `instructions` entirely (byte-identical to pre-betaC behaviour).
 */

import { createChildLogger } from '../shared/logger.js';
import { getContextReadService } from './context-read-service.js';
import type { BrainManifest, BrainManifestNamespace } from './context-read-service.js';
import { tighten } from './context-text.js';

// `tighten` is re-exported for backwards compatibility — it used to be defined
// here and is imported by name from this module (context-bundle test suite).
export { tighten };

const log = createChildLogger({ module: 'betac-context-bundle' });

/** Default total budget for the bundle, in characters (~4 chars/token). */
const DEFAULT_BUDGET_CHARS = 1800;
/** Master repo name — the fallback "active project" when nothing scores higher. */
const MASTER_REPO = 'ai_management';

export interface BundleParts {
  identity: string;
  activeProject: string;
  handoffSummary?: string;
  planFocus?: string;
  /** Brain main HEAD when the summary came from the compiled brain brief —
   * the agent's anchor for the next `brain_delta` catch-up. */
  brainSha?: string;
  /** BRAIN B-2 store TOC line (`name→fetch-tool · …`) — STATIC by construction
   * (store names + primary fetch tools never vary with brain contents), so it
   * renders in the B-8 stable prefix. */
  storesToc?: string;
  /** BRAIN B-2 namespace-freshness line for the active project — VOLATILE
   * (counts change every merge), so it renders below the cache boundary. */
  nsFreshness?: string;
  generatedAt: string;
}

/**
 * The operator brief — the four lines a blank agent needs to greet the
 * operator and continue the work: WHO it is working with, the STATE (active
 * project), the last HANDOFF, and what comes NEXT. Rendered as the bundle's
 * markdown lines and returned structured on `context_boot` so shims can
 * consume it without parsing markdown.
 */
export interface OperatorBrief {
  who: string;
  state: string;
  handoff?: string;
  next?: string;
}

/** Derive the structured operator brief from the bundle parts. */
export function briefFromParts(parts: BundleParts): OperatorBrief {
  return {
    who: parts.identity,
    state: `Active project: ${parts.activeProject}`,
    handoff: parts.handoffSummary,
    next: parts.planFocus,
  };
}

/** Is auto-boot enabled? Off only when BETAC_AUTOBOOT is explicitly 0/false. */
export function isAutoBootEnabled(): boolean {
  const v = (process.env.BETAC_AUTOBOOT ?? '').trim().toLowerCase();
  return v !== '0' && v !== 'false' && v !== 'off' && v !== 'no';
}

/** Total char budget for the rendered bundle (env-overridable). */
function budgetChars(): number {
  const n = Number(process.env.BETAC_BUDGET_CHARS);
  return Number.isFinite(n) && n > 200 ? Math.floor(n) : DEFAULT_BUDGET_CHARS;
}

/**
 * Resolve the user's identity line via the read-path service seam. Precedence
 * (env → identity.md → framework default) and the 320-char cap live in the
 * service's `resolveIdentity` — see context-read-service.ts. Kept exported here
 * for backwards compatibility with existing callers/tests.
 */
export function resolveIdentity(): string {
  return getContextReadService().resolveIdentity();
}

// ── BRAIN B-2 — compact control-plane manifest for the boot payload ──────────
//
// `brain_manifest` (the MCP tool) returns the full TOC on demand; the boot
// payload carries this COMPACT form so a fresh session knows where every
// store is — and how fresh the brain is — without scanning state files or
// spending a second tool call. Store names + primary fetch tools are static
// (they render in the B-8 stable prefix); the freshness row is volatile.

export interface BootManifestStore {
  name: string;
  /** Primary fetch tool (MCP tool name or script path) — how to descend into this store. */
  fetch: string;
}

export interface BootManifest {
  /** Brain main HEAD — the freshness anchor for a later `brain_delta({ since })`. */
  freshnessSha?: string;
  stores: BootManifestStore[];
  /** Total namespace count (full per-namespace detail stays behind `brain_manifest`). */
  namespaces: number;
  /** The active project's namespace row, when the brain has one. */
  active?: BrainManifestNamespace;
  memoryAtoms: number;
}

/** Compact the full B-2 manifest down to what the boot payload carries. */
export function compactManifest(manifest: BrainManifest, repo: string): BootManifest {
  return {
    freshnessSha: manifest.freshnessSha,
    stores: manifest.stores.map(s => ({ name: s.name, fetch: s.fetchTools[0] ?? '' })),
    namespaces: manifest.namespaces.length,
    active: manifest.namespaces.find(n => n.name === repo),
    memoryAtoms: manifest.memoryAtoms,
  };
}

/** Static store TOC line — `name→fetch · …`. Belongs in the B-8 stable prefix. */
function storesTocLine(compact: BootManifest): string | undefined {
  if (!compact.stores.length) return undefined;
  return compact.stores.map(s => (s.fetch ? `${s.name}→\`${s.fetch}\`` : s.name)).join(' · ');
}

/** Volatile namespace-freshness line for the active project. */
function nsFreshnessLine(compact: BootManifest): string | undefined {
  if (!compact.active && !compact.namespaces) return undefined;
  const a = compact.active;
  const head = a
    ? `${a.name} brief${a.hasBrief ? '✓' : '✗'} working${a.hasWorking ? '✓' : '✗'} · ${a.sessions} sessions · ${a.handoffs} handoffs`
    : 'active project has no namespace yet';
  return `${head} · ${compact.namespaces} ns · ${compact.memoryAtoms} memory atoms`;
}

/** Read + compact the B-2 manifest through the seam. Best-effort, never throws. */
function resolveBootManifest(tenantId: string, repo: string): BootManifest | undefined {
  try {
    const manifest = getContextReadService().readBrainManifest?.(tenantId);
    return manifest ? compactManifest(manifest, repo) : undefined;
  } catch (err) {
    log.debug({ err, repo }, 'boot manifest read failed — bundle renders without it');
    return undefined;
  }
}

/** Pick the active project: highest-priority repo, else the master repo. */
async function resolveActiveProject(tenantId: string): Promise<string> {
  try {
    const ranked = await getContextReadService().prioritizeRepos(tenantId);
    if (ranked.length && ranked[0].score > 0) return ranked[0].repo;
  } catch (err) {
    log.debug({ err }, 'prioritizeRepos failed — defaulting active project');
  }
  return MASTER_REPO;
}

/** Latest handoff summary for the active project (summary, else content head). */
async function resolveHandoffSummary(tenantId: string, repo: string, max: number): Promise<string | undefined> {
  try {
    const { latest } = await getContextReadService().readHandoff(tenantId, repo);
    if (!latest) return undefined;
    const text = latest.summary?.trim() || latest.content?.trim();
    return text ? tighten(text, max) : undefined;
  } catch (err) {
    log.debug({ err, repo }, 'readHandoff failed');
    return undefined;
  }
}

/**
 * BRAIN B3: the compiled boot brief for the active project, read straight off
 * brain MAIN (plain files, no server round-trip — the distiller checked them
 * in at the last `brain_merge`). Returns undefined when there is no brain, no
 * namespace, or the brief hasn't been compiled yet — the caller then falls
 * back to the handoff store (pre-brain behaviour, byte-identical).
 */
function resolveBrainBrief(
  tenantId: string,
  repo: string,
  max: number,
): { brief: string; sha?: string } | undefined {
  // The brain read (env resolution + pull-on-boot + compiled-brief read) lives
  // behind the read-path seam; here we only apply the char budget.
  const read = getContextReadService().readBrainBrief(tenantId, repo);
  if (!read) return undefined;
  return { brief: tighten(read.brief, max), sha: read.sha };
}

/** Next actionable plan focus for the active project (first enabled day). */
async function resolvePlanFocus(tenantId: string, repo: string, max: number): Promise<string | undefined> {
  try {
    const days = await getContextReadService().listPlan(tenantId, repo);
    if (!days.length) return undefined;
    const next = days.find(d => d.status === 'enabled') ?? days[0];
    if (!next?.focus) return undefined;
    return tighten(`Day ${next.day}: ${next.focus}`, max);
  } catch (err) {
    log.debug({ err, repo }, 'listPlan failed');
    return undefined;
  }
}

/**
 * BRAIN B-8 cache boundary — the line that splits the rendered bundle into a
 * byte-stable prefix (above) and the volatile tail (below). Everything above
 * it is identical across wakeups while identity/config stand still, so the
 * Anthropic prompt-cache prefix match survives volatile churn (new brain SHA,
 * fresh handoff, plan progress) instead of being invalidated by it. Clients
 * that place explicit `cache_control` breakpoints can split on this marker.
 */
export const CACHE_BOUNDARY = '<!-- B-8 cache boundary: stable above · volatile below -->';

/**
 * Render the parts into the final `instructions` string, respecting the total
 * char budget. The identity + active-project + lazy-pointers lines are always
 * kept; handoff/plan/ns-freshness are dropped if they'd blow the budget.
 *
 * BRAIN B-8 prompt-cache-aware ordering: static content FIRST (header, lazy
 * recall instructions, the B-2 store TOC, identity), then the CACHE_BOUNDARY
 * marker, then everything that changes across wakeups (active project, brain
 * SHA, handoff, next, namespace freshness). Volatile lines must never render
 * above the boundary — one moved line resets the cache prefix for every
 * wakeup that follows.
 */
export function renderBundle(parts: BundleParts, budget: number = budgetChars()): string {
  const header = '# myAI operator brief — you are pre-loaded with this operator\'s context (betaC auto-boot)';
  const lazy =
    'If the operator opens without a specific task, greet them from this brief and ' +
    'offer to continue from **Next**. Deeper context ON DEMAND (do not preload): ' +
    '`handoff_read` (full handoff), `recall_session` (past sessions), `memory_search` ' +
    '(cross-project memory). This brief is a tight summary by design.';

  const brief = briefFromParts(parts);

  // Stable prefix (B-8): byte-identical across wakeups.
  const stable: string[] = [header, '', lazy];
  if (parts.storesToc) stable.push(`**Stores:** ${parts.storesToc}`);
  stable.push(`**Who:** ${brief.who}`, CACHE_BOUNDARY);

  // Volatile tail: always-kept lines first.
  const volatileLines: string[] = [`**State:** ${brief.state}`];
  if (parts.brainSha) {
    volatileLines.push(`**Brain:** ${parts.brainSha.slice(0, 8)} — remember this SHA; catch up later with \`brain_delta\``);
  }

  const draft = (extra: string[]) => [...stable, ...volatileLines, ...extra].join('\n');

  // Optional sections, added only while they fit the budget. Trimmed from the
  // bottom: ns-freshness goes first, then `next`, then `handoff` — the handoff
  // is the most valuable line under pressure.
  let extra: string[] = [];
  if (brief.handoff) extra = [...extra, `**Handoff:** ${brief.handoff}`];
  if (brief.next) extra = [...extra, `**Next:** ${brief.next}`];
  if (parts.nsFreshness) extra = [...extra, `**Brain-ns:** ${parts.nsFreshness}`];

  while (extra.length && draft(extra).length > budget) extra = extra.slice(0, -1);

  return draft(extra);
}

/**
 * Build the betaC auto-boot context bundle for a tenant. Returns the rendered
 * `instructions` string, or `undefined` when auto-boot is disabled. Never
 * throws — a failure anywhere degrades to identity-only.
 */
export async function buildContextBundle(
  tenantId: string,
  opts: { now?: () => Date } = {},
): Promise<string | undefined> {
  if (!isAutoBootEnabled()) return undefined;

  const budget = budgetChars();
  const identity = resolveIdentity();

  try {
    const activeProject = await resolveActiveProject(tenantId);
    // Split the remaining budget between handoff (most valuable) and plan.
    // The compiled brain brief (distilled at the last brain_merge) beats the
    // handoff store when present — it's the purpose-built ~150-token boot line.
    const brain = resolveBrainBrief(tenantId, activeProject, Math.floor(budget * 0.5));
    const handoffSummary = brain?.brief
      ?? (await resolveHandoffSummary(tenantId, activeProject, Math.floor(budget * 0.5)));
    const planFocus = await resolvePlanFocus(tenantId, activeProject, Math.floor(budget * 0.25));
    const manifest = resolveBootManifest(tenantId, activeProject);

    const parts: BundleParts = {
      identity,
      activeProject,
      handoffSummary,
      planFocus,
      brainSha: brain?.sha,
      storesToc: manifest && storesTocLine(manifest),
      nsFreshness: manifest && nsFreshnessLine(manifest),
      generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    };
    return renderBundle(parts, budget);
  } catch (err) {
    // Last-resort: never fail the MCP handshake over context assembly.
    log.warn({ err }, 'betaC bundle assembly failed — returning identity-only');
    return renderBundle(
      { identity, activeProject: MASTER_REPO, generatedAt: new Date().toISOString() },
      budget,
    );
  }
}

// ── Callable boot bundle + lazy RAG expansion (betaC `context_boot` tool) ─────
//
// The `buildContextBundle` above feeds the MCP `initialize` handshake — it only
// reaches COOPERATING clients that read `InitializeResult.instructions`. The
// wrap-it tier (blank ChatGPT/Ollama via a thin shim) and any agent that wants
// to RE-fetch a fresh bundle mid-session need to CALL for it. `buildBootBundle`
// is that callable form: same tight, cheap summary, returned structured.
//
// Lazy RAG (jam/betac.md "Cheap by design"): the bundle stays a tight summary by
// default. Deeper context is pulled ONLY when the agent asks — i.e. passes a
// `query`. `expandContext` then runs ONE capped semantic search and returns
// short snippet pointers, so auto-boot FIXES token-burn instead of recreating
// it. With no query the search never runs (zero extra cost).

/** Default number of RAG snippets returned when the agent asks to go deeper. */
const DEFAULT_EXPAND_LIMIT = 4;
/** Hard ceiling on lazy-expansion depth so "deeper" can never become a dump. */
const MAX_EXPAND_LIMIT = 8;
/** Per-snippet char cap — pointers into memory, not the full chunks. */
const EXPAND_SNIPPET_CHARS = 240;

export interface ContextSnippet {
  repo: string;
  source: string;
  score: number;
  snippet: string;
}

export interface BootBundle {
  /** The tight, rendered context bundle (same text the handshake injects). */
  bundle: string;
  /** The operator brief, structured — who / state / handoff / next. */
  brief: OperatorBrief;
  /** Structured parts behind the rendered bundle. */
  parts: BundleParts;
  /** BRAIN B-2: the compact control-plane manifest — stores + fetch tools,
   * namespace count, active-namespace freshness, and the freshness SHA. */
  manifest?: BootManifest;
  /** Lazy RAG results — present ONLY when a `query` was supplied. */
  deeper?: ContextSnippet[];
  /** Brain main HEAD when the brief came from the brain — remember it and
   * catch up next boot with `brain_delta` instead of a full re-boot. */
  brainSha?: string;
  /** Approx token cost of `bundle` (~4 chars/token). */
  tokenEstimate: number;
  /** Names of the tools the agent should call for further on-demand depth. */
  lazyRecall: string[];
}

/**
 * Lazily pull deeper context for a focus `query` via ONE capped semantic search.
 * Best-effort: a DB outage or empty corpus returns `[]` rather than throwing.
 * Scoped to the active project by default; pass `crossProject` to search the
 * tenant's whole memory (the global layer in jam/betac.md "Human-like memory").
 */
export async function expandContext(
  tenantId: string,
  opts: { query: string; repo?: string; limit?: number; crossProject?: boolean },
): Promise<ContextSnippet[]> {
  const query = opts.query?.trim();
  if (!query) return [];
  const limit = Math.min(MAX_EXPAND_LIMIT, Math.max(1, opts.limit ?? DEFAULT_EXPAND_LIMIT));
  try {
    const results = await getContextReadService().searchVectors(tenantId, {
      query,
      repo: opts.crossProject ? undefined : opts.repo,
      limit,
    });
    return results.map(r => ({
      repo: r.repo,
      source: r.source,
      score: Math.round(r.score * 1000) / 1000,
      snippet: tighten(r.content, EXPAND_SNIPPET_CHARS),
    }));
  } catch (err) {
    log.debug({ err, repo: opts.repo }, 'lazy expandContext failed — returning none');
    return [];
  }
}

/**
 * Build the callable boot bundle. Same tight summary as the handshake bundle,
 * returned structured so a shim/agent can consume it directly. When `query` is
 * supplied, ONE lazy RAG search is appended under `deeper`; otherwise no search
 * runs (cheap by design). Never throws — degrades to an identity-only bundle.
 */
export async function buildBootBundle(
  tenantId: string,
  opts: { repo?: string; query?: string; expandLimit?: number; crossProject?: boolean; budget?: number; now?: () => Date } = {},
): Promise<BootBundle> {
  const budget = opts.budget && opts.budget > 200 ? Math.floor(opts.budget) : budgetChars();
  const identity = resolveIdentity();
  const lazyRecall = ['handoff_read', 'recall_session', 'memory_search', 'context_boot', 'brain_delta'];

  let parts: BundleParts;
  let manifest: BootManifest | undefined;
  try {
    const activeProject = opts.repo?.trim() || (await resolveActiveProject(tenantId));
    // Compiled brain brief first (BRAIN B3), handoff store as the fallback.
    const brain = resolveBrainBrief(tenantId, activeProject, Math.floor(budget * 0.5));
    const handoffSummary = brain?.brief
      ?? (await resolveHandoffSummary(tenantId, activeProject, Math.floor(budget * 0.5)));
    const planFocus = await resolvePlanFocus(tenantId, activeProject, Math.floor(budget * 0.25));
    manifest = resolveBootManifest(tenantId, activeProject);
    parts = {
      identity,
      activeProject,
      handoffSummary,
      planFocus,
      brainSha: brain?.sha,
      storesToc: manifest && storesTocLine(manifest),
      nsFreshness: manifest && nsFreshnessLine(manifest),
      generatedAt: (opts.now?.() ?? new Date()).toISOString(),
    };
  } catch (err) {
    log.warn({ err }, 'buildBootBundle assembly failed — identity-only');
    parts = { identity, activeProject: opts.repo?.trim() || MASTER_REPO, generatedAt: new Date().toISOString() };
  }

  const bundle = renderBundle(parts, budget);
  const deeper = opts.query?.trim()
    ? await expandContext(tenantId, {
        query: opts.query,
        repo: parts.activeProject,
        limit: opts.expandLimit,
        crossProject: opts.crossProject,
      })
    : undefined;

  return {
    bundle,
    brief: briefFromParts(parts),
    parts,
    manifest,
    deeper,
    brainSha: parts.brainSha,
    tokenEstimate: Math.ceil(bundle.length / 4),
    lazyRecall,
  };
}
