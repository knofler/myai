// CONTEXT-PORT 3 — "Your Context" page logic.
//
// The visible home of "your context is yours — portable, importable." The
// dashboard can READ every layer of a tenant's context from the local Mongo
// mirror (RAG vectors, gateway sessions) plus the gateway `brain_explore` tool
// (git-versioned brain namespaces/atoms). This module holds the PURE shaping +
// bundle math so it is unit-testable with no DB/DOM/network:
//   • summarise the layers into size / token / coverage stat rows,
//   • define the portable JSON bundle shape shared by the export/import routes,
//   • validate an uploaded bundle before it is forwarded to the gateway.
//
// The heavyweight, lossless tar.gz bundle (memory markdown + vectors WITH
// embeddings + the whole git brain repo + ~/.myai config) is produced by the
// `myai context export` CLI (scripts/myai_context.sh, CONTEXT-PORT 1) — that
// needs filesystem + git access the browser can't have. This page offers the
// JSON slice the dashboard CAN assemble one-click, and surfaces the CLI command
// for the full archive.

export const CONTEXT_BUNDLE_KIND = 'myai-context-bundle';
export const CONTEXT_BUNDLE_VERSION = 1;

/** Rough token estimate — ~4 chars per token, the standard back-of-envelope. */
export function estimateTokensFromChars(chars: number): number {
  if (!Number.isFinite(chars) || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/** Human byte size — B / KB / MB / GB, 1 decimal above KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

/** Compact count — 1234 → "1.2k", 2_000_000 → "2M". */
export function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export interface ContextLayerInput {
  /** RAG vector corpus (excludes embeddings on the page — counts only). */
  vectors: { total: number; contentChars: number; bySource: { source: string; count: number }[]; repoCount: number };
  /** Gateway sessions mirrored to Mongo. */
  sessions: { total: number };
  /** Git-versioned brain (namespaces / atoms) — null when the gateway is unreachable. */
  brain: {
    namespaces: number;
    sessions: number;
    handoffs: number;
    memoryAtoms: number;
    initialized: boolean;
  } | null;
}

export interface CoverageRow {
  layer: string;
  count: number;
  detail: string;
}

export interface ContextSummary {
  totalItems: number;
  estimatedChars: number;
  estimatedTokens: number;
  coverage: CoverageRow[];
  /** true when at least one layer has data — drives empty-state vs populated. */
  hasContext: boolean;
  /** true when the gateway brain layer could not be read. */
  brainUnavailable: boolean;
}

/**
 * Fold the raw layer counts into the summary the page renders. Pure — the view
 * gathers the numbers from Mongo + the gateway and hands them here.
 */
export function buildContextSummary(input: ContextLayerInput): ContextSummary {
  const { vectors, sessions, brain } = input;

  const brainAtoms = brain ? brain.sessions + brain.handoffs + brain.memoryAtoms : 0;
  const totalItems = vectors.total + sessions.total + brainAtoms;

  // Vector content is the only layer whose text volume we can measure cheaply
  // (a single $strLenCP aggregate). Sessions/brain add a nominal per-atom
  // estimate so the token figure isn't wildly under-counted.
  const PER_ATOM_CHARS = 600;
  const estimatedChars = vectors.contentChars + (sessions.total + brainAtoms) * PER_ATOM_CHARS;

  const coverage: CoverageRow[] = [
    {
      layer: 'RAG vectors',
      count: vectors.total,
      detail:
        vectors.total > 0
          ? `${vectors.bySource.length} source type${vectors.bySource.length !== 1 ? 's' : ''} · ${vectors.repoCount} repo${vectors.repoCount !== 1 ? 's' : ''}`
          : 'nothing indexed yet',
    },
    {
      layer: 'Gateway sessions',
      count: sessions.total,
      detail: sessions.total > 0 ? 'conversation history' : 'no sessions yet',
    },
    {
      layer: 'Brain — memory',
      count: brain?.memoryAtoms ?? 0,
      detail: brain ? 'cross-repo memory atoms' : 'gateway unreachable',
    },
    {
      layer: 'Brain — sessions & handoffs',
      count: brain ? brain.sessions + brain.handoffs : 0,
      detail: brain ? `${brain.namespaces} namespace${brain.namespaces !== 1 ? 's' : ''}` : 'gateway unreachable',
    },
  ];

  return {
    totalItems,
    estimatedChars,
    estimatedTokens: estimateTokensFromChars(estimatedChars),
    coverage,
    hasContext: totalItems > 0,
    brainUnavailable: brain === null,
  };
}

export interface PortableBundle {
  kind: string;
  formatVersion: number;
  tenantId: string;
  generatedAt: string;
  summary: { totalItems: number; estimatedTokens: number };
  vectors: unknown[];
  sessions: unknown[];
  brain: unknown;
}

export interface BundleValidation {
  ok: boolean;
  error?: string;
  vectorCount: number;
  sessionCount: number;
}

/**
 * Validate an uploaded bundle BEFORE anything is forwarded to the gateway.
 * Guards kind + formatVersion and shape so the import route never trusts an
 * arbitrary upload. Pure — takes the already-parsed JSON value.
 */
export function validateImportBundle(raw: unknown): BundleValidation {
  const fail = (error: string): BundleValidation => ({ ok: false, error, vectorCount: 0, sessionCount: 0 });

  if (!raw || typeof raw !== 'object') return fail('bundle must be a JSON object');
  const b = raw as Record<string, unknown>;

  if (b.kind !== CONTEXT_BUNDLE_KIND) {
    return fail(`unexpected bundle kind "${String(b.kind)}" — expected "${CONTEXT_BUNDLE_KIND}"`);
  }
  if (typeof b.formatVersion !== 'number') return fail('bundle formatVersion missing or not a number');
  if (b.formatVersion > CONTEXT_BUNDLE_VERSION) {
    return fail(`bundle formatVersion ${b.formatVersion} is newer than supported (${CONTEXT_BUNDLE_VERSION})`);
  }

  const vectors = Array.isArray(b.vectors) ? b.vectors : null;
  const sessions = Array.isArray(b.sessions) ? b.sessions : [];
  if (vectors === null) return fail('bundle.vectors must be an array');

  return { ok: true, vectorCount: vectors.length, sessionCount: sessions.length };
}
