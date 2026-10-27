#!/usr/bin/env node
// mcp_local_stdio.mjs — the myAI MCP server for a machine WITHOUT the gateway
// (v1 G2 B2). Dependency-free: node built-ins, git and bash only, so it runs
// straight from an `npm i -g` install with no runtime build and no Docker.
//
// It serves the brain-only subset of the gateway's tools over newline-
// delimited JSON-RPC on stdin/stdout (the MCP stdio transport), against the
// SAME brain the Docker gateway mounts (B5). Nothing here has a store of its
// own:
//   - every write goes through `scripts/myai_brain.sh write` — the CLI the user
//     already has — so atoms, commits and file ownership are identical to the
//     gateway's and to `myai brain write`;
//   - every read is the brain working tree, with the gateway's own rules
//     (headline handoff: runtime/src/repos/handoff-reconcile.ts; atom search:
//     runtime/src/core/brain-search.ts searchAtoms). KEEP THEM IN SYNC.
// So what is written here is what the gateway reads after `myai up`, and what
// the gateway writes (handoff_write commits an atom too) is what this reads
// after `myai down`.
//
// Repo: MYAI_REPO_HINT, else the brain namespace in the project's .myai-local,
// else the git checkout's canonical id (scripts/lib/repo_id.sh), else none.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const BRAIN_CLI = join(ROOT, 'scripts', 'myai_brain.sh');
const VERSION = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '0'; } catch { return '0'; }
})();
export const OFFLINE_NOTICE =
  'myAI offline mode: brain + recall only (no gateway reachable). Run `myai up` for tasks, the dashboard and the full tool set.';

const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const SESSION_SCAN = 200;
const DEFAULT_ATOM_SCAN = 500;
const SNIPPET_CHARS = 220;
const PLACEHOLDER_MARK = '_Not compiled yet';

// ── brain + repo resolution ───────────────────────────────────────────────────

export function brainDir(env = process.env) {
  if (env.MYAI_BRAIN_DIR) return env.MYAI_BRAIN_DIR;
  const home = env.MYAI_HOME || join(env.HOME || homedir(), '.myai');
  try {
    const p = readFileSync(join(home, 'brain.path'), 'utf8').split('\n')[0].trim();
    if (p) return p;
  } catch { /* no pointer */ }
  return join(home, 'brain');
}

const isBrain = (d) => existsSync(join(d, '.git')) && existsSync(join(d, 'BRAIN.md'));

// Same rule as _brain_slugify (brain.sh) and slugify (brain.ts).
export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export function repoHint(env = process.env, cwd = process.cwd()) {
  const clean = (v) => (v && REPO_RE.test(v) ? v : '');
  if (env.MYAI_REPO_HINT !== undefined) return clean(env.MYAI_REPO_HINT);
  const start = resolve(env.CLAUDE_PROJECT_DIR || cwd);
  for (let d = start; ; d = dirname(d)) {
    const f = join(d, '.myai-local');
    if (existsSync(f)) {
      try { return clean(JSON.parse(readFileSync(f, 'utf8')).namespace); } catch { return ''; }
    }
    if (existsSync(join(d, '.git')) || dirname(d) === d) break;
  }
  const top = spawnSync('git', ['-C', start, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0) return '';
  const dir = top.stdout.trim();
  const id = spawnSync('bash', ['-c', '. "$1/scripts/lib/repo_id.sh" && canonical_repo_id "$2"', '_', ROOT, dir], { encoding: 'utf8' });
  return clean((id.status === 0 && id.stdout.trim()) || basename(dir));
}

// ── atom reads (the gateway's rules, on the working tree) ────────────────────

function parseAtom(raw) {
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n\n?/);
  const meta = {};
  if (!fm) return { meta, body: raw.trim() };
  for (const line of fm[1].split('\n')) {
    const m = line.match(/^([A-Za-z0-9_-]+):\s?(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: raw.slice(fm[0].length).trim() };
}

const atomFiles = (abs) => (existsSync(abs) ? readdirSync(abs).filter((f) => /^\d{8}T\d{6}Z-.*\.md$/.test(f)).sort().reverse() : []);

/** handoff-reconcile.ts brainHeadline: newest handoff or hand-written session atom, handoff first on a tie. */
export function brainHeadline(repo, env = process.env) {
  const dir = brainDir(env);
  const ns = slugify(repo || '');
  if (!ns || !isBrain(dir)) return undefined;
  const pick = (sub, kind, limit) => {
    for (const f of atomFiles(join(dir, 'repos', ns, sub)).slice(0, limit)) {
      let raw;
      try { raw = readFileSync(join(dir, 'repos', ns, sub, f), 'utf8'); } catch { continue; }
      const { meta, body } = parseAtom(raw);
      if (meta.kind && meta.kind !== kind) continue;
      if (!body) continue;
      return { path: `repos/${ns}/${sub}/${f}`, ts: f.slice(0, 16), kind, body };
    }
    return undefined;
  };
  const h = pick('handoffs', 'handoff', 1);
  const s = pick('sessions', 'session', SESSION_SCAN);
  if (!h) return s;
  if (!s) return h;
  return s.ts > h.ts ? s : h;
}

const stampToIso = (ts) => {
  const m = String(ts).match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : '';
};

/** handoff-reconcile.ts headlineView: the handoff store's shape. */
export function headlineView(repo, h) {
  const at = stampToIso(h.ts);
  const firstLine = h.body.split('\n').find((l) => l.trim()) ?? '';
  return {
    id: `brain:${h.path}`,
    repo,
    content: h.body,
    summary: firstLine.replace(/\s+/g, ' ').trim().slice(0, 240),
    author: 'brain',
    status: 'active',
    metadata: { source: 'brain', atom: h.path, atomKind: h.kind },
    createdAt: at,
    updatedAt: at,
  };
}

function compiledBrief(repo, env) {
  const ns = slugify(repo || '');
  if (!ns) return undefined;
  const r = spawnSync('git', ['-C', brainDir(env), 'show', `main:repos/${ns}/brief.md`], { encoding: 'utf8' });
  const text = r.status === 0 ? r.stdout.trim() : '';
  return text && !text.includes(PLACEHOLDER_MARK) ? text : undefined;
}

/** brain-search.ts searchAtoms: term frequency over slug + body × age decay, newest first on ties. */
export function searchAtoms(query, opts = {}, env = process.env) {
  const dir = brainDir(env);
  const terms = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!isBrain(dir) || !terms.length) return { hits: [], atomsScanned: 0, atomsTruncated: false };
  const nsFilter = opts.repo ? slugify(opts.repo) : undefined;
  const rels = [];
  const reposDir = join(dir, 'repos');
  const nsNames = existsSync(reposDir) ? readdirSync(reposDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
  for (const ns of nsNames) {
    if (nsFilter && ns !== nsFilter) continue;
    for (const f of atomFiles(join(reposDir, ns, 'sessions'))) rels.push({ rel: `repos/${ns}/sessions/${f}`, f, kind: 'session', repo: ns });
    for (const f of atomFiles(join(reposDir, ns, 'handoffs'))) rels.push({ rel: `repos/${ns}/handoffs/${f}`, f, kind: 'handoff', repo: ns });
  }
  for (const f of atomFiles(join(dir, 'memory'))) rels.push({ rel: `memory/${f}`, f, kind: 'memory', repo: '' });
  rels.sort((a, b) => b.f.localeCompare(a.f));
  const atomLimit = Math.min(Math.max(Math.trunc(opts.atomLimit || DEFAULT_ATOM_SCAN), 1), 5000);
  const kept = rels.slice(0, atomLimit);
  const halfLife = Number(env.BRAIN_RECALL_HALF_LIFE_DAYS) > 0 ? Number(env.BRAIN_RECALL_HALF_LIFE_DAYS) : 30;
  const floorEnv = Number(env.BRAIN_RECALL_DECAY_FLOOR);
  const floor = Number.isFinite(floorEnv) && floorEnv >= 0 && floorEnv <= 1 && env.BRAIN_RECALL_DECAY_FLOOR !== undefined ? floorEnv : 0.15;
  const now = Date.now();
  const scored = [];
  for (const a of kept) {
    let raw;
    try { raw = readFileSync(join(dir, a.rel), 'utf8'); } catch { continue; }
    const { meta, body } = parseAtom(raw);
    const slug = meta.slug || a.f.replace(/\.md$/, '');
    const hay = `${slug} ${body}`.toLowerCase();
    let score = 0;
    for (const t of terms) for (let i = hay.indexOf(t); i !== -1; i = hay.indexOf(t, i + t.length)) score += 1;
    if (!score) continue;
    const written = meta.written || a.f.slice(0, 16);
    const pinned = meta.pin === 'true';
    const iso = stampToIso(written);
    const age = iso ? now - Date.parse(iso) : 0;
    const decay = pinned || !(age > 0) ? 1 : Math.max(floor, 0.5 ** (age / (halfLife * 86_400_000)));
    const line = body.split('\n').find((l) => l.trim() && terms.some((t) => l.toLowerCase().includes(t))) ?? body;
    const flat = line.replace(/\s+/g, ' ').trim();
    scored.push({
      kind: 'atom',
      repo: meta.repo && meta.repo !== '—' ? meta.repo : a.repo,
      score: score * decay,
      snippet: flat.length <= SNIPPET_CHARS ? flat : flat.slice(0, SNIPPET_CHARS - 1).trimEnd() + '…',
      written,
      ...(pinned ? { pinned: true } : {}),
      decay,
      atomKind: a.kind,
      path: a.rel,
    });
  }
  scored.sort((x, y) => y.score - x.score || y.written.localeCompare(x.written));
  const limit = Math.min(Math.max(Math.trunc(opts.limit || 10), 1), 100);
  return { hits: scored.slice(0, limit), atomsScanned: kept.length, atomsTruncated: rels.length > atomLimit };
}

// ── writes (through the user's own brain CLI) ─────────────────────────────────

function brainWrite(kind, repo, slug, content, env, topic) {
  const r = spawnSync('bash', [BRAIN_CLI, 'write', kind, repo || '-', slug], {
    input: content,
    encoding: 'utf8',
    env: { ...env, ...(topic ? { BRAIN_TOPIC: topic } : {}) },
  });
  const lines = (r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || 'brain write failed').trim().split('\n').pop());
  const path = lines.pop() || '';
  const deduped = lines.some((l) => l.includes('(dedup, no-op)'));
  const sha8 = path.match(/-([0-9a-f]{8})\.md$/)?.[1] ?? '';
  return { path, sha8, created: !deduped };
}

const utcStamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** handoff-reconcile.ts waitForFreshSecond: never share a second with the newest handoff atom. */
function waitForFreshSecond(repo, env) {
  const newest = atomFiles(join(brainDir(env), 'repos', slugify(repo), 'handoffs'))[0]?.slice(0, 16);
  if (!newest) return;
  const tick = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 2000;
  while (utcStamp() <= newest && Date.now() < deadline) Atomics.wait(tick, 0, 0, 50);
}

/** tools.ts writeHandoffAtom: slug `handoff`, a fresh second, and a stale dedup re-written under a stamped slug. */
function handoffWrite(repo, content, env) {
  waitForFreshSecond(repo, env);
  const first = brainWrite('handoff', repo, 'handoff', content, env, 'continuity');
  if (first.created || brainHeadline(repo, env)?.path === first.path) return first;
  return brainWrite('handoff', repo, `handoff-${utcStamp()}`, content, env, 'continuity');
}

// ── tools ─────────────────────────────────────────────────────────────────────

const str = (d) => ({ type: 'string', description: d });
const num = (d) => ({ type: 'number', description: d });
export const TOOLS = [
  { name: 'context_boot', description: `${OFFLINE_NOTICE} The boot brief: who / state (active project) / handoff, from the local brain.`,
    inputSchema: { type: 'object', properties: { repo: str('Project namespace (default: this repo)') } } },
  { name: 'handoff_write', description: 'Write the handoff for a repo — committed to the brain as a `handoff` atom (the gateway reads the same atom after `myai up`).',
    inputSchema: { type: 'object', properties: { repo: str('Project namespace'), content: str('Handoff content'), summary: str('Ignored offline; the first line is the summary') }, required: ['repo', 'content'] } },
  { name: 'handoff_read', description: 'Read the latest handoff for a repo (newest headline atom in the brain); omit repo for the latest of every namespace.',
    inputSchema: { type: 'object', properties: { repo: str('Project namespace (optional)') } } },
  { name: 'brain_commit', description: 'Commit an atom to the brain (kind session | handoff | memory), via `myai brain write`.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['session', 'handoff', 'memory'] }, repo: str('Project namespace (omit for cross-repo memory)'), slug: str('Short slug'), content: str('Atom content'), topic: str('ADR-020 topic (optional)') }, required: ['kind', 'slug', 'content'] } },
  { name: 'brain_search', description: 'Keyword recall over the brain atoms (sessions, handoffs, memory). Offline: atoms only, no session-corpus vectors.',
    inputSchema: { type: 'object', properties: { query: str('Search terms'), repo: str('Narrow to one namespace (optional)'), k: num('Max results (default 10)'), atomLimit: num('Newest atoms scanned (default 500)') }, required: ['query'] } },
  { name: 'memory_search', description: 'Offline memory search: the same keyword recall over every brain atom (no vector store without the gateway).',
    inputSchema: { type: 'object', properties: { query: str('Search terms'), limit: num('Max results (default 10)') }, required: ['query'] } },
  { name: 'brain_log', description: 'Recent brain commits.',
    inputSchema: { type: 'object', properties: { limit: num('How many (default 20)') } } },
  { name: 'brain_status', description: 'Brain location, branch, head and namespaces.',
    inputSchema: { type: 'object', properties: {} } },
];

const tighten = (t, max) => { const f = t.replace(/\s+/g, ' ').trim(); return f.length <= max ? f : f.slice(0, max - 1).trimEnd() + '…'; };

function boot(repo, env) {
  const state = repo ? `Active project: ${repo}` : 'Active project: none yet — run `myai init` in a repo to give this agent a project';
  const brief = repo ? compiledBrief(repo, env) : undefined;
  const h = repo ? brainHeadline(repo, env) : undefined;
  const handoff = brief ? tighten(brief, 1200) : h ? tighten(headlineView(repo, h).summary || h.body, 1200) : undefined;
  const lines = [
    '# myAI operator brief (offline)',
    '',
    OFFLINE_NOTICE,
    `**State:** ${state}`,
    ...(handoff ? [`**Handoff:** ${handoff}`] : []),
  ];
  return { bundle: lines.join('\n') + '\n', brief: { who: 'myAI user (offline: local brain)', state, handoff }, mode: 'offline', lazyRecall: ['handoff_read', 'brain_search', 'memory_search'] };
}

function callTool(name, args, ctx) {
  const env = ctx.env;
  const repoArg = (a) => (typeof a === 'string' && a.trim() ? a.trim() : ctx.repo);
  switch (name) {
    case 'context_boot': return boot(repoArg(args.repo), env);
    case 'handoff_write': {
      const repo = repoArg(args.repo);
      if (!repo) return { error: 'repo is required' };
      if (!args.content || !String(args.content).trim()) return { error: 'content is required' };
      const atom = handoffWrite(repo, String(args.content), env);
      const h = brainHeadline(repo, env);
      return { saved: true, atom: { path: atom.path, sha8: atom.sha8 }, handoff: h ? headlineView(repo, h) : undefined, mode: 'offline' };
    }
    case 'handoff_read': {
      const dir = brainDir(env);
      if (typeof args.repo === 'string' && args.repo.trim()) {
        const repo = args.repo.trim();
        const h = brainHeadline(repo, env);
        return { repo, latest: h ? headlineView(repo, h) : null, history: [], total: atomFiles(join(dir, 'repos', slugify(repo), 'handoffs')).length };
      }
      const reposDir = join(dir, 'repos');
      const names = existsSync(reposDir) ? readdirSync(reposDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
      const handoffs = names.map((ns) => { const h = brainHeadline(ns, env); return h ? headlineView(ns, h) : null; }).filter(Boolean)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      return { count: handoffs.length, handoffs };
    }
    case 'brain_commit': {
      if (args.supersedes || args.pin || args.code_repo || args.code_sha) {
        return { error: 'supersedes / pin / code provenance need the gateway — run `myai up`, or commit without them' };
      }
      const kind = String(args.kind || '');
      if (!['session', 'handoff', 'memory'].includes(kind)) return { error: 'kind must be session | handoff | memory' };
      if (!args.slug) return { error: 'slug is required' };
      if (!args.content || !String(args.content).trim()) return { error: 'content is required' };
      const repo = kind === 'memory' ? (typeof args.repo === 'string' && args.repo.trim()) || '' : repoArg(args.repo);
      if (kind !== 'memory' && !repo) return { error: `kind '${kind}' requires a repo` };
      const r = brainWrite(kind, repo, String(args.slug), String(args.content), env, args.topic ? String(args.topic) : undefined);
      return { ...r, deduped: !r.created };
    }
    case 'brain_search':
    case 'memory_search': {
      const q = String(args.query || '');
      if (!q.trim()) return { error: 'query is required' };
      const r = searchAtoms(q, { repo: name === 'brain_search' ? args.repo : undefined, limit: args.k || args.limit, atomLimit: args.atomLimit }, env);
      return { query: q, count: r.hits.length, atomsScanned: r.atomsScanned, atomsTruncated: r.atomsTruncated, hits: r.hits, mode: 'offline' };
    }
    case 'brain_log': {
      const n = Math.min(Math.max(Math.trunc(Number(args.limit) || 20), 1), 200);
      const r = spawnSync('git', ['-C', brainDir(env), 'log', `-n${n}`, '--format=%H%x09%cI%x09%s'], { encoding: 'utf8' });
      if (r.status !== 0) return { error: `no brain at ${brainDir(env)} — run \`myai init\`` };
      const entries = r.stdout.split('\n').filter(Boolean).map((l) => { const [sha, date, subject] = l.split('\t'); return { sha, date, subject }; });
      return { count: entries.length, entries };
    }
    case 'brain_status': {
      const dir = brainDir(env);
      if (!isBrain(dir)) return { dir, exists: false };
      const g = (...a) => spawnSync('git', ['-C', dir, ...a], { encoding: 'utf8' }).stdout.trim();
      const reposDir = join(dir, 'repos');
      const namespaces = existsSync(reposDir) ? readdirSync(reposDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name) : [];
      return { dir, exists: true, branch: g('rev-parse', '--abbrev-ref', 'HEAD'), head: g('rev-parse', '--short', 'HEAD'), namespaces, host: hostname(), mode: 'offline' };
    }
    default:
      return { error: `${name} needs the myAI gateway — run \`myai up\` (offline mode serves: ${TOOLS.map((t) => t.name).join(', ')})` };
  }
}

// ── JSON-RPC over stdio ───────────────────────────────────────────────────────

export function handle(msg, ctx) {
  const { id, method, params = {} } = msg || {};
  if (id === undefined || id === null) return undefined; // notification
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  switch (method) {
    case 'initialize':
      return ok({
        protocolVersion: params.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'myai-local', version: VERSION },
        instructions: boot(ctx.repo, ctx.env).bundle,
      });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      let result;
      try { result = callTool(params.name, params.arguments || {}, ctx); } catch (err) { result = { error: err.message }; }
      return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }], ...(result && result.error ? { isError: true } : {}) });
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** `myai plug proof` with no gateway: the handshake an agent would get, in-process. */
function proof(ctx) {
  const dir = brainDir(ctx.env);
  if (!isBrain(dir)) {
    console.log(`  ✗ no brain at ${dir} — run \`myai init\` in your repo first`);
    return 1;
  }
  const init = handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, ctx).result;
  console.log(`  ✓ initialize — connected to ${init.serverInfo.name} v${init.serverInfo.version} (offline)`);
  const b = boot(ctx.repo, ctx.env);
  console.log(`  ✓ auto-boot — ${b.brief.state}`);
  console.log(`  ✓ context_boot — ${b.brief.handoff ? `handoff: ${tighten(b.brief.handoff, 100)}` : 'no handoff yet (handoff_write saves one)'}`);
  console.log(`  ✓ brain — ${dir} (${TOOLS.length} offline tools: ${TOOLS.map((t) => t.name).join(', ')})`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ctx = { env: process.env, repo: repoHint() };
  if (process.argv.includes('--proof')) process.exit(proof(ctx));
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
      return;
    }
    const out = handle(msg, ctx);
    if (out) process.stdout.write(JSON.stringify(out) + '\n');
  });
  rl.on('close', () => process.exit(0));
}
