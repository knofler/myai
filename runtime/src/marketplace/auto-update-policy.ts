/**
 * ADR-034 — pure decision logic for the installed-package auto-update
 * policy (ADR-028 checklist #5). No I/O: the auto-update sweep job
 * (`scheduler/marketplace-auto-update-sweep.ts`) is the only caller that
 * touches the store/artifact backend; this module is unit-testable on its
 * own, same "prove the rules before they touch infrastructure" posture as
 * `listing-lifecycle.ts`.
 *
 * ADR-034 §1: the semver-bump label gates which of two tracks a version
 * starts on — PATCH is auto-track-eligible, MINOR/MAJOR always require
 * explicit tenant approval, no exceptions.
 *
 * ADR-034 §2: the capability diff (reusing `review-queue.ts`'s
 * `diffDeclaredTools` — never a second hand-maintained copy) is the actual
 * gate for the auto-track, not the label. It can only ever DEMOTE a PATCH
 * out of the auto-track (a mislabeled widening escalates to manual, exactly
 * as if it had been labeled MINOR); it never promotes a MINOR/MAJOR into it.
 */
import type { DeclaredToolsDiff } from './review-queue.js';
import type { InstallUpdatePolicy } from './types.js';

export type SemverBump = 'major' | 'minor' | 'patch' | 'downgrade' | 'same';

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
}

/** Parses the `MAJOR.MINOR.PATCH` core, ignoring any `-prerelease`/`+build`
 *  suffix — bump classification only cares about the three numeric fields. */
function parseSemverCore(version: string): ParsedSemver {
  const core = version.split(/[-+]/, 1)[0];
  const parts = core.split('.');
  if (parts.length !== 3) {
    throw new Error(`invalid semver "${version}" — expected "MAJOR.MINOR.PATCH"`);
  }
  const [major, minor, patch] = parts.map(Number);
  if (![major, minor, patch].every((n) => Number.isInteger(n) && n >= 0)) {
    throw new Error(`invalid semver "${version}" — expected "MAJOR.MINOR.PATCH"`);
  }
  return { major, minor, patch };
}

/** Classifies `to` relative to `from` — the label ADR-034 §1 gates the track on. */
export function classifySemverBump(from: string, to: string): SemverBump {
  const a = parseSemverCore(from);
  const b = parseSemverCore(to);
  if (b.major !== a.major) return b.major > a.major ? 'major' : 'downgrade';
  if (b.minor !== a.minor) return b.minor > a.minor ? 'minor' : 'downgrade';
  if (b.patch !== a.patch) return b.patch > a.patch ? 'patch' : 'downgrade';
  return 'same';
}

/** `-1` if `a` < `b`, `1` if `a` > `b`, `0` if equal — for picking the highest
 *  eligible candidate among several published versions. */
export function compareSemver(a: string, b: string): number {
  const bump = classifySemverBump(a, b);
  if (bump === 'same') return 0;
  return bump === 'downgrade' ? 1 : -1;
}

export type UpdateAction =
  | { kind: 'apply' } // silently advance Install.version to the target
  | { kind: 'pending'; reason: string } // set Install.pendingVersion, wait for tenant approval
  | { kind: 'none'; reason: string }; // nothing to do — not a newer version

export interface DecideUpdateActionInput {
  updatePolicy: InstallUpdatePolicy;
  bump: SemverBump;
  /** declaredTools diff between the tenant's currently-installed version and
   *  the candidate target, computed the same way review time does. */
  declaredToolsDiff: DeclaredToolsDiff;
}

/**
 * ADR-034 §1/§2's decision table. `same`/`downgrade` are a no-op (the auto-
 * update job never applies a version that isn't strictly newer, on either
 * track — ADR-034 §4's downgrade guard). MAJOR/MINOR always escalate,
 * regardless of the diff. PATCH applies silently only when the install has
 * opted into `patch-auto` AND the diff confirms no capability widening —
 * otherwise it escalates exactly as if it had been labeled MINOR.
 */
export function decideUpdateAction(input: DecideUpdateActionInput): UpdateAction {
  const { updatePolicy, bump, declaredToolsDiff } = input;

  if (bump === 'same' || bump === 'downgrade') {
    return { kind: 'none', reason: `target is not newer than the installed version (${bump})` };
  }

  if (bump === 'major' || bump === 'minor') {
    return { kind: 'pending', reason: `${bump} bump always requires explicit tenant approval (ADR-034 §1)` };
  }

  // bump === 'patch'
  if (updatePolicy !== 'patch-auto') {
    return {
      kind: 'pending',
      reason: 'install is not opted into patch-auto — every update waits for approval (ADR-034 §3)',
    };
  }
  if (declaredToolsDiff.added.length > 0) {
    return {
      kind: 'pending',
      reason:
        `PATCH mislabels a capability widening (+${declaredToolsDiff.added.join(', +')}) — ` +
        `escalated to manual approval as if MINOR (ADR-034 §2)`,
    };
  }
  return { kind: 'apply' };
}
