/**
 * recall-telemetry.ts — live recall hit-rate telemetry (BRAIN W3.3).
 *
 * plan/BRAIN_BUILD_PLAN.md B-7 calls for logging `{query, candidates, chosen
 * atom, used?}` and an OFFLINE-REPLAY evaluation over that log — explicitly
 * NOT full RL over agent behavior (§6 sequencing guidance: "do not start with
 * full RL ... start with offline replay"). W3.2 already covers the SYNTHETIC
 * benchmark half (a hand-labelled query→session gold set scored by
 * `eval:recall`/`eval:brain-search`, src/eval/*). This module covers the
 * LIVE half: did the atoms actually surfaced to a real agent, at a real
 * boot/search call, get referenced again during that session — i.e. was the
 * recall a hit, not synthetically but in practice.
 *
 * Recording (`recordRecallEvent`) is a plain fire-and-forget append, same
 * best-effort posture as `recordDeltaDegrade` in brain-health.ts — a
 * telemetry failure must never break the recall call it decorates. `used` is
 * NOT known at record time (no caller-side signal exists for "the agent
 * later referenced this"); it starts `null` and is resolved after the fact
 * by `replayRecallUsage`, the offline-replay step: it walks the log and
 * marks a candidate/chosen atom "used" when the SAME ref (repo-scoped)
 * resurfaces in a LATER recall event within a bounded lookahead window — a
 * real agent re-pulling the same atom (via a follow-up brain_search,
 * context_boot deeper query, etc.) is the closest thing this log can observe
 * to "the atom stayed relevant and got referenced again". Events with no
 * reappearance once the lookahead window has fully elapsed resolve to
 * `used: false`; events too fresh for the window to have elapsed stay `null`
 * (unresolved, not "not used") so the hit-rate never counts them prematurely.
 *
 * This is deliberately the "simple rate" B-7's sequencing guidance asks for —
 * no LoRA router, no bandit, no reward function. `computeLiveRecallHitRate`
 * is just `used / resolved` over the log, fed into brain-health.ts as one
 * more optional signal.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { myaiHome } from './brain.js';

/** The recall surfaces this module instruments. */
export type RecallTool = 'context_boot' | 'brain_search' | 'brain_delta';

export interface RecallEventInput {
  tool: RecallTool;
  /** Repo namespace the recall was scoped to, when known. */
  repo?: string;
  query?: string;
  /** Refs (atom path / sessionId / snippet-derived id) surfaced to the caller. */
  candidates: string[];
  /** The subset actually returned/highlighted as the best match(es) — a
   *  ranking already applied `candidates` down to this narrower set. */
  chosen: string[];
}

export interface RecallEvent extends RecallEventInput {
  id: string;
  /** ISO timestamp. */
  at: string;
  /** null = not yet resolved by replay; true/false = resolved outcome. */
  used: boolean | null;
}

const RECALL_EVENTS_MAX_ENTRIES = 1000;
/** Give the session time to keep working before judging "not used" — a
 *  candidate younger than this is simply too fresh to have been followed up
 *  on yet, not evidence of non-use. */
const DEFAULT_GRACE_MS = 5 * 60 * 1000;
/** Window within which a later recall re-surfacing the same ref counts as
 *  "referenced again". Past this with no reappearance, resolve to unused. */
const DEFAULT_LOOKAHEAD_MS = 4 * 60 * 60 * 1000;

export function recallEventsLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(myaiHome(env), 'brain-recall-events.jsonl');
}

function readEventsRaw(env: NodeJS.ProcessEnv): RecallEvent[] {
  const path = recallEventsLogPath(env);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RecallEvent);
}

function writeEventsRaw(events: RecallEvent[], env: NodeJS.ProcessEnv): void {
  const path = recallEventsLogPath(env);
  const bounded = events.slice(-RECALL_EVENTS_MAX_ENTRIES);
  writeFileSync(path, bounded.length ? `${bounded.map((e) => JSON.stringify(e)).join('\n')}\n` : '', 'utf8');
}

function makeId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Append one recall event (candidates/chosen surfaced by a real call, `used`
 *  starts unresolved). Best-effort — never throws; a metering failure must
 *  never break the recall call it decorates. Returns the event's id (for
 *  tests/debugging) or null when recording failed. */
export function recordRecallEvent(input: RecallEventInput, env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (input.candidates.length === 0) return null; // nothing surfaced — nothing to score
    const home = myaiHome(env);
    mkdirSync(home, { recursive: true });
    const event: RecallEvent = { ...input, id: makeId(), at: new Date().toISOString(), used: null };
    appendFileSync(recallEventsLogPath(env), `${JSON.stringify(event)}\n`, 'utf8');
    // Bound the file the same way recordDeltaDegrade does — read-modify-write
    // only when it might actually be over the cap, to keep the common case a
    // cheap single append.
    const all = readEventsRaw(env);
    if (all.length > RECALL_EVENTS_MAX_ENTRIES) writeEventsRaw(all, env);
    return event.id;
  } catch {
    return null;
  }
}

export function readRecallEvents(env: NodeJS.ProcessEnv = process.env): RecallEvent[] {
  try {
    return readEventsRaw(env);
  } catch {
    return [];
  }
}

export interface ReplayOptions {
  now?: Date;
  graceMs?: number;
  lookaheadMs?: number;
}

export interface ReplayResult {
  /** Events resolved (true or false) by THIS replay pass. */
  resolvedNow: number;
  /** Events still unresolved (too fresh for the grace/lookahead window). */
  stillPending: number;
  total: number;
}

/**
 * Offline-replay step (B-7): resolve `used: null` events by checking whether
 * their chosen (or, absent a narrower chosen set, candidate) refs resurface
 * in a LATER event for the same repo within `lookaheadMs`. Mutates the
 * telemetry log in place (this file only — never the brain git repo).
 * Best-effort: any failure leaves the log untouched and returns zeros.
 */
export function replayRecallUsage(env: NodeJS.ProcessEnv = process.env, opts: ReplayOptions = {}): ReplayResult {
  try {
    const nowMs = (opts.now ?? new Date()).getTime();
    const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
    const lookaheadMs = opts.lookaheadMs ?? DEFAULT_LOOKAHEAD_MS;
    const events = readEventsRaw(env);
    if (events.length === 0) return { resolvedNow: 0, stillPending: 0, total: 0 };

    let resolvedNow = 0;
    let stillPending = 0;
    let changed = false;

    events.forEach((event, i) => {
      if (event.used !== null) return;
      const atMs = new Date(event.at).getTime();
      const ageMs = nowMs - atMs;
      if (ageMs < graceMs) { stillPending++; return; }

      const refs = new Set(event.chosen.length > 0 ? event.chosen : event.candidates);
      const reappeared = events.some((later, j) => {
        if (j === i) return false;
        if (event.repo && later.repo && later.repo !== event.repo) return false;
        const laterMs = new Date(later.at).getTime();
        if (laterMs <= atMs || laterMs - atMs > lookaheadMs) return false;
        return later.candidates.some((r) => refs.has(r)) || later.chosen.some((r) => refs.has(r));
      });

      if (reappeared) {
        event.used = true;
        resolvedNow++;
        changed = true;
      } else if (ageMs >= lookaheadMs) {
        event.used = false;
        resolvedNow++;
        changed = true;
      } else {
        stillPending++;
      }
    });

    if (changed) writeEventsRaw(events, env);
    return { resolvedNow, stillPending, total: events.length };
  } catch {
    return { resolvedNow: 0, stillPending: 0, total: 0 };
  }
}

export interface LiveRecallHitRate {
  /** used / resolved, in [0,1]; null when no event has resolved yet. */
  hitRate: number | null;
  /** Events with a resolved (non-null) `used` outcome. */
  resolved: number;
  /** Total logged events (resolved + pending). */
  total: number;
}

/** Replay, then compute the simple `used / resolved` rate — the "simple rate
 *  only, not RL" B-7's sequencing guidance calls for. Best-effort throughout;
 *  never throws. */
export function computeLiveRecallHitRate(
  env: NodeJS.ProcessEnv = process.env,
  opts: ReplayOptions = {},
): LiveRecallHitRate {
  replayRecallUsage(env, opts);
  const events = readRecallEvents(env);
  const resolved = events.filter((e) => e.used !== null);
  if (resolved.length === 0) return { hitRate: null, resolved: 0, total: events.length };
  const used = resolved.filter((e) => e.used === true).length;
  return { hitRate: used / resolved.length, resolved: resolved.length, total: events.length };
}
