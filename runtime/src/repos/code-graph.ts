/**
 * code-graph.ts — deterministic, repo-local typed code-edge graph + PR blast-radius.
 *
 * Same-process counterpart to scripts/code_graph.py (B-1.5, shipped 2026-07-21):
 * that module resolves scan_repo_index.py's SQLite-backed `refs`/`symbols`/`tests`
 * tables into a typed `edges` table (import/calls/tests_of) for the Python-side
 * brain layer. This module builds the equivalent three edge types directly from
 * `git ls-files` + a regex pass over TS/JS/Python source — no SQLite, no shelling
 * out to Python — so get_pr_impact/triage_prs (B-1.6) can run in-process inside
 * the Node MCP gateway against any managed repo, indexed or not. Same "narrow the
 * candidate set, not a real compiler" heuristic class as both of those.
 *
 * Deliberately skips: path aliases (tsconfig `paths`), bare-package internals,
 * dynamic `import()` with a non-literal specifier, cross-module call resolution
 * for very common names (fan-out capped, mirrors code_graph.py's cap). Those all
 * degrade to "no edge recorded" rather than a wrong one — blast radius is a lower
 * bound, not a guarantee, same caveat scan_repo_index.py documents for its refs
 * table.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, posix, extname, sep } from 'node:path';
import { createChildLogger } from '../shared/logger.js';

const log = createChildLogger({ module: 'code-graph' });

const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py']);
const RESOLVE_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];

// Single-line heuristics — mirrors scripts/scan_repo_index.py's _TS_IMPORT / py import regex.
const TS_IMPORT_RE = /^\s*(?:export\s+.*?\bfrom|import\s+(?:type\s+)?.*?\bfrom|import)\s+['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)/;
const PY_IMPORT_RE = /^\s*from\s+(\.*[\w.]+)\s+import\b|^\s*import\s+(\.*[\w.]+)/;

// Symbol-definition heuristics — mirrors scripts/scan_repo_index.py's _TS_SYMBOL / _PY_SYMBOL,
// simplified to "does this line declare a name" (function/class/const), enough to build a
// name -> defining-file index for call-site resolution.
const TS_SYMBOL_RE = /^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function\*?\s+([A-Za-z_$][\w$]*)|class\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=])|^\s*(?:async\s+)?function\*?\s+([A-Za-z_$][\w$]*)\s*\(|^\s*class\s+([A-Za-z_$][\w$]*)/;
const PY_SYMBOL_RE = /^\s*(?:async\s+)?def\s+(\w+)\s*\(|^\s*class\s+(\w+)\s*[:(]/;

// mirrors scripts/code_graph.py's _CALL_RE / _CALL_KEYWORDS / _MAX_CROSS_FILE_TARGETS.
const CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\(/g;
const CALL_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'typeof',
  'new', 'instanceof', 'in', 'of', 'else', 'do', 'with', 'try', 'await',
  'yield', 'class', 'import', 'export', 'from', 'as', 'const', 'let', 'var',
  'def', 'elif', 'except', 'lambda', 'print', 'super', 'async',
]);
const MAX_CROSS_FILE_TARGETS = 20;

export interface CodeGraph {
  repoRoot: string;
  /** All git-tracked source files considered, as repo-relative POSIX paths. */
  files: Set<string>;
  /** file -> set of in-repo files it imports (resolved). */
  imports: Map<string, Set<string>>;
  /** file -> set of in-repo files that import it (reverse of `imports`). */
  importedBy: Map<string, Set<string>>;
  /** file -> set of in-repo files containing a symbol it calls (resolved). */
  calls: Map<string, Set<string>>;
  /** file -> set of in-repo files that call into it (reverse of `calls`). */
  calledBy: Map<string, Set<string>>;
  /** test file -> set of in-repo source files it appears to test (name-guess heuristic). */
  testsOf: Map<string, Set<string>>;
  /** source file -> set of test files that appear to test it (reverse of `testsOf`). */
  testedBy: Map<string, Set<string>>;
  /** declared symbol name -> files that declare a function/class/const of that name. */
  symbolFiles: Map<string, string[]>;
}

function git(repoRoot: string, ...args: string[]): string | undefined {
  const res = spawnSync('git', ['-C', repoRoot, ...args], { encoding: 'utf8' });
  if (res.status !== 0) return undefined;
  return res.stdout;
}

function toPosix(p: string): string {
  return p.split(sep).join(posix.sep);
}

function trackedFiles(repoRoot: string): string[] {
  const out = git(repoRoot, 'ls-files');
  if (out === undefined) {
    log.warn({ repoRoot }, 'git ls-files failed — code graph will be empty');
    return [];
  }
  return out.split('\n').map(l => l.trim()).filter(Boolean);
}

function extractSpecifiers(file: string, text: string): string[] {
  const ext = extname(file);
  const isPy = ext === '.py';
  const specs: string[] = [];
  for (const line of text.split('\n')) {
    const m = isPy ? PY_IMPORT_RE.exec(line) : TS_IMPORT_RE.exec(line);
    if (!m) continue;
    const spec = m.slice(1).find(g => g !== undefined);
    if (spec) specs.push(spec);
  }
  return specs;
}

/** Resolve a relative TS/JS specifier against the importing file to a repo-relative path. */
function resolveTsSpecifier(fromFile: string, spec: string, files: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined; // bare package / alias — not resolvable, skip
  const fromDir = posix.dirname(toPosix(fromFile));
  const base = posix.normalize(posix.join(fromDir, spec));

  const candidates: string[] = [base];
  const baseExt = extname(base);
  if (baseExt === '.js' || baseExt === '.jsx' || baseExt === '.mjs' || baseExt === '.cjs') {
    // ESM-style relative imports in this codebase reference the compiled .js
    // extension while the tracked source is .ts/.tsx (see brain.ts imports).
    const stem = base.slice(0, -baseExt.length);
    candidates.push(`${stem}.ts`, `${stem}.tsx`, base);
  } else if (!baseExt) {
    for (const ext of RESOLVE_EXT) candidates.push(`${base}${ext}`);
    for (const ext of RESOLVE_EXT) candidates.push(posix.join(base, `index${ext}`));
  }
  return candidates.find(c => files.has(c));
}

/** Resolve a Python (possibly dotted-relative) import to a repo-relative path. */
function resolvePySpecifier(fromFile: string, spec: string, files: Set<string>): string | undefined {
  if (!spec.startsWith('.')) return undefined; // absolute/package import — not resolvable, skip
  const leadingDots = spec.match(/^\.+/)?.[0].length ?? 0;
  const rest = spec.slice(leadingDots).replace(/\./g, '/');
  let dir = posix.dirname(toPosix(fromFile));
  for (let i = 1; i < leadingDots; i++) dir = posix.dirname(dir); // extra dots walk up further
  const base = rest ? posix.normalize(posix.join(dir, rest)) : dir;
  const candidates = [`${base}.py`, posix.join(base, '__init__.py')];
  return candidates.find(c => files.has(c));
}

function addDirectedEdge(fwd: Map<string, Set<string>>, rev: Map<string, Set<string>>, from: string, to: string): void {
  if (from === to) return;
  if (!fwd.has(from)) fwd.set(from, new Set());
  fwd.get(from)!.add(to);
  if (!rev.has(to)) rev.set(to, new Set());
  rev.get(to)!.add(from);
}

/** line index -> declared name, for lines that declare a function/class/const symbol. */
function extractSymbolDecls(file: string, lines: string[]): Map<number, string> {
  const isPy = extname(file) === '.py';
  const declByLine = new Map<number, string>();
  lines.forEach((line, i) => {
    const m = isPy ? PY_SYMBOL_RE.exec(line) : TS_SYMBOL_RE.exec(line);
    if (!m) return;
    const name = m.slice(1).find(g => g !== undefined);
    if (name) declByLine.set(i, name);
  });
  return declByLine;
}

const TEST_FILE_RE = /(^|\/)(tests?|__tests__)\/|\.(test|spec)\.[jt]sx?$|_test\.py$|^test_/i;

/** Guess the source file a test file covers — mirrors scan_repo_index.py's test-name heuristic:
 *  strip .test/.spec/test_ markers off the basename, then substring-match the remaining stem
 *  against known files (exact basename match preferred, shortest/alphabetical as tiebreak). */
function guessTestedSource(testFile: string, files: Set<string>): string | undefined {
  const base = posix.basename(testFile);
  const guess = base
    .replace(/\.test(\.[jt]sx?)$/, '$1')
    .replace(/\.spec(\.[jt]sx?)$/, '$1')
    .replace(/^test_/, '')
    .replace(/\.py$/, '');
  if (!guess) return undefined;
  const candidates = [...files].filter(f => f !== testFile && posix.basename(f).includes(guess));
  if (candidates.length === 0) return undefined;
  candidates.sort((a, b) => {
    const aExact = posix.basename(a) === guess ? 0 : 1;
    const bExact = posix.basename(b) === guess ? 0 : 1;
    if (aExact !== bExact) return aExact - bExact;
    return a.length - b.length || a.localeCompare(b);
  });
  return candidates[0];
}

/** Build the in-repo typed code-edge graph (import/calls/tests_of) for every git-tracked TS/JS/Python file. */
export function buildCodeGraph(repoRoot: string): CodeGraph {
  const all = trackedFiles(repoRoot).map(toPosix);
  const files = new Set(all.filter(f => CODE_EXT.has(extname(f))));
  const graph: CodeGraph = {
    repoRoot,
    files,
    imports: new Map(),
    importedBy: new Map(),
    calls: new Map(),
    calledBy: new Map(),
    testsOf: new Map(),
    testedBy: new Map(),
    symbolFiles: new Map(),
  };

  const linesByFile = new Map<string, string[]>();
  const declsByFile = new Map<string, Map<number, string>>();
  const nameIndex = new Map<string, string[]>();

  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      continue; // deleted/unreadable since ls-files ran — skip, not fatal
    }
    const lines = text.split('\n');
    linesByFile.set(file, lines);

    const isPy = extname(file) === '.py';
    for (const spec of extractSpecifiers(file, text)) {
      const resolved = isPy ? resolvePySpecifier(file, spec, files) : resolveTsSpecifier(file, spec, files);
      if (resolved) addDirectedEdge(graph.imports, graph.importedBy, file, resolved);
    }

    const decls = extractSymbolDecls(file, lines);
    declsByFile.set(file, decls);
    for (const name of new Set(decls.values())) {
      if (!nameIndex.has(name)) nameIndex.set(name, []);
      nameIndex.get(name)!.push(file);
    }

    if (TEST_FILE_RE.test(file)) {
      const sourceGuess = guessTestedSource(file, files);
      if (sourceGuess) addDirectedEdge(graph.testsOf, graph.testedBy, file, sourceGuess);
    }
  }

  // Second pass: call-site resolution needs the full cross-file name index built above.
  for (const [file, lines] of linesByFile) {
    const decls = declsByFile.get(file)!;
    lines.forEach((line, i) => {
      const ownDecl = decls.get(i);
      CALL_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = CALL_RE.exec(line))) {
        const name = m[1];
        if (CALL_KEYWORDS.has(name)) continue;
        if (ownDecl === name) continue; // the def/class signature line itself, not a call
        const candidates = nameIndex.get(name);
        if (!candidates || candidates.length === 0) continue;
        const sameFile = candidates.filter(f => f === file);
        // same-file matches preferred over cross-file, to bound fan-out on common helper names
        const targets = sameFile.length > 0 ? sameFile : candidates.slice(0, MAX_CROSS_FILE_TARGETS);
        for (const target of targets) addDirectedEdge(graph.calls, graph.calledBy, file, target);
      }
    });
  }

  graph.symbolFiles = nameIndex;
  return graph;
}

// ── B-1.5: typed edge traversal (get_neighbors / shortest_path) ────────────
// Same-process counterpart to scripts/code_graph.py's get_neighbors/shortest_path
// (shipped 2026-07-21) — that module traverses the SQLite `edges` table this
// graph's imports/calls/testsOf maps mirror. `node` accepts either a repo-relative
// file path or a declared symbol name (resolved via `symbolFiles` to its
// declaring file(s)) so callers can ask "what does `widget` touch" without
// knowing which file it lives in.

export type EdgeType = 'import' | 'calls' | 'tests_of';
export const ALL_EDGE_TYPES: readonly EdgeType[] = ['import', 'calls', 'tests_of'];

function forwardMap(graph: CodeGraph, type: EdgeType): Map<string, Set<string>> {
  if (type === 'import') return graph.imports;
  if (type === 'calls') return graph.calls;
  return graph.testsOf;
}

function reverseMap(graph: CodeGraph, type: EdgeType): Map<string, Set<string>> {
  if (type === 'import') return graph.importedBy;
  if (type === 'calls') return graph.calledBy;
  return graph.testedBy;
}

/** Resolve a query to its file set: an exact tracked-file match wins; otherwise
 *  fall back to the declaring file(s) of a symbol with that name. Empty when
 *  neither resolves — an unknown node, not an error, so callers can report it. */
export function resolveGraphNode(graph: CodeGraph, query: string): string[] {
  const q = toPosix(query);
  if (graph.files.has(q)) return [q];
  return [...(graph.symbolFiles.get(query) ?? [])].sort();
}

export interface GraphNeighbor {
  direction: 'out' | 'in';
  edgeType: EdgeType;
  file: string;
}

/** One file's typed neighbors — a scoped subgraph, not file contents. */
export function getNeighbors(
  graph: CodeGraph,
  file: string,
  opts: { edgeTypes?: EdgeType[]; direction?: 'out' | 'in' | 'both' } = {}
): GraphNeighbor[] {
  const direction = opts.direction ?? 'out';
  const types = opts.edgeTypes && opts.edgeTypes.length > 0 ? opts.edgeTypes : ALL_EDGE_TYPES;
  const results: GraphNeighbor[] = [];

  if (direction === 'out' || direction === 'both') {
    for (const type of types) {
      for (const dst of forwardMap(graph, type).get(file) ?? []) {
        results.push({ direction: 'out', edgeType: type, file: dst });
      }
    }
  }
  if (direction === 'in' || direction === 'both') {
    for (const type of types) {
      for (const src of reverseMap(graph, type).get(file) ?? []) {
        results.push({ direction: 'in', edgeType: type, file: src });
      }
    }
  }

  results.sort((a, b) =>
    a.direction.localeCompare(b.direction) || a.edgeType.localeCompare(b.edgeType) || a.file.localeCompare(b.file)
  );
  return results;
}

/** BFS shortest path between two files over the selected edge types (forward
 *  direction only, mirrors scripts/code_graph.py's shortest_path). Null when
 *  unreachable. */
export function shortestPath(
  graph: CodeGraph,
  src: string,
  dst: string,
  opts: { edgeTypes?: EdgeType[] } = {}
): string[] | null {
  if (src === dst) return [src];
  const types = opts.edgeTypes && opts.edgeTypes.length > 0 ? opts.edgeTypes : ALL_EDGE_TYPES;
  const maps = types.map(t => forwardMap(graph, t));

  const visited = new Set([src]);
  const parent = new Map<string, string>();
  const queue: string[] = [src];
  for (let qi = 0; qi < queue.length; qi++) {
    const cur = queue[qi];
    for (const map of maps) {
      for (const next of map.get(cur) ?? []) {
        if (visited.has(next)) continue;
        visited.add(next);
        parent.set(next, cur);
        if (next === dst) {
          const path = [dst];
          while (path[path.length - 1] !== src) path.push(parent.get(path[path.length - 1])!);
          return path.reverse();
        }
        queue.push(next);
      }
    }
  }
  return null;
}

export interface AffectedFile {
  file: string;
  /** BFS distance from the nearest changed file (0 = a changed file itself). */
  distance: number;
}

export interface PrImpact {
  changedFiles: string[];
  /** Changed files not found in the graph (outside git tracking, or non-code). */
  unresolvedFiles: string[];
  affectedFiles: AffectedFile[];
  totalAffected: number;
  maxDepth: number;
  depthCapped: boolean;
  /** Files that transitively call into a changed file (via the `calls` edge type) — a caller may
   *  not import the file directly, so this can surface impact `affectedFiles` alone would miss. */
  callers: AffectedFile[];
  /** Test files (via the `tests_of` edge type) that appear to cover a changed or affected file. */
  affectedTests: string[];
}

const DEFAULT_MAX_DEPTH = 6;

/** Reverse-edge BFS from `known` outward, one hop per typed edge, capped at `maxDepth`. */
function bfsReverse(
  reverse: Map<string, Set<string>>,
  known: string[],
  maxDepth: number
): { affected: AffectedFile[]; depthCapped: boolean } {
  const distance = new Map<string, number>();
  let frontier = new Set(known);
  for (const f of known) distance.set(f, 0);
  let depthCapped = false;
  let d = 0;

  while (frontier.size > 0 && d < maxDepth) {
    const next = new Set<string>();
    for (const file of frontier) {
      for (const dependent of reverse.get(file) ?? []) {
        if (!distance.has(dependent)) {
          distance.set(dependent, d + 1);
          next.add(dependent);
        }
      }
    }
    frontier = next;
    d += 1;
    if (d === maxDepth && frontier.size > 0) depthCapped = true;
  }

  const affected = [...distance.entries()]
    .filter(([f]) => !known.includes(f))
    .map(([file, dist]) => ({ file, distance: dist }))
    .sort((a, b) => a.distance - b.distance || a.file.localeCompare(b.file));

  return { affected, depthCapped };
}

/** Blast radius: every file that transitively imports or calls into one of `changedFiles`,
 *  plus the tests that cover that footprint. */
export function computePrImpact(
  graph: CodeGraph,
  changedFiles: string[],
  opts: { maxDepth?: number } = {}
): PrImpact {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const normalized = changedFiles.map(toPosix);
  const known = normalized.filter(f => graph.files.has(f) || graph.importedBy.has(f) || graph.imports.has(f));
  const unresolved = normalized.filter(f => !known.includes(f));

  const { affected: affectedFiles, depthCapped: importsCapped } = bfsReverse(graph.importedBy, known, maxDepth);
  const { affected: callers, depthCapped: callsCapped } = bfsReverse(graph.calledBy, known, maxDepth);

  const footprint = new Set([...known, ...affectedFiles.map(a => a.file), ...callers.map(a => a.file)]);
  const affectedTests = new Set<string>();
  for (const file of footprint) {
    for (const test of graph.testedBy.get(file) ?? []) affectedTests.add(test);
  }

  return {
    changedFiles: normalized,
    unresolvedFiles: unresolved,
    affectedFiles,
    totalAffected: affectedFiles.length,
    maxDepth,
    depthCapped: importsCapped || callsCapped,
    callers,
    affectedTests: [...affectedTests].sort(),
  };
}

/** Resolve the changed-file set for a PR: explicit files win, else a git diff over base...head. */
export function resolveChangedFiles(
  repoRoot: string,
  opts: { files?: string[]; base?: string; head?: string }
): string[] {
  if (opts.files && opts.files.length > 0) return opts.files.map(toPosix);
  if (!opts.base || !opts.head) {
    throw new Error('resolveChangedFiles: provide either files, or both base and head');
  }
  const refRe = /^[A-Za-z0-9._/-]+$/;
  if (!refRe.test(opts.base) || !refRe.test(opts.head)) {
    throw new Error('resolveChangedFiles: base/head must be plain git refs');
  }
  const out = git(repoRoot, 'diff', '--name-only', `${opts.base}...${opts.head}`);
  if (out === undefined) {
    throw new Error(`resolveChangedFiles: git diff ${opts.base}...${opts.head} failed`);
  }
  return out.split('\n').map(l => l.trim()).filter(Boolean).map(toPosix);
}

const INFRA_FILE_RE = /(^|\/)(package\.json|package-lock\.json|Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|\.github\/workflows\/.*|.*schema[^/]*\.(ts|py)|migrations?\/.*)$/i;

export interface PrTriageInput {
  id: string;
  label?: string;
  files?: string[];
  base?: string;
  head?: string;
}

export interface PrTriageResult {
  id: string;
  label?: string;
  changedFileCount: number;
  affectedFileCount: number;
  riskScore: number;
  riskFactors: string[];
  unresolvedFiles: string[];
}

/** Rank PRs by blast-radius-informed risk, highest first. */
export function triagePrs(
  graph: CodeGraph,
  prs: PrTriageInput[],
  opts: { maxDepth?: number } = {}
): PrTriageResult[] {
  const results = prs.map(pr => {
    const changed = resolveChangedFiles(graph.repoRoot, { files: pr.files, base: pr.base, head: pr.head });
    const impact = computePrImpact(graph, changed, opts);
    const riskFactors: string[] = [];

    let score = changed.length + impact.totalAffected * 2;

    if (changed.some(f => INFRA_FILE_RE.test(f))) {
      score += 10;
      riskFactors.push('touches infra/config/schema file');
    }
    const hasSourceChange = changed.some(f => !TEST_FILE_RE.test(f));
    const hasTestChange = changed.some(f => TEST_FILE_RE.test(f));
    if (hasSourceChange && !hasTestChange) {
      score += 5;
      riskFactors.push('source changed with no accompanying test file');
    }
    if (hasSourceChange && impact.affectedTests.length === 0) {
      score += 3;
      riskFactors.push('no known test coverage for the changed file(s) (no tests_of edge found)');
    }
    if (impact.depthCapped) {
      score += 5;
      riskFactors.push(`blast radius exceeds max depth ${impact.maxDepth} — impact likely understated`);
    }

    return {
      id: pr.id,
      label: pr.label,
      changedFileCount: changed.length,
      affectedFileCount: impact.totalAffected,
      riskScore: score,
      riskFactors,
      unresolvedFiles: impact.unresolvedFiles,
    };
  });

  return results.sort((a, b) => b.riskScore - a.riskScore || b.affectedFileCount - a.affectedFileCount || a.id.localeCompare(b.id));
}
