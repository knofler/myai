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
import type { ListingStatus, VersionStatus, InstallStatus } from './types.js';

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

/** Exposed for docs/tests — the canonical transition tables. */
export const TRANSITION_TABLES = {
  listing: LISTING_TRANSITIONS,
  version: VERSION_TRANSITIONS,
  install: INSTALL_TRANSITIONS,
} as const;
