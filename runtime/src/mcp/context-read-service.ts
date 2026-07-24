/**
 * betaC context READ-PATH service seam (ADR-016 phase 1).
 *
 * ADR-016 moves all agent context off the per-repo `AI/` folder onto the
 * central betaC service (gateway + brain store + Mongo/embedded DB). This
 * module is the reversible seam for that swap: every READ the auto-boot /
 * `context_boot` path makes — repo prioritisation, handoff, plan, vector
 * search, the compiled brain brief, and identity — flows through the
 * `ContextReadService` interface instead of importing the stores directly.
 *
 * v1 ships `defaultContextReadService`, which delegates to today's LOCAL stores
 * (repo-registry, handoff-store, plan-store, vector-store, the brain distiller)
 * — so behaviour is BYTE-IDENTICAL to the pre-seam code. The central-service
 * swap (a later ADR-016 phase, §3 M2) becomes a single
 * `setContextReadService(centralImpl)` injection; nothing in context-bundle.ts
 * changes and rollback is the same one-liner (`resetContextReadService()`).
 * No behaviour change lands in this phase — only the seam.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { getConfig } from '../shared/config.js';
import { createChildLogger } from '../shared/logger.js';
import { prioritizeRepos, type RepoPriorityEntry } from '../repos/repo-registry.js';
import { readHandoff, type ReadHandoffResult } from '../repos/handoff-store.js';
import { listPlan, type PlanDayView } from '../repos/plan-store.js';
import { searchVectors, type VectorSearchResult } from '../memory/vector-store.js';
import { brainEnvFor, brainMainSha, readCompiledBrief } from '../core/distill.js';
import { brainSyncPull } from '../core/brain.js';
import { tighten } from './context-text.js';

const log = createChildLogger({ module: 'context-read-service' });

// Re-export the store record shapes so callers depend on the seam, not the
// individual stores — the seam is the stable contract the central service must
// honour when it takes over.
export type { RepoPriorityEntry, ReadHandoffResult, PlanDayView, VectorSearchResult };

/** Args for a lazy, capped semantic search (the subset the read path needs). */
export interface VectorSearchArgs {
  query: string;
  repo?: string;
  limit?: number;
}

/** The compiled brain boot brief plus the brain main HEAD it came from. */
export interface BrainBriefRead {
  /** RAW compiled brief (untightened — the caller applies its own char budget). */
  brief: string;
  /** Brain main HEAD — the next-boot `brain_delta` anchor. */
  sha?: string;
}

/**
 * The read-path seam. Every method is a pure READ that the central betaC
 * service will eventually serve; the default implementation reads today's local
 * stores. Store-backed reads (prioritise/handoff/plan/search) may throw — their
 * callers in context-bundle.ts already degrade. Best-effort reads (brain brief,
 * identity) never throw; they return `undefined` / a default instead.
 */
export interface ContextReadService {
  prioritizeRepos(tenantId: string): Promise<RepoPriorityEntry[]>;
  readHandoff(tenantId: string, repo: string): Promise<ReadHandoffResult>;
  listPlan(tenantId: string, repo: string): Promise<PlanDayView[]>;
  searchVectors(tenantId: string, args: VectorSearchArgs): Promise<VectorSearchResult[]>;
  /**
   * Read the compiled brain brief for a repo off brain MAIN (plain files, no
   * server round-trip). Best-effort: returns `undefined` when there is no
   * brain, no namespace, or the brief has not been compiled yet — the caller
   * then falls back to the handoff store (pre-brain behaviour, byte-identical).
   */
  readBrainBrief(tenantId: string, repo: string): BrainBriefRead | undefined;
  /**
   * Resolve the operator identity line, already whitespace-tightened + capped.
   * Precedence: BETAC_IDENTITY env → <aiRoot>/state/identity.md → framework
   * default. Never throws.
   */
  resolveIdentity(): string;
}

/** Identity line hard cap — identity is a line, not a profile dump. */
const IDENTITY_MAX_CHARS = 320;

/**
 * Default read-path service: delegates to today's local stores + brain
 * distiller. This is a straight lift of the reads that used to live inline in
 * context-bundle.ts — behaviour is byte-identical.
 */
export const defaultContextReadService: ContextReadService = {
  prioritizeRepos(tenantId: string): Promise<RepoPriorityEntry[]> {
    return prioritizeRepos(tenantId);
  },

  readHandoff(tenantId: string, repo: string): Promise<ReadHandoffResult> {
    return readHandoff(tenantId, repo);
  },

  listPlan(tenantId: string, repo: string): Promise<PlanDayView[]> {
    return listPlan(tenantId, repo);
  },

  searchVectors(tenantId: string, args: VectorSearchArgs): Promise<VectorSearchResult[]> {
    return searchVectors(tenantId, args);
  },

  readBrainBrief(tenantId: string, repo: string): BrainBriefRead | undefined {
    try {
      const env = brainEnvFor(tenantId);
      // Pull-on-boot: bounded fast-fail fetch + ff-pull of brain main before
      // reading, so a boot on this machine serves what another machine merged.
      // Non-fatal — offline reads local main (BRAIN_OFFLINE.md).
      brainSyncPull(env);
      const brief = readCompiledBrief(repo, env);
      if (!brief) return undefined;
      return { brief, sha: brainMainSha(env) };
    } catch (err) {
      log.debug({ err, repo }, 'brain brief read failed — falling back to handoff store');
      return undefined;
    }
  },

  resolveIdentity(): string {
    const fromEnv = (process.env.BETAC_IDENTITY ?? '').trim();
    if (fromEnv) return tighten(fromEnv, IDENTITY_MAX_CHARS);

    try {
      const path = resolve(getConfig().aiRoot, 'state', 'identity.md');
      if (existsSync(path)) {
        const line = readFileSync(path, 'utf-8')
          .split('\n')
          .map(l => l.trim())
          .find(l => l && !l.startsWith('#') && !l.startsWith('>'));
        if (line) return tighten(line, IDENTITY_MAX_CHARS);
      }
    } catch (err) {
      log.debug({ err }, 'identity.md read failed — using default');
    }

    return 'myAI user — portable, self-owned AI context layer (betaC). This agent is plugged into the user\'s context, not a blank session.';
  },
};

// ── Injectable current service (the ADR-016 swap point) ──────────────────────
//
// context-bundle.ts reads through `getContextReadService()`. Swapping to the
// central betaC service is `setContextReadService(centralImpl)`; rolling back
// is `resetContextReadService()`. This is the whole reversibility guarantee for
// the read path — no other file needs to change when the source of truth flips.

let current: ContextReadService = defaultContextReadService;

/** The read-path service the context bundle currently reads through. */
export function getContextReadService(): ContextReadService {
  return current;
}

/** Swap the read-path service (e.g. to the central betaC service). */
export function setContextReadService(service: ContextReadService): void {
  current = service;
}

/** Restore the default (local-store) read-path service — the rollback path. */
export function resetContextReadService(): void {
  current = defaultContextReadService;
}
