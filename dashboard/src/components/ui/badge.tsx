// THE badge system — single source of truth for every status/priority/model
// color in the dashboard. No page-level color maps allowed.

const BASE = 'inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border whitespace-nowrap';

export function Badge({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <span className={`${BASE} ${className || 'bg-zinc-700/40 text-zinc-300 border-zinc-600/50'}`}>{children}</span>;
}

/* ── Task priority ─────────────────────────────────────────── */

const PRIORITY: Record<string, string> = {
  P0: 'bg-red-500/15 text-red-400 border-red-500/30',
  P1: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  P2: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  P3: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
};

export function PriorityBadge({ priority }: { priority: string }) {
  return <Badge className={PRIORITY[priority]}>{priority}</Badge>;
}

/* ── Task status ───────────────────────────────────────────── */

const TASK_STATUS: Record<string, string> = {
  pending: 'bg-zinc-700/40 text-zinc-300 border-zinc-600/50',
  working: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  review: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  done: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  blocked: 'bg-red-500/15 text-red-400 border-red-500/30',
  paused: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  dead_letter: 'bg-red-500/25 text-red-300 border-red-500/50',
};

export function TaskStatusBadge({ status }: { status: string }) {
  return <Badge className={TASK_STATUS[status]}>{status}</Badge>;
}

/* ── Model ─────────────────────────────────────────────────── */

const MODEL: Record<string, string> = {
  'claude-fable-5': 'bg-purple-500/15 text-purple-300 border-purple-500/40',
  'claude-opus-4-8': 'bg-blue-500/15 text-blue-300 border-blue-500/40',
  'claude-sonnet-4-6': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
  'claude-haiku-4-5': 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  'deepseek-chat': 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30',
};

export function ModelBadge({ model }: { model: string }) {
  return <Badge className={MODEL[model]}>{model}</Badge>;
}

/* ── Schedule last-run status (never | success | error) ───── */

export function RunStatusBadge({ status }: { status?: string }) {
  const s = (status ?? 'never').toLowerCase();
  const cls =
    s === 'success' ? 'text-emerald-400' :
    s === 'error' || s === 'failed' ? 'text-red-400' :
    'text-zinc-500';
  return <span className={`text-xs ${cls}`}>{s}</span>;
}

/* ── 10-day plan status ────────────────────────────────────── */

const PLAN_STATUS: Record<string, string> = {
  enabled: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  done: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  disabled: 'bg-zinc-600/20 text-zinc-400 border-zinc-600/30',
  blocked: 'bg-red-500/15 text-red-400 border-red-500/30',
};

export function PlanStatusBadge({ status }: { status: string }) {
  return <Badge className={PLAN_STATUS[status] ?? PLAN_STATUS.disabled}>{status}</Badge>;
}

/* ── Repo / app health level dot (ok | warn | error | unknown) ── */

const LEVEL_DOT: Record<string, string> = {
  ok: 'bg-emerald-400',
  healthy: 'bg-emerald-400',
  warn: 'bg-amber-400',
  warning: 'bg-amber-400',
  error: 'bg-red-400',
  critical: 'bg-red-400',
  unknown: 'bg-zinc-600',
};

export function LevelDot({ level, className = '' }: { level?: string; className?: string }) {
  return <span className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${LEVEL_DOT[level ?? 'unknown'] ?? LEVEL_DOT.unknown} ${className}`} title={level} />;
}

export function HealthBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    healthy: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    warning: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
    critical: 'bg-red-500/15 text-red-400 border-red-500/30',
  };
  return <Badge className={styles[status] ?? styles.healthy}>{status}</Badge>;
}

/* ── Provider circuit breaker state ────────────────────────── */

export function CircuitBadge({ state }: { state: string }) {
  const styles: Record<string, string> = {
    closed: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
    open: 'bg-red-500/15 text-red-400 border-red-500/30',
    'half-open': 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  };
  return <Badge className={styles[state] ?? styles.closed}>{state}</Badge>;
}

/* ── RAG corpus source ─────────────────────────────────────── */

const SOURCE: Record<string, string> = {
  state: 'bg-blue-500/15 text-blue-400 border-blue-500/30',
  handoff: 'bg-purple-500/15 text-purple-400 border-purple-500/30',
  archive: 'bg-zinc-600/25 text-zinc-400 border-zinc-600/40',
  commit: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  pr: 'bg-cyan-500/15 text-cyan-400 border-cyan-500/30',
  pattern: 'bg-yellow-500/15 text-yellow-400 border-yellow-500/30',
  bug: 'bg-red-500/15 text-red-400 border-red-500/30',
  code: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  feature: 'bg-pink-500/15 text-pink-400 border-pink-500/30',
};

export function SourceBadge({ source }: { source: string }) {
  return <Badge className={SOURCE[source]}>{source}</Badge>;
}

/* ── Enabled/on-off dot ────────────────────────────────────── */

export function OnDot({ on }: { on: boolean }) {
  return <span className={`inline-block w-2 h-2 rounded-full ${on ? 'bg-emerald-400' : 'bg-zinc-600'}`} />;
}
