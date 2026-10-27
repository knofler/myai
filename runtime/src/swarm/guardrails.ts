/**
 * Swarm guardrails (SWARM_MESSAGING plan, P5 — §3 "Guardrails (non-negotiable)").
 *
 * Pure, dependency-free enforcement helpers for the four guardrails the plan
 * calls non-negotiable. They operate on plain data shapes so they can be unit
 * tested with zero DB / gateway setup, and so P2 (swarm task model: `swarm_plan`
 * / approve / stop) and P3 (dashboard) wire them in without importing any engine:
 *
 *   1. Consent      — `config/schedule_ignore.txt` repos are REFUSED, exactly as
 *                     `scripts/schedule_task.sh` does; `SWARM_CONSENT=1` overrides
 *                     a single consented call (mirrors that script's SCHEDULE_CONSENT).
 *   2. Child cap    — per-swarm cap on children (default 5, §3 + open-Q1). Note this
 *                     is a *count* cap; wall-clock parallelism is separately bounded
 *                     by runner-lease slots (ADR-011 = 2), see §6.1 architect note.
 *   3. Token budget — a swarm that exceeds its token budget PAUSES itself and MAILS
 *                     the operator (§3 slow-burn policy). This module produces the
 *                     mail payload; the caller (P2) persists via sendMail().
 *   4. Kill switch  — `swarm stop <id>` flips every OPEN child to `paused` and mails
 *                     every participant. This module computes the stop plan.
 *
 * Nothing here touches Mongo or the network; the returned mail payloads are
 * structurally compatible with `SendMailInput` (notifications/mailbox-store.ts)
 * so the caller passes them straight to `sendMail`.
 */

/** §3/Q1 defaults. A swarm's child count is capped; its token spend is budgeted. */
export const SWARM_DEFAULTS = {
  /** Default cap on children per swarm (§3, open-question Q1). */
  childCap: 5,
  /**
   * Default per-swarm token budget (output tokens). Derived from the plan's own
   * sizing: ~40k per runner task × the 5-child cap ≈ 200k. Over this, the swarm
   * pauses + mails the operator rather than burning on.
   */
  tokenBudget: 200_000,
} as const;

const MIN_CHILD_CAP = 1;
const MAX_CHILD_CAP = 50; // hard ceiling so a bad env value can't uncap a swarm
const MIN_TOKEN_BUDGET = 1_000;

export interface SwarmBudgetConfig {
  childCap: number;
  tokenBudget: number;
}

/**
 * Resolve the per-swarm budget from env, falling back to {@link SWARM_DEFAULTS}.
 * `SWARM_CHILD_CAP` and `SWARM_TOKEN_BUDGET`. Invalid / out-of-range values fall
 * back to the default rather than uncapping — a guardrail must fail safe.
 */
export function resolveSwarmBudget(env: Record<string, string | undefined> = process.env): SwarmBudgetConfig {
  return {
    childCap: clampInt(env.SWARM_CHILD_CAP, SWARM_DEFAULTS.childCap, MIN_CHILD_CAP, MAX_CHILD_CAP),
    tokenBudget: clampInt(env.SWARM_TOKEN_BUDGET, SWARM_DEFAULTS.tokenBudget, MIN_TOKEN_BUDGET, Number.MAX_SAFE_INTEGER),
  };
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) return fallback;
  return Math.min(Math.floor(n), max);
}

// ── 1. Consent — schedule_ignore.txt enforcement ────────────────────────────

/**
 * Parse `config/schedule_ignore.txt` into a set of repo names. Mirrors the shell
 * filter in `schedule_task.sh` (`grep -vE '^[[:space:]]*#|^[[:space:]]*$'`):
 * strip blank lines and `#` comment lines, trim each entry. Matching is exact on
 * the task-store repo name (git basename), same as the script's `grep -qxF`.
 */
export function parseIgnoreList(fileContents: string): string[] {
  if (typeof fileContents !== 'string') return [];
  return fileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

export interface ConsentResult {
  allowed: boolean;
  /** Present only when refused, ready to surface to the operator. */
  reason?: string;
}

/**
 * Refuse a swarm for a repo on the no-autonomous-schedule list, exactly as
 * `schedule_task.sh` refuses to queue one — unless the caller passes explicit
 * consent (`SWARM_CONSENT=1`, the swarm analogue of `SCHEDULE_CONSENT=1`).
 */
export function checkSwarmConsent(
  repo: string,
  ignoreList: readonly string[],
  opts: { consent?: boolean } = {},
): ConsentResult {
  const name = typeof repo === 'string' ? repo.trim() : '';
  if (!name) return { allowed: false, reason: 'repo is required' };
  if (opts.consent) return { allowed: true };
  if (ignoreList.includes(name)) {
    return {
      allowed: false,
      reason:
        `'${name}' is on the no-autonomous-schedule list (config/schedule_ignore.txt). ` +
        'This app does NOT get swarm work without your clear consent (set SWARM_CONSENT=1 to override a single call).',
    };
  }
  return { allowed: true };
}

// ── 2. Child cap ─────────────────────────────────────────────────────────────

export interface ChildCapResult {
  allowed: boolean;
  current: number;
  cap: number;
  reason?: string;
}

/**
 * Whether ONE more child may be added to a swarm that already has `currentChildCount`.
 * At the cap, adding is refused (the count cap is inclusive: cap=5 allows exactly 5).
 */
export function checkChildCap(currentChildCount: number, cap: number = SWARM_DEFAULTS.childCap): ChildCapResult {
  const current = Number.isFinite(currentChildCount) && currentChildCount > 0 ? Math.floor(currentChildCount) : 0;
  const limit = Number.isFinite(cap) && cap > 0 ? Math.floor(cap) : SWARM_DEFAULTS.childCap;
  if (current >= limit) {
    return {
      allowed: false,
      current,
      cap: limit,
      reason: `swarm child cap reached (${current}/${limit}) — raise SWARM_CHILD_CAP or start a second swarm`,
    };
  }
  return { allowed: true, current, cap: limit };
}

// ── 3. Token budget ──────────────────────────────────────────────────────────

/** A mail payload structurally compatible with SendMailInput (mailbox-store.ts). */
export interface SwarmMail {
  to: string;
  from: string;
  kind: string;
  subject: string;
  body: string;
  swarmId: string;
}

export interface BudgetVerdict {
  overBudget: boolean;
  spent: number;
  budget: number;
  remaining: number;
  /** spent / budget, 0..1+ (can exceed 1 when over). */
  utilization: number;
  action: 'continue' | 'pause_and_notify';
  /** Present only when action === 'pause_and_notify'. */
  mail?: SwarmMail;
}

/**
 * Decide whether a swarm may keep spending. When `spentTokens` meets or exceeds
 * the budget the swarm must PAUSE ITSELF and MAIL the operator (§3 slow-burn
 * policy) — the returned `mail` is ready to hand to sendMail(). Under budget it
 * is `continue` with no mail.
 */
export function checkTokenBudget(
  spentTokens: number,
  budget: number,
  ctx: { swarmId: string; operator?: string; from?: string },
): BudgetVerdict {
  const spent = Number.isFinite(spentTokens) && spentTokens > 0 ? Math.floor(spentTokens) : 0;
  const limit = Number.isFinite(budget) && budget > 0 ? Math.floor(budget) : SWARM_DEFAULTS.tokenBudget;
  const remaining = limit - spent;
  const utilization = spent / limit;
  const overBudget = spent >= limit;

  if (!overBudget) {
    return { overBudget: false, spent, budget: limit, remaining, utilization, action: 'continue' };
  }

  const to = (ctx.operator && ctx.operator.trim()) || 'operator';
  const from = (ctx.from && ctx.from.trim()) || 'swarm-guard';
  return {
    overBudget: true,
    spent,
    budget: limit,
    remaining,
    utilization,
    action: 'pause_and_notify',
    mail: {
      to,
      from,
      kind: 'swarm-budget',
      subject: `Swarm ${ctx.swarmId} paused — token budget reached (${spent}/${limit})`,
      body:
        `Swarm ${ctx.swarmId} spent ${spent} of its ${limit}-token budget and has PAUSED itself ` +
        `per the slow-burn guardrail. Review on /swarm and raise SWARM_TOKEN_BUDGET or approve a continuation to resume.`,
      swarmId: ctx.swarmId,
    },
  };
}

// ── 4. Kill switch — `swarm stop <id>` ───────────────────────────────────────

/** Statuses considered terminal (already closed; the kill switch leaves them alone). */
const TERMINAL_STATUSES = new Set(['done', 'completed', 'complete', 'failed', 'cancelled', 'canceled']);

export interface SwarmChildLike {
  taskId: string;
  status: string;
  /** Best-effort address of who's working it, for the participant mail set. */
  assignedTo?: string;
  assignedAgent?: string;
  host?: string;
}

export interface StopPlan {
  /** taskIds of OPEN children to flip → paused. */
  toPause: string[];
  /** Distinct addresses to mail (every participant), de-duped. */
  participants: string[];
  /** taskIds already terminal — left untouched. */
  alreadyClosed: string[];
}

/**
 * Compute the effect of `swarm stop <id>`: every OPEN (non-terminal) child is
 * flipped to `paused`, and every participant is mailed. Terminal children are
 * left as-is. Pure — the caller applies the status flips and sends the mail.
 */
export function planSwarmStop(children: readonly SwarmChildLike[]): StopPlan {
  const toPause: string[] = [];
  const alreadyClosed: string[] = [];
  const participants = new Set<string>();

  for (const child of children ?? []) {
    if (!child || typeof child.taskId !== 'string' || !child.taskId.trim()) continue;
    const status = typeof child.status === 'string' ? child.status.trim().toLowerCase() : '';
    // Anyone who touched the swarm should hear it stopped, closed or not.
    const addr = participantAddress(child);
    if (addr) participants.add(addr);
    if (TERMINAL_STATUSES.has(status)) {
      alreadyClosed.push(child.taskId);
    } else {
      toPause.push(child.taskId);
    }
  }

  return { toPause, participants: [...participants], alreadyClosed };
}

/** Prefer host/repo-style addressing, else the agent role, else host. */
function participantAddress(child: SwarmChildLike): string {
  const pick = (v: unknown): string => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  return pick(child.assignedTo) || pick(child.assignedAgent) || pick(child.host);
}
