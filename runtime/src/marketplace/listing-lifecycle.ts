/**
 * Marketplace lifecycle state machines — the pure model layer (ADR-019).
 *
 * No DB, no gateway, no I/O: just the legal-transition tables and the
 * validators that the eventual stores will call before writing. Keeping this
 * pure is what makes the "no live marketplace yet, tests for the model layer"
 * scope satisfiable — the rules are verifiable today.
 *
 * Design rule: transitions are DATA (a map), not `if`-ladders, so the ADR's
 * state diagrams and this code cannot drift. A transition absent from the map
 * is illegal by construction.
 */
import type { ListingStatus, VersionStatus, InstallStatus, ListingVersion } from './types.js';

// ── Listing lifecycle ─────────────────────────────────────

const LISTING_TRANSITIONS: Record<ListingStatus, readonly ListingStatus[]> = {
  draft: ['in_review'],
  in_review: ['approved', 'rejected'],
  rejected: ['draft'],            // edit + resubmit
  approved: ['published'],
  published: ['suspended', 'delisted'],
  suspended: ['published', 'delisted'],
  delisted: [],                   // terminal
};

/** A listing is discoverable in the catalog only when published. */
export function isListingDiscoverable(status: ListingStatus): boolean {
  return status === 'published';
}

// ── Version lifecycle ─────────────────────────────────────

const VERSION_TRANSITIONS: Record<VersionStatus, readonly VersionStatus[]> = {
  draft: ['in_review'],
  in_review: ['approved', 'draft'],   // reject → back to draft
  approved: ['published'],
  published: ['yanked'],
  yanked: [],                          // terminal for that version
};

// ── Install lifecycle ─────────────────────────────────────

const INSTALL_TRANSITIONS: Record<InstallStatus, readonly InstallStatus[]> = {
  active: ['disabled', 'uninstalled'],
  disabled: ['active', 'uninstalled'],
  uninstalled: [],                     // terminal
};

export interface TransitionResult {
  ok: boolean;
  reason?: string;
}

function checkTransition<S extends string>(
  table: Record<S, readonly S[]>,
  from: S,
  to: S,
  label: string,
): TransitionResult {
  const allowed = table[from];
  if (!allowed) return { ok: false, reason: `unknown ${label} status: ${from}` };
  if (from === to) return { ok: false, reason: `${label} already in status ${to}` };
  if (!allowed.includes(to)) {
    return { ok: false, reason: `illegal ${label} transition: ${from} → ${to}` };
  }
  return { ok: true };
}

export function canTransitionListing(from: ListingStatus, to: ListingStatus): TransitionResult {
  return checkTransition(LISTING_TRANSITIONS, from, to, 'listing');
}

export function canTransitionVersion(from: VersionStatus, to: VersionStatus): TransitionResult {
  return checkTransition(VERSION_TRANSITIONS, from, to, 'version');
}

export function canTransitionInstall(from: InstallStatus, to: InstallStatus): TransitionResult {
  return checkTransition(INSTALL_TRANSITIONS, from, to, 'install');
}

// ── Installability gate ───────────────────────────────────

export interface InstallEligibility {
  listingStatus: ListingStatus;
  versionStatus: VersionStatus;
}

/**
 * A NEW install is only allowed when the listing is published AND the target
 * version is published (not yanked). Suspended/delisted listings and yanked
 * versions block new installs; existing installs are governed by their own
 * lifecycle and are unaffected (grandfathering happens at the install row, not
 * here).
 */
export function canInstall({ listingStatus, versionStatus }: InstallEligibility): TransitionResult {
  if (listingStatus !== 'published') {
    return { ok: false, reason: `listing not installable in status ${listingStatus}` };
  }
  if (versionStatus !== 'published') {
    return { ok: false, reason: `version not installable in status ${versionStatus}` };
  }
  return { ok: true };
}

// ── Minimum-necessary capability review (ADR-027 §2) ──────

/**
 * Hand-curated, additive-only set of tools whose blast radius is
 * disproportionate to almost every marketplace listing's stated purpose —
 * destructive, cross-tenant, or platform-administrative. This is ADR-027
 * §2's own example made concrete ("a notes summarizer skill declaring
 * `tasks_delete` or `brain_commit` is a review-reject, not a runtime
 * problem to catch later"). Declaring one of these is not automatically
 * illegal — some listing categories legitimately need it — but it can never
 * pass review silently: it must be named in a reviewer's
 * `justifiedHighRiskTools` before `in_review → approved` succeeds. Widening
 * this set is a deliberate, reviewed registry change, mirroring ADR-018's
 * frozen-whitelist posture — never inferred from a manifest.
 */
export const HIGH_RISK_MARKETPLACE_TOOLS: ReadonlySet<string> = new Set([
  'tasks_delete',
  'plan_delete',
  'schedules_delete',
  'recurring_tasks_delete',
  'tenant_suspend',
  'tenant_reactivate',
  'brain_commit',
  'brain_merge',
  'brain_stash',
  'brain_revert',
]);

export interface MinimumNecessaryResult {
  ok: boolean;
  /** High-risk tools declared without a matching reviewer justification. */
  unjustifiedHighRisk: string[];
}

/**
 * ADR-027 §2's reviewer obligation: `declaredTools` must be the minimum set
 * the listing's stated purpose requires. Whether a given tool actually fits
 * that purpose is a human judgment call this function cannot make — what it
 * CAN do mechanically is refuse to let a high-risk tool through
 * un-acknowledged: the reviewer must have explicitly named it in
 * `justifiedHighRiskTools` (e.g. a justification field on the review-queue
 * UI) before the declaration counts as reviewed. Pure, no I/O.
 */
export function checkMinimumNecessaryCapabilities(
  declaredTools: readonly string[],
  justifiedHighRiskTools: readonly string[] = [],
): MinimumNecessaryResult {
  const justified = new Set(justifiedHighRiskTools);
  const unjustifiedHighRisk = declaredTools.filter(
    (t) => HIGH_RISK_MARKETPLACE_TOOLS.has(t) && !justified.has(t),
  );
  return { ok: unjustifiedHighRisk.length === 0, unjustifiedHighRisk };
}

/**
 * The full `in_review → approved` gate: the mechanical version-lifecycle
 * transition (unchanged, `canTransitionVersion`) AND ADR-027 §2's
 * minimum-necessary review criterion — both must pass. This is the one
 * place a store/tool should call before writing an `approved` row, so the
 * two checks can never drift apart (mirrors how `canInstall` composes two
 * gates into one call above).
 */
export function canApproveListingVersion(
  version: Pick<ListingVersion, 'status' | 'declaredTools'>,
  justifiedHighRiskTools: readonly string[] = [],
): TransitionResult {
  const transition = canTransitionVersion(version.status, 'approved');
  if (!transition.ok) return transition;

  const capCheck = checkMinimumNecessaryCapabilities(version.declaredTools, justifiedHighRiskTools);
  if (!capCheck.ok) {
    return {
      ok: false,
      reason:
        `declaredTools includes high-risk tool(s) without reviewer justification ` +
        `(ADR-027 §2 minimum-necessary): ${capCheck.unjustifiedHighRisk.join(', ')}`,
    };
  }
  return { ok: true };
}

/** Exposed for docs/tests — the canonical transition tables. */
export const TRANSITION_TABLES = {
  listing: LISTING_TRANSITIONS,
  version: VERSION_TRANSITIONS,
  install: INSTALL_TRANSITIONS,
} as const;
