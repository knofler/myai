// Idle-session timeout — pure logic (no DOM), mirrors the theme.ts split: the
// React glue that talks to `window`/timers/activity events lives in
// `idle-timeout-guard.tsx`. Motivation: the dashboard now carries paid billing
// + multi-tenant data (Team/Pro tiers), so a browser left open and signed in
// on a shared machine should not stay authenticated indefinitely.
//
// `0` means "never" (disabled) — an explicit opt-out, not just a large number,
// so storage/UI code can check `!minutes` without a magic sentinel.

export const IDLE_TIMEOUT_OPTIONS = [15, 30, 60, 120, 0] as const;
export type IdleTimeoutMinutes = (typeof IDLE_TIMEOUT_OPTIONS)[number];

export const DEFAULT_IDLE_TIMEOUT_MINUTES: IdleTimeoutMinutes = 30;

// How long before expiry the warning modal appears, and how often the caller
// should re-check state. Fixed, not user-configurable (only the overall
// timeout is).
export const WARNING_LEAD_SECONDS = 60;

const STORAGE_PREFIX = 'myai.idle-timeout.v1';

// Custom DOM event dispatched whenever the stored preference changes, so a
// mounted guard picks up a change made elsewhere (e.g. the settings control
// on /sessions) without a page reload.
export const IDLE_TIMEOUT_CHANGED_EVENT = 'myai:idle-timeout-changed';

export function idleTimeoutStorageKey(scope?: string | null): string {
  return `${STORAGE_PREFIX}.${scope || 'default'}`;
}

export function isIdleTimeoutMinutes(value: unknown): value is IdleTimeoutMinutes {
  return typeof value === 'number' && (IDLE_TIMEOUT_OPTIONS as readonly number[]).includes(value);
}

export function readStoredIdleTimeoutMinutes(
  storage: Pick<Storage, 'getItem'>,
  scope?: string | null,
): IdleTimeoutMinutes {
  try {
    const raw = storage.getItem(idleTimeoutStorageKey(scope));
    if (raw === null) return DEFAULT_IDLE_TIMEOUT_MINUTES;
    const parsed = Number(raw);
    return isIdleTimeoutMinutes(parsed) ? parsed : DEFAULT_IDLE_TIMEOUT_MINUTES;
  } catch {
    return DEFAULT_IDLE_TIMEOUT_MINUTES;
  }
}

export function writeStoredIdleTimeoutMinutes(
  storage: Pick<Storage, 'setItem'>,
  minutes: IdleTimeoutMinutes,
  scope?: string | null,
): void {
  try {
    storage.setItem(idleTimeoutStorageKey(scope), String(minutes));
  } catch {
    /* storage unavailable (private mode) — in-memory state still works */
  }
}

export type IdleState = 'active' | 'warning' | 'expired';

// `timeoutMinutes === 0` disables the feature entirely — always 'active'.
export function computeIdleState(
  nowMs: number,
  lastActivityMs: number,
  timeoutMinutes: IdleTimeoutMinutes,
  warningLeadSeconds: number = WARNING_LEAD_SECONDS,
): IdleState {
  if (!timeoutMinutes) return 'active';
  const timeoutMs = timeoutMinutes * 60_000;
  const elapsedMs = nowMs - lastActivityMs;
  if (elapsedMs >= timeoutMs) return 'expired';
  if (elapsedMs >= timeoutMs - warningLeadSeconds * 1000) return 'warning';
  return 'active';
}

// Whole seconds remaining until auto-logout — clamped at 0. Used to drive the
// warning modal's countdown; meaningless (and unused) once state is 'expired'.
export function secondsUntilExpiry(
  nowMs: number,
  lastActivityMs: number,
  timeoutMinutes: IdleTimeoutMinutes,
): number {
  if (!timeoutMinutes) return Infinity;
  const timeoutMs = timeoutMinutes * 60_000;
  const remainingMs = lastActivityMs + timeoutMs - nowMs;
  return Math.max(0, Math.ceil(remainingMs / 1000));
}
