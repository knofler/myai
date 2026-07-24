/**
 * community.ts — Leiden-style community detection over the brain entity graph
 * (BRAIN B-6, "temporal-aware knowledge graph" == the queued B10 Graphiti
 * entity/temporal layer's other half: plan/BRAIN_BUILD_PLAN.md day 8).
 *
 * entity.ts already ships the Graphiti-style half: entities + time-stamped
 * "touched" edges (BRAIN B10), answering per-entity "what changed about X" /
 * "when did I last touch Y". This module adds the GraphRAG half: a
 * co-occurrence graph over those same entities (two entities are edge-
 * connected — with a timestamped edge — when an atom mentions both), a Leiden
 * community-detection pass over it, and an extractive per-community summary.
 * That is what answers *global/thematic* queries ("what's been going on with
 * the auth area") that a single-entity lookup can't — read a handful of
 * community summaries instead of scanning every atom.
 *
 * Same contract as entity.ts: computed on read from the atoms already on
 * disk, no persistence, no LLM, deterministic (same atoms -> same graph ->
 * same partition -> same summaries). Leiden here means the real
 * distinguishing property over plain Louvain — a refinement pass that
 * guarantees every returned community induces a CONNECTED subgraph of the
 * original graph (Louvain's modularity-only local moving can strand
 * disconnected nodes in the same community; Leiden splits those apart) — not
 * just a relabeled Louvain.
 */

import { scanAtoms, extractEntities, stampToIso } from './entity.js';
import type { EntityKind } from './entity.js';
import { isBrainRepo, resolveBrainDir } from './brain.js';

// ── graph model ──────────────────────────────────────────────────────────────

export interface CommunityGraphNode {
  key: string;
  kind: EntityKind;
  name: string;
  /** Sum of incident co-occurrence edge weights. */
  degree: number;
  firstTouched: string;
  lastTouched: string;
  repos: string[];
}

/** A timestamped co-occurrence edge — two entities mentioned in the same atom(s). */
export interface CommunityGraphEdge {
  source: string;
  target: string;
  /** Number of atoms mentioning both entities. */
  weight: number;
  firstSeen: string;
  lastSeen: string;
}

interface Graph {
  nodes: CommunityGraphNode[];
  adj: Array<Map<number, number>>;
  edgeMeta: Map<string, { firstSeenRaw: string; lastSeenRaw: string }>;
}

const DEFAULT_ATOM_SCAN = 800;

function clamp(n: number | undefined, fallback: number, min: number, max: number): number {
  const v = Math.trunc(n ?? fallback);
  return Math.min(Math.max(v, min), max);
}

function edgeKey(i: number, j: number): string {
  return i < j ? `${i},${j}` : `${j},${i}`;
}

/** Build the entity co-occurrence graph from a deterministic atom scan (mirrors entity.ts's scan path). */
function buildGraph(dir: string, opts: { repo?: string; atomLimit: number }): { graph: Graph; atomsScanned: number; truncated: boolean } {
  const { atoms, truncated } = scanAtoms(dir, opts);

  const nodeIndex = new Map<string, number>();
  const nodes: CommunityGraphNode[] = [];
  const firstRaw: string[] = [];
  const lastRaw: string[] = [];
  const repoSets: Array<Set<string>> = [];
  const adj: Array<Map<number, number>> = [];
  const edgeMeta = new Map<string, { firstSeenRaw: string; lastSeenRaw: string }>();

  const nodeIdFor = (kind: EntityKind, name: string, repo: string, written: string): number => {
    const key = `${kind}::${name.toLowerCase()}`;
    let idx = nodeIndex.get(key);
    if (idx === undefined) {
      idx = nodes.length;
      nodeIndex.set(key, idx);
      nodes.push({ key, kind, name, degree: 0, firstTouched: '', lastTouched: '', repos: [] });
      firstRaw.push(written);
      lastRaw.push(written);
      repoSets.push(new Set());
      adj.push(new Map());
    } else {
      if (written < firstRaw[idx]) firstRaw[idx] = written;
      if (written > lastRaw[idx]) lastRaw[idx] = written;
    }
    if (repo) repoSets[idx].add(repo);
    return idx;
  };

  for (const atom of atoms) {
    const mentions = extractEntities(atom.body, atom.slug, atom.repo);
    if (mentions.length === 0) continue;
    const ids = [...new Set(mentions.map((m) => nodeIdFor(m.kind, m.name, atom.repo, atom.written)))];
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const i = ids[a];
        const j = ids[b];
        adj[i].set(j, (adj[i].get(j) ?? 0) + 1);
        adj[j].set(i, (adj[j].get(i) ?? 0) + 1);
        const ek = edgeKey(i, j);
        const meta = edgeMeta.get(ek);
        if (!meta) edgeMeta.set(ek, { firstSeenRaw: atom.written, lastSeenRaw: atom.written });
        else {
          if (atom.written < meta.firstSeenRaw) meta.firstSeenRaw = atom.written;
          if (atom.written > meta.lastSeenRaw) meta.lastSeenRaw = atom.written;
        }
      }
    }
  }

  for (let i = 0; i < nodes.length; i++) {
    nodes[i].firstTouched = stampToIso(firstRaw[i]);
    nodes[i].lastTouched = stampToIso(lastRaw[i]);
    nodes[i].repos = [...repoSets[i]].sort();
    let degree = 0;
    for (const w of adj[i].values()) degree += w;
    nodes[i].degree = degree;
  }

  return { graph: { nodes, adj, edgeMeta }, atomsScanned: atoms.length, truncated };
}

// ── Leiden: multi-level Louvain local-moving + aggregation, then a
//    connectivity-refinement pass (the actual Louvain -> Leiden delta) ───────

interface LevelGraph {
  n: number;
  neighbors: Array<Array<[number, number]>>;
  degree: Float64Array;
  m2: number;
}

function graphToLevel(graph: Graph): LevelGraph {
  const n = graph.nodes.length;
  const neighbors: Array<Array<[number, number]>> = [];
  const degree = new Float64Array(n);
  let m2 = 0;
  for (let i = 0; i < n; i++) {
    const list: Array<[number, number]> = [...graph.adj[i].entries()];
    neighbors.push(list);
    let deg = 0;
    for (const [, w] of list) deg += w;
    degree[i] = deg;
    m2 += deg;
  }
  return { n, neighbors, degree, m2 };
}

/** One Louvain local-moving pass to convergence: greedily move nodes to the neighboring community maximizing modularity gain. */
function localMoving(g: LevelGraph): Int32Array {
  const comm = new Int32Array(g.n);
  for (let i = 0; i < g.n; i++) comm[i] = i;
  if (g.m2 === 0) return comm; // no edges — every node its own singleton community

  const commTot = new Float64Array(g.n);
  for (let i = 0; i < g.n; i++) commTot[i] = g.degree[i];

  let improved = true;
  let guard = 0;
  while (improved && guard < 200) {
    improved = false;
    guard += 1;
    for (let i = 0; i < g.n; i++) {
      const ci = comm[i];
      commTot[ci] -= g.degree[i];

      const weightToComm = new Map<number, number>();
      for (const [j, w] of g.neighbors[i]) {
        if (j === i) continue;
        const cj = comm[j];
        weightToComm.set(cj, (weightToComm.get(cj) ?? 0) + w);
      }

      let bestComm = ci;
      let bestScore = (weightToComm.get(ci) ?? 0) - (commTot[ci] * g.degree[i]) / g.m2;
      for (const [cj, kiIn] of weightToComm) {
        if (cj === ci) continue;
        const score = kiIn - (commTot[cj] * g.degree[i]) / g.m2;
        if (score > bestScore) {
          bestScore = score;
          bestComm = cj;
        }
      }

      comm[i] = bestComm;
      commTot[bestComm] += g.degree[i];
      if (bestComm !== ci) improved = true;
    }
  }
  return comm;
}

function aggregate(g: LevelGraph, comm: Int32Array): { level: LevelGraph; remap: Map<number, number> } {
  const uniq = [...new Set(comm)];
  const remap = new Map<number, number>();
  uniq.forEach((c, idx) => remap.set(c, idx));
  const k = uniq.length;

  const neighAgg: Array<Map<number, number>> = Array.from({ length: k }, () => new Map());
  for (let i = 0; i < g.n; i++) {
    const ci = remap.get(comm[i])!;
    for (const [j, w] of g.neighbors[i]) {
      if (j === i) continue; // level-0 graphs never carry self-loops
      const cj = remap.get(comm[j])!;
      if (cj === ci) continue; // internal edge — dropped; only inter-community weight matters for further splitting
      neighAgg[ci].set(cj, (neighAgg[ci].get(cj) ?? 0) + w);
    }
  }

  const neighbors = neighAgg.map((m) => [...m.entries()] as Array<[number, number]>);
  const degree = new Float64Array(k);
  let m2 = 0;
  for (let c = 0; c < k; c++) {
    let deg = 0;
    for (const [, w] of neighbors[c]) deg += w;
    degree[c] = deg;
    m2 += deg;
  }
  return { level: { n: k, neighbors, degree, m2 }, remap };
}

const MAX_LEVELS = 20;

/** Multi-level Louvain modularity optimization — returns a community id per original node. */
function louvain(graph: Graph): Int32Array {
  const n = graph.nodes.length;
  if (n === 0) return new Int32Array(0);

  let level = graphToLevel(graph);
  const nodeAtLevel = new Int32Array(n);
  for (let i = 0; i < n; i++) nodeAtLevel[i] = i;

  for (let iter = 0; iter < MAX_LEVELS; iter++) {
    const comm = localMoving(level);
    const uniq = new Set(comm);
    if (uniq.size === level.n) break; // converged — no further merging improves modularity

    const { level: nextLevel, remap } = aggregate(level, comm);
    for (let i = 0; i < n; i++) nodeAtLevel[i] = remap.get(comm[nodeAtLevel[i]])!;
    if (nextLevel.n === level.n || nextLevel.n <= 1) {
      level = nextLevel;
      break;
    }
    level = nextLevel;
  }
  return nodeAtLevel;
}

/**
 * Leiden's connectivity guarantee: split any community whose members do not
 * form a single connected component in the ORIGINAL graph into one community
 * per component. Louvain's local moving alone can strand a node in a
 * community it shares no direct or indirect edge with (it moved there via an
 * aggregated super-node in an earlier level); this pass repairs that.
 */
function refineConnectivity(graph: Graph, comm: Int32Array): Int32Array {
  const n = graph.nodes.length;
  const byComm = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    if (!byComm.has(comm[i])) byComm.set(comm[i], []);
    byComm.get(comm[i])!.push(i);
  }

  const result = new Int32Array(n).fill(-1);
  let nextId = 0;
  for (const members of byComm.values()) {
    const memberSet = new Set(members);
    const visited = new Set<number>();
    for (const start of members) {
      if (visited.has(start)) continue;
      const compId = nextId;
      nextId += 1;
      const queue = [start];
      visited.add(start);
      result[start] = compId;
      while (queue.length > 0) {
        const cur = queue.shift()!;
        for (const neigh of graph.adj[cur].keys()) {
          if (memberSet.has(neigh) && !visited.has(neigh)) {
            visited.add(neigh);
            result[neigh] = compId;
            queue.push(neigh);
          }
        }
      }
    }
  }
  return result;
}

// ── community summaries (GraphRAG-style, extractive — no LLM) ────────────────

export interface Community {
  id: number;
  size: number;
  /** Sum of member node degrees — a cheap proxy for how "active"/central this community is. */
  totalWeight: number;
  entities: CommunityGraphNode[];
  repos: string[];
  firstTouched: string;
  lastTouched: string;
  /** Top intra-community co-occurrence edges, timestamped. */
  edges: CommunityGraphEdge[];
  /** Extractive, deterministic summary: top entities + repos + active window. */
  summary: string;
}

const TOP_ENTITIES_IN_SUMMARY = 6;
const TOP_EDGES_PER_COMMUNITY = 8;

function buildCommunity(id: number, memberIdx: number[], graph: Graph): Community {
  const members = memberIdx
    .map((i) => graph.nodes[i])
    .slice()
    .sort((a, b) => b.degree - a.degree);

  const repos = [...new Set(members.flatMap((m) => m.repos))].sort();
  const touched = members.map((m) => [m.firstTouched, m.lastTouched]).filter(([f]) => f);
  const firstTouched = touched.length ? touched.map(([f]) => f).sort()[0] : '';
  const lastTouched = touched.length ? touched.map(([, l]) => l).sort().at(-1)! : '';
  const totalWeight = members.reduce((sum, m) => sum + m.degree, 0);

  const memberSet = new Set(memberIdx);
  const edges: CommunityGraphEdge[] = [];
  for (const i of memberIdx) {
    for (const [j, w] of graph.adj[i]) {
      if (j <= i || !memberSet.has(j)) continue;
      const meta = graph.edgeMeta.get(edgeKey(i, j));
      edges.push({
        source: graph.nodes[i].name,
        target: graph.nodes[j].name,
        weight: w,
        firstSeen: stampToIso(meta?.firstSeenRaw ?? ''),
        lastSeen: stampToIso(meta?.lastSeenRaw ?? ''),
      });
    }
  }
  edges.sort((a, b) => b.weight - a.weight);

  const top = members.slice(0, TOP_ENTITIES_IN_SUMMARY).map((m) => m.name);
  const repoPart = repos.length ? ` — repo(s): ${repos.join(', ')}` : '';
  const windowPart = firstTouched && lastTouched ? ` (active ${firstTouched} → ${lastTouched})` : '';
  const summary = `${top.join(', ')}${repoPart}${windowPart}`;

  return {
    id,
    size: members.length,
    totalWeight,
    entities: members,
    repos,
    firstTouched,
    lastTouched,
    edges: edges.slice(0, TOP_EDGES_PER_COMMUNITY),
    summary,
  };
}

export interface BrainCommunitiesResult {
  initialized: boolean;
  query?: string;
  repo?: string;
  atomsScanned: number;
  truncated: boolean;
  communityCount: number;
  communities: Community[];
}

/**
 * GraphRAG-style global/thematic recall: "what's been going on with the auth
 * area" without knowing which entity to ask about. Builds the entity
 * co-occurrence graph from the atoms already on disk, runs Leiden-style
 * community detection, and returns the resulting communities as compact
 * extractive summaries, largest/most-active first. Pass `query` to filter to
 * communities whose summary or member entity names match (substring,
 * case-insensitive) — a thematic search over the community layer rather than
 * the raw atoms. Deterministic + LLM-free, same as entity.ts.
 */
export function brainCommunities(
  opts: { query?: string; repo?: string; limit?: number; atomLimit?: number; minSize?: number } = {},
  env: NodeJS.ProcessEnv = process.env,
): BrainCommunitiesResult {
  const dir = resolveBrainDir(env);
  if (!isBrainRepo(dir)) {
    return { initialized: false, atomsScanned: 0, truncated: false, communityCount: 0, communities: [] };
  }

  const atomLimit = clamp(opts.atomLimit, DEFAULT_ATOM_SCAN, 1, 5000);
  const minSize = clamp(opts.minSize, 2, 1, 50);
  const limit = clamp(opts.limit, 20, 1, 200);

  const { graph, atomsScanned, truncated } = buildGraph(dir, { repo: opts.repo, atomLimit });
  const louvainPartition = louvain(graph);
  const partition = refineConnectivity(graph, louvainPartition);

  const byId = new Map<number, number[]>();
  for (let i = 0; i < graph.nodes.length; i++) {
    if (!byId.has(partition[i])) byId.set(partition[i], []);
    byId.get(partition[i])!.push(i);
  }

  let communities = [...byId.values()]
    .filter((members) => members.length >= minSize)
    .map((members, idx) => buildCommunity(idx, members, graph));

  const q = opts.query?.trim().toLowerCase();
  if (q) {
    communities = communities.filter(
      (c) => c.summary.toLowerCase().includes(q) || c.entities.some((e) => e.name.toLowerCase().includes(q)),
    );
  }

  communities.sort((a, b) => b.totalWeight - a.totalWeight || b.size - a.size);
  communities = communities.slice(0, limit).map((c, idx) => ({ ...c, id: idx }));

  return {
    initialized: true,
    query: opts.query?.trim() || undefined,
    repo: opts.repo,
    atomsScanned,
    truncated,
    communityCount: communities.length,
    communities,
  };
}
