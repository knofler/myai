// Swarm topology model — the product-facing view of the swarm-coordinator
// machinery documented in AI/documentation/SWARM_COORDINATION.md.
//
// The dashboard surfaces the 4 topologies (hierarchical / mesh / ring / star)
// as a picker when dispatching a multi-agent task, plus a live lane/progress
// view driven by the pure helpers below. Everything here is hermetic — no DOM,
// no gateway, no network — so it unit-tests anywhere and the client component
// (swarm-console.tsx) is a thin renderer on top.
//
// Keep the topology metadata in sync with SWARM_COORDINATION.md § "4 Topologies".

export type TopologyId = 'hierarchical' | 'mesh' | 'ring' | 'star';

export interface Topology {
  id: TopologyId;
  name: string;
  icon: string;
  /** One-line "what it's for" shown on the picker card. */
  tagline: string;
  bestFor: string;
  howItWorks: string;
  selectWhen: string;
  /** Small ASCII diagram lifted from the coordination doc. */
  diagram: string;
  accent: 'purple' | 'blue' | 'emerald' | 'amber';
}

export const TOPOLOGIES: Topology[] = [
  {
    id: 'hierarchical',
    name: 'Hierarchical',
    icon: '⊤',
    tagline: 'Coordinator delegates to lane leads, output flows back up the tree.',
    bestFor: 'Standard feature work with clear ownership boundaries.',
    howItWorks:
      'Coordinator delegates to lane leads, who delegate to specialists. Output flows back up the tree.',
    selectWhen: 'Task maps cleanly to existing lanes, no cross-cutting concerns.',
    diagram: [
      '      Coordinator',
      '     /     |     \\',
      ' Lane A  Lane B  Lane C',
    ].join('\n'),
    accent: 'purple',
  },
  {
    id: 'mesh',
    name: 'Mesh',
    icon: '⧉',
    tagline: 'Every agent talks to every other — shared context in real time.',
    bestFor: 'Refactors, migrations, and tasks where all agents need shared context.',
    howItWorks:
      'Every agent can communicate with every other agent. Coordinator tracks global state.',
    selectWhen: "Changes touch files across multiple lanes, or agents need each other's output in real-time.",
    diagram: [
      ' FE ←→ API ←→ DB',
      ' ↕     ↕     ↕',
      ' UX ←→ Dev ←→ Sec',
    ].join('\n'),
    accent: 'blue',
  },
  {
    id: 'ring',
    name: 'Ring',
    icon: '◯',
    tagline: 'Sequential pipeline — each stage hands off to the next.',
    bestFor: 'End-to-end feature builds where each stage depends on the previous.',
    howItWorks: 'Each agent completes their work and passes output to the next in the ring.',
    selectWhen: 'Schema → API → Frontend → Tests pipeline, or any sequential dependency chain.',
    diagram: [
      ' Arch → DB → API → FE → QA',
      '  ↑                     │',
      '  └─────────────────────┘',
    ].join('\n'),
    accent: 'amber',
  },
  {
    id: 'star',
    name: 'Star',
    icon: '✦',
    tagline: 'Fan out independent work in parallel, merge at the end.',
    bestFor: 'Batch operations where many agents do independent work.',
    howItWorks:
      'Coordinator dispatches all sub-tasks simultaneously. No inter-agent communication. Merge at the end.',
    selectWhen: 'Updating docs across repos, running audits, scaffolding multiple components.',
    diagram: [
      '     Coordinator',
      '    /  |  |  |  \\',
      '  A1  A2  A3  A4  A5',
    ].join('\n'),
    accent: 'emerald',
  },
];

const TOPOLOGY_BY_ID: Record<TopologyId, Topology> = TOPOLOGIES.reduce(
  (acc, t) => {
    acc[t.id] = t;
    return acc;
  },
  {} as Record<TopologyId, Topology>,
);

export function getTopology(id: TopologyId): Topology {
  return TOPOLOGY_BY_ID[id];
}

export function isTopologyId(value: string): value is TopologyId {
  return value === 'hierarchical' || value === 'mesh' || value === 'ring' || value === 'star';
}

/* ── Lanes ─────────────────────────────────────────────────── */
// The 4-lane parallel dispatch model the swarm sits on top of.

export type LaneId = 'A' | 'B' | 'C' | 'D';

export interface Lane {
  id: LaneId;
  name: string;
  specialists: string[];
}

export const LANES: Lane[] = [
  { id: 'A', name: 'Frontend', specialists: ['frontend-specialist', 'ui-ux-specialist'] },
  { id: 'B', name: 'Backend', specialists: ['api-specialist', 'database-specialist'] },
  { id: 'C', name: 'Infra', specialists: ['devops-specialist', 'security-specialist'] },
  { id: 'D', name: 'Async', specialists: ['documentation-specialist', 'product-manager', 'qa-specialist'] },
];

/* ── Topology recommendation ───────────────────────────────── */
// Mirrors the "Topology Selection Guide" decision tree in the doc, keyed off
// natural-language signals in the task description. Deterministic + pure so the
// picker can suggest a default the operator can override.

const SEQUENTIAL_HINTS = [
  'pipeline', 'sequential', 'end-to-end', 'end to end', 'step by step', 'then',
  'schema → api', 'schema to api', 'stage', 'chain', 'depends on', 'after',
];
const CROSS_CUTTING_HINTS = [
  'refactor', 'migrate', 'migration', 'rename across', 'across the codebase',
  'everywhere', 'cross-cutting', 'cross cutting', 'shared context', 'global change',
];
const INDEPENDENT_HINTS = [
  'batch', 'audit', 'across repos', 'across all repos', 'each repo', 'scaffold',
  'multiple components', 'independent', 'in parallel', 'fan out', 'bulk',
];

export interface TopologyRecommendation {
  id: TopologyId;
  reason: string;
}

export function recommendTopology(taskText: string): TopologyRecommendation {
  const text = (taskText || '').toLowerCase();
  const hit = (hints: string[]) => hints.some((h) => text.includes(h));

  // Decision tree order matches SWARM_COORDINATION.md:
  // sequential? → ring; 3+ lanes w/ shared files? → mesh; all independent? → star; else hierarchical.
  if (hit(SEQUENTIAL_HINTS)) {
    return { id: 'ring', reason: 'Sequential dependency chain detected — each stage feeds the next.' };
  }
  if (hit(CROSS_CUTTING_HINTS)) {
    return { id: 'mesh', reason: 'Cross-cutting change — agents need shared context across lanes.' };
  }
  if (hit(INDEPENDENT_HINTS)) {
    return { id: 'star', reason: 'Independent sub-tasks — fan out in parallel, merge at the end.' };
  }
  return { id: 'hierarchical', reason: 'Standard feature work — delegate through lane leads (default).' };
}

/* ── Live run model ────────────────────────────────────────── */
// A decomposed task = ordered sub-tasks (steps), each pinned to a lane + agent.
// The live lane view ticks steps pending → running → done. Advancement rules
// differ per topology, which is the whole point of exposing the picker.

export type StepStatus = 'pending' | 'running' | 'done';

export interface SwarmStep {
  id: string;
  title: string;
  agent: string;
  lane: LaneId;
  dependsOn: string[];
  status: StepStatus;
}

export interface SwarmRun {
  topology: TopologyId;
  steps: SwarmStep[];
}

// Demo decomposition — the JWT-auth example from the coordination doc. Gives the
// live view real content without a gateway round-trip.
export function demoSteps(): SwarmStep[] {
  return [
    { id: 'st-1', title: 'Design auth schema', agent: 'database-specialist', lane: 'B', dependsOn: [], status: 'pending' },
    { id: 'st-2', title: 'Implement auth middleware', agent: 'api-specialist', lane: 'B', dependsOn: ['st-1'], status: 'pending' },
    { id: 'st-3', title: 'Build login / register pages', agent: 'frontend-specialist', lane: 'A', dependsOn: ['st-2'], status: 'pending' },
    { id: 'st-4', title: 'Security review', agent: 'security-specialist', lane: 'C', dependsOn: ['st-2'], status: 'pending' },
    { id: 'st-5', title: 'Write auth tests', agent: 'qa-specialist', lane: 'D', dependsOn: ['st-2', 'st-3'], status: 'pending' },
  ];
}

export function newRun(topology: TopologyId, steps: SwarmStep[] = demoSteps()): SwarmRun {
  return { topology, steps: steps.map((s) => ({ ...s, status: 'pending' as StepStatus })) };
}

export interface RunProgress {
  done: number;
  running: number;
  pending: number;
  total: number;
  pct: number;
  complete: boolean;
}

export function runProgress(steps: SwarmStep[]): RunProgress {
  const total = steps.length;
  const done = steps.filter((s) => s.status === 'done').length;
  const running = steps.filter((s) => s.status === 'running').length;
  const pending = steps.filter((s) => s.status === 'pending').length;
  return {
    done,
    running,
    pending,
    total,
    pct: total === 0 ? 0 : Math.round((done / total) * 100),
    complete: total > 0 && done === total,
  };
}

/**
 * Which pending steps may START next, given the topology. Pure — does not
 * mutate. Returns step ids.
 *
 * - ring: strict order, one at a time — the first pending step, and only once
 *   everything before it is done.
 * - star: every pending step (fully independent, deps ignored).
 * - hierarchical / mesh: any pending step whose dependsOn are all done.
 */
export function startableStepIds(run: SwarmRun): string[] {
  const { topology, steps } = run;
  const doneIds = new Set(steps.filter((s) => s.status === 'done').map((s) => s.id));
  const anyRunning = steps.some((s) => s.status === 'running');

  if (topology === 'ring') {
    // One in flight at a time; strictly the earliest pending step in list order.
    if (anyRunning) return [];
    const next = steps.find((s) => s.status === 'pending');
    return next ? [next.id] : [];
  }

  if (topology === 'star') {
    return steps.filter((s) => s.status === 'pending').map((s) => s.id);
  }

  // hierarchical + mesh: dependency-gated parallelism.
  return steps
    .filter((s) => s.status === 'pending' && s.dependsOn.every((d) => doneIds.has(d)))
    .map((s) => s.id);
}

/**
 * Advance the run by one tick and return a NEW run (immutable). Two-phase per
 * tick so the UI shows a running → done transition:
 *   1. complete every currently-running step
 *   2. start the next startable batch (per topology)
 * Returns the same reference-shape run unchanged only when nothing can advance
 * (i.e. the run is complete).
 */
export function advanceRun(run: SwarmRun): SwarmRun {
  const progress = runProgress(run.steps);
  if (progress.complete) return run;

  // Phase 1: complete running steps.
  let steps = run.steps.map((s) => (s.status === 'running' ? { ...s, status: 'done' as StepStatus } : s));

  // Phase 2: start the next batch against the post-completion state.
  const toStart = new Set(startableStepIds({ topology: run.topology, steps }));
  steps = steps.map((s) => (toStart.has(s.id) ? { ...s, status: 'running' as StepStatus } : s));

  return { topology: run.topology, steps };
}

export interface LaneView {
  lane: Lane;
  steps: SwarmStep[];
}

/** Group a run's steps by lane, in canonical lane order, dropping empty lanes. */
export function groupByLane(steps: SwarmStep[]): LaneView[] {
  return LANES.map((lane) => ({
    lane,
    steps: steps.filter((s) => s.lane === lane.id),
  })).filter((lv) => lv.steps.length > 0);
}
