// Fallback brain reader for deployments that can't reach the operator's
// gateway (GATEWAY_MCP_URL defaults to `http://gateway:3100/mcp`, a
// Docker-internal host — see documentation/BRAIN_DASHBOARD.md). The brain is
// already a real, portable git repo (runtime/src/core/brain.ts) with its own
// `origin` remote; this module reads that SAME on-disk layout directly over
// the GitHub REST API — no gateway hop, no git binary (Vercel's Node runtime
// doesn't ship one), just plain `fetch`.
//
// Mirrors brainExplore()'s output shape closely enough for the dashboard to
// render unmodified, with two accepted degradations vs. the gateway path:
//   - provenance entries omit `atoms` (the touched atom files) — getting that
//     would cost one extra API call per commit; the code↔branch↔sha links
//     (the point of the tab) are unaffected.
//   - branches/commits are capped by what the REST endpoints return in one
//     page, same as the gateway path's own limits.
//
// Configure via env on the remote deployment:
//   BRAIN_GIT_REMOTE  the brain's git remote — same value `git -C ~/.myai/brain
//                     remote get-url origin` prints (git@github.com:... or
//                     https://github.com/... or a bare owner/repo)
//   BRAIN_GIT_BRANCH  defaults to 'main'
//   BRAIN_GIT_TOKEN   GitHub PAT — required for a private repo, and raises the
//                     unauthenticated 60/hr rate limit either way

import type {
  BrainAtomMeta,
  BrainBlameEntry,
  BrainExplore,
  BrainLogEntry,
  BrainNamespaceSummary,
  BrainSection,
  BrainStashDetail,
} from './brain';

type AtomKind = BrainAtomMeta['kind'];

export interface BrainGitRemoteConfig {
  owner: string;
  repo: string;
  branch: string;
  token?: string;
}

/** Parse the handful of shapes `git remote get-url origin` can print for a
 *  GitHub remote. Returns null for anything else (non-GitHub host, unset). */
export function parseGithubRemote(raw: string): { owner: string; repo: string } | null {
  const s = raw.trim().replace(/\/+$/, '');
  if (!s) return null;
  let m = s.match(/^git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^(?:https?:\/\/)?(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  m = s.match(/^([\w.-]+)\/([\w.-]+?)(\.git)?$/);
  if (m) return { owner: m[1], repo: m[2] };
  return null;
}

/** Resolve the remote config from env, or null when unconfigured / unparsable. */
export function brainGitRemoteConfig(env: NodeJS.ProcessEnv = process.env): BrainGitRemoteConfig | null {
  const raw = env.BRAIN_GIT_REMOTE;
  if (!raw) return null;
  const parsed = parseGithubRemote(raw);
  if (!parsed) return null;
  return { ...parsed, branch: env.BRAIN_GIT_BRANCH || 'main', token: env.BRAIN_GIT_TOKEN };
}

const GITHUB_API = 'https://api.github.com';
const ATOM_LIMIT = 40; // bounded to keep the per-atom Contents-API call count sane
const STASH_PREVIEW_CHARS = 240;

function ghHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

async function ghGet<T>(path: string, token?: string): Promise<T | null> {
  try {
    const res = await fetch(`${GITHUB_API}${path}`, {
      headers: ghHeaders(token),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

interface GhTreeEntry { path: string; type: 'blob' | 'tree'; sha: string; size?: number }
interface GhTreeResponse { tree: GhTreeEntry[]; truncated: boolean }
interface GhCommit { sha: string; commit: { message: string; author?: { date?: string } } }
interface GhBranch { name: string }
interface GhContent { content?: string; encoding?: string }

async function fetchFileContent(cfg: BrainGitRemoteConfig, path: string): Promise<string | null> {
  const res = await ghGet<GhContent>(
    `/repos/${cfg.owner}/${cfg.repo}/contents/${path}?ref=${encodeURIComponent(cfg.branch)}`,
    cfg.token,
  );
  if (!res?.content) return null;
  try {
    return Buffer.from(res.content, (res.encoding as BufferEncoding) || 'base64').toString('utf8');
  } catch {
    return null;
  }
}

/** Parse the leading `--- ... ---` frontmatter block into a key→value map —
 *  same contract as runtime/src/core/brain.ts's parseFrontmatter. */
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};
  const fm = raw.match(/^---\n([\s\S]*?)\n---\n\n?/);
  if (!fm) return { meta, body: raw };
  for (const line of fm[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { meta, body: raw.slice(fm[0].length) };
}

function fileOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function atomMetaFromFrontmatter(path: string, kind: AtomKind, ns: string, meta: Record<string, string>): BrainAtomMeta {
  const file = fileOf(path);
  const shaMatch = file.match(/-([0-9a-f]{8})\.md$/);
  const atom: BrainAtomMeta = {
    path,
    file,
    kind,
    repo: meta.repo && meta.repo !== '—' ? meta.repo : ns,
    slug: meta.slug || file.replace(/\.md$/, ''),
    host: meta.host || '',
    written: meta.written || '',
    sha8: shaMatch ? shaMatch[1] : '',
  };
  const commits = meta['code-commits'] ? meta['code-commits'].split(/\s+/).filter(Boolean) : [];
  if (meta['code-repo'] || meta['code-branch'] || meta['code-sha'] || commits.length) {
    atom.code = {
      repo: meta['code-repo'] || undefined,
      branch: meta['code-branch'] || undefined,
      sha: meta['code-sha'] || undefined,
      commits,
    };
  }
  return atom;
}

/** Trailer-parse one commit's Code-* lines (git trailer format writeAtom
 *  stamps — BRAIN B5) into the same shape brainBlame() returns. */
function provenanceFromCommit(c: GhCommit): BrainBlameEntry {
  const lines = c.commit.message.split('\n');
  const code: BrainBlameEntry['code'] = { commits: [] };
  for (const line of lines) {
    const m = line.match(/^Code-(Repo|Branch|SHA|Commit): (.+)$/);
    if (!m) continue;
    const value = m[2].trim();
    if (m[1] === 'Repo') code.repo = value;
    else if (m[1] === 'Branch') code.branch = value;
    else if (m[1] === 'SHA') code.sha = value;
    else code.commits.push(value);
  }
  return { sha: c.sha, short: c.sha.slice(0, 7), date: c.commit.author?.date || '', subject: lines[0] || '', atoms: [], code };
}

interface NsAccumulator { sessions: string[]; handoffs: string[]; hasBrief: boolean; hasWorking: boolean }

/**
 * The remote-read counterpart to runtime/src/core/brain.ts's brainExplore() —
 * same BrainExplore shape, sourced from the GitHub REST API against
 * BRAIN_GIT_REMOTE instead of a local `~/.myai/brain` checkout. Returns null
 * when no remote is configured, or the repo/branch is unreachable (bad token,
 * wrong name, rate-limited) — callers fall back to the existing "brain
 * unavailable" state in that case, same as a gateway miss.
 */
export async function fetchBrainExploreFromRemote(
  sections?: BrainSection[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<BrainExplore | null> {
  const cfg = brainGitRemoteConfig(env);
  if (!cfg) return null;

  // Same contract as runtime/src/core/brain.ts's brainExplore(): sections
  // omitted (undefined) = every expensive section; an explicit array
  // (including []) restricts to only those listed — [] means none, which is
  // exactly what the Overview tab passes (it needs none of the three).
  const want = (s: BrainSection) => !sections || sections.includes(s);

  const [tree, branchesRaw, commitsRaw] = await Promise.all([
    ghGet<GhTreeResponse>(`/repos/${cfg.owner}/${cfg.repo}/git/trees/${encodeURIComponent(cfg.branch)}?recursive=1`, cfg.token),
    ghGet<GhBranch[]>(`/repos/${cfg.owner}/${cfg.repo}/branches?per_page=100`, cfg.token),
    ghGet<GhCommit[]>(`/repos/${cfg.owner}/${cfg.repo}/commits?sha=${encodeURIComponent(cfg.branch)}&per_page=25`, cfg.token),
  ]);
  if (!tree) return null;

  // ── namespaces (repos/<name>/{sessions,handoffs}/*.md + brief/working.md) ──
  const nsMeta = new Map<string, NsAccumulator>();
  const ns = (name: string): NsAccumulator => {
    let v = nsMeta.get(name);
    if (!v) { v = { sessions: [], handoffs: [], hasBrief: false, hasWorking: false }; nsMeta.set(name, v); }
    return v;
  };
  const memoryFiles: string[] = [];
  const stashFiles: string[] = [];
  for (const e of tree.tree) {
    if (e.type !== 'blob') continue;
    let m = e.path.match(/^repos\/([^/]+)\/sessions\/(.+\.md)$/);
    if (m) { ns(m[1]).sessions.push(e.path); continue; }
    m = e.path.match(/^repos\/([^/]+)\/handoffs\/(.+\.md)$/);
    if (m) { ns(m[1]).handoffs.push(e.path); continue; }
    m = e.path.match(/^repos\/([^/]+)\/brief\.md$/);
    if (m) { ns(m[1]).hasBrief = true; continue; }
    m = e.path.match(/^repos\/([^/]+)\/working\.md$/);
    if (m) { ns(m[1]).hasWorking = true; continue; }
    if (/^memory\/.+\.md$/.test(e.path)) { memoryFiles.push(e.path); continue; }
    if (/^stash\/.+\.md$/.test(e.path)) { stashFiles.push(e.path); continue; }
  }

  const namespaces: BrainNamespaceSummary[] = [...nsMeta.keys()].sort().map((name) => {
    const m = nsMeta.get(name)!;
    return { name, sessions: m.sessions.length, handoffs: m.handoffs.length, hasBrief: m.hasBrief, hasWorking: m.hasWorking };
  });
  const totalSessions = namespaces.reduce((a, n) => a + n.sessions, 0);
  const totalHandoffs = namespaces.reduce((a, n) => a + n.handoffs, 0);
  const memoryAtoms = memoryFiles.length;

  // ── atoms (newest-first by filename UTC stamp, top ATOM_LIMIT read for frontmatter) ──
  type AtomRef = { path: string; kind: AtomKind; ns: string };
  const atomRefs: AtomRef[] = [];
  if (want('atoms')) {
    for (const [name, m] of nsMeta) {
      for (const p of m.sessions) atomRefs.push({ path: p, kind: 'session', ns: name });
      for (const p of m.handoffs) atomRefs.push({ path: p, kind: 'handoff', ns: name });
    }
    for (const p of memoryFiles) atomRefs.push({ path: p, kind: 'memory', ns: '' });
  }
  const totalAtoms = totalSessions + totalHandoffs + memoryAtoms;

  let atoms: BrainAtomMeta[] = [];
  let atomsTruncated = false;
  if (want('atoms')) {
    atomRefs.sort((a, b) => fileOf(b.path).localeCompare(fileOf(a.path)));
    const slice = atomRefs.slice(0, ATOM_LIMIT);
    atomsTruncated = totalAtoms > slice.length;
    const contents = await Promise.all(slice.map((r) => fetchFileContent(cfg, r.path)));
    atoms = slice.map((r, i) => {
      const raw = contents[i];
      const meta = raw ? parseFrontmatter(raw).meta : {};
      return atomMetaFromFrontmatter(r.path, r.kind, r.ns, meta);
    });
  }

  // ── stashes (stash/<slug>.md files committed straight to main) ──
  let stashes: BrainStashDetail[];
  if (want('stashes')) {
    const contents = await Promise.all(stashFiles.map((p) => fetchFileContent(cfg, p)));
    stashes = stashFiles.map((p, i) => {
      const file = fileOf(p);
      const slug = file.replace(/\.md$/, '');
      const raw = contents[i];
      if (!raw) return { slug, path: p, file, preview: '' };
      const { meta, body } = parseFrontmatter(raw);
      return {
        slug,
        path: p,
        file,
        from: meta.from || undefined,
        repo: meta.repo && meta.repo !== '—' ? meta.repo : undefined,
        host: meta.host || undefined,
        written: meta.written || undefined,
        preview: body.trim().slice(0, STASH_PREVIEW_CHARS),
      };
    });
  } else {
    stashes = stashFiles.map((p) => {
      const file = fileOf(p);
      return { slug: file.replace(/\.md$/, ''), path: p, file, preview: '' };
    });
  }

  // ── branches (session/* + idea/* prefixes) ──
  const branchNames = (branchesRaw || []).map((b) => b.name);
  const branches = {
    sessions: branchNames.filter((b) => /^session\//.test(b)),
    ideas: branchNames.filter((b) => /^idea\//.test(b)),
  };

  // ── recent commits + provenance (from the same commit list, one fetch) ──
  const recentCommits: BrainLogEntry[] = (commitsRaw || []).slice(0, 15).map((c) => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    date: c.commit.author?.date || '',
    subject: c.commit.message.split('\n')[0],
  }));
  let provenance: BrainBlameEntry[] = [];
  if (want('provenance') && commitsRaw) {
    provenance = commitsRaw.map(provenanceFromCommit).filter((e) => e.code.commits.length || e.code.sha);
  }

  const lastCommit = commitsRaw?.[0]
    ? `${commitsRaw[0].sha.slice(0, 7)} ${commitsRaw[0].commit.message.split('\n')[0]}`
    : undefined;

  return {
    dir: `${cfg.owner}/${cfg.repo}@${cfg.branch} (git remote)`,
    initialized: true,
    branch: cfg.branch,
    lastCommit,
    namespaces,
    memoryAtoms,
    totals: { sessions: totalSessions, handoffs: totalHandoffs, memory: memoryAtoms, namespaces: namespaces.length },
    atoms,
    atomsTruncated,
    stashes,
    branches,
    recentCommits,
    provenance,
  };
}
