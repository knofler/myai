/**
 * Notification preferences — per-tenant delivery controls.
 *
 * Governs how the notification service delivers events (REALTIME_NOTIFICATIONS
 * plan, Phase 7):
 *   - channel toggles: `inApp` (SSE toast/bell), `push` (web push), and
 *     `email` (SMTP digest — opt-in, default off),
 *   - per-event-family mutes keyed by the first dotted segment of the event
 *     type ("task.created" → "task"), with "other" as the catch-all family,
 *   - quiet hours ("HH:MM"–"HH:MM", server-local) during which the out-of-app
 *     channels (push + email) are suppressed — in-app delivery and history are
 *     unaffected.
 *
 * Muting an event family silences DELIVERY (SSE + push + email) only; every event is
 * still recorded to history so nothing is lost, just not surfaced live.
 *
 * `getPreferences` never throws (falls back to defaults) because it sits on the
 * event hot path; `updatePreferences` throws when the DB is down so the API
 * route can surface a real error.
 */
import { createChildLogger } from '../shared/logger.js';
import { isConnected } from '../shared/db.js';
import { tenantScope } from '../shared/scoped-query.js';

const log = createChildLogger({ module: 'notify-prefs' });

export interface NotificationPrefs {
  inApp: boolean;
  push: boolean;
  /** Email delivery of background events. Opt-in — off unless the tenant enables it. */
  email: boolean;
  /** Event-family toggles; a family absent from the map defaults to enabled. */
  events: Record<string, boolean>;
  /** Quiet window "HH:MM" (24h, server-local). Both set → window active. */
  quietStart?: string;
  quietEnd?: string;
}

/** Families surfaced in the settings UI. Unknown families fall back to `other`.
 *  `plan` (10-day mythos plan updates) and `runner` (CLI-runner lease fires) are
 *  first-class so a tenant can mute the fleet-lifecycle chatter independently of
 *  per-task events. */
export const EVENT_FAMILIES = ['task', 'plan', 'runner', 'dispatch', 'message', 'other'] as const;

export const DEFAULT_PREFS: NotificationPrefs = {
  inApp: true,
  push: true,
  email: false, // opt-in — per-event email is heavier than push, off by default
  events: { task: true, plan: true, runner: true, dispatch: true, message: true, other: true },
};

// ── Pure helpers (unit-tested) ──────────────────────────────

/** The preference family an event type belongs to ("task.created" → "task"). */
export function eventFamily(type: string): string {
  const head = type.split('.')[0]?.trim();
  if (!head) return 'other';
  return (EVENT_FAMILIES as readonly string[]).includes(head) ? head : 'other';
}

/** Whether the tenant wants this event type delivered at all. */
export function eventEnabled(prefs: NotificationPrefs, type: string): boolean {
  return prefs.events[eventFamily(type)] ?? true;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * True when `now` (server-local) falls inside the quiet window. Handles the
 * overnight wrap (22:00–07:00). Equal start/end, or either endpoint missing or
 * malformed, disables the window.
 */
export function isQuietHours(prefs: Pick<NotificationPrefs, 'quietStart' | 'quietEnd'>, now: Date = new Date()): boolean {
  const { quietStart, quietEnd } = prefs;
  if (!quietStart || !quietEnd || !HHMM.test(quietStart) || !HHMM.test(quietEnd)) return false;
  const start = toMinutes(quietStart);
  const end = toMinutes(quietEnd);
  if (start === end) return false;
  const cur = now.getHours() * 60 + now.getMinutes();
  return start < end ? cur >= start && cur < end : cur >= start || cur < end;
}

/**
 * Validate an untrusted preferences patch (API body) down to the fields we
 * store. Unknown keys are dropped; malformed quiet times are rejected with a
 * thrown Error so the route can 400.
 */
export function sanitizePrefsPatch(input: unknown): Partial<NotificationPrefs> {
  if (!input || typeof input !== 'object') throw new Error('preferences body must be an object');
  const raw = input as Record<string, unknown>;
  const patch: Partial<NotificationPrefs> = {};

  for (const key of ['inApp', 'push', 'email'] as const) {
    if (raw[key] !== undefined) {
      if (typeof raw[key] !== 'boolean') throw new Error(`${key} must be a boolean`);
      patch[key] = raw[key];
    }
  }

  if (raw.events !== undefined) {
    if (!raw.events || typeof raw.events !== 'object' || Array.isArray(raw.events)) {
      throw new Error('events must be an object of booleans');
    }
    const events: Record<string, boolean> = {};
    for (const [family, val] of Object.entries(raw.events as Record<string, unknown>)) {
      if (typeof val !== 'boolean') throw new Error(`events.${family} must be a boolean`);
      if (!(EVENT_FAMILIES as readonly string[]).includes(family)) continue; // drop unknown families
      events[family] = val;
    }
    patch.events = events;
  }

  for (const key of ['quietStart', 'quietEnd'] as const) {
    if (raw[key] !== undefined) {
      if (raw[key] === null || raw[key] === '') {
        patch[key] = undefined; // explicit clear
      } else if (typeof raw[key] === 'string' && HHMM.test(raw[key] as string)) {
        patch[key] = raw[key] as string;
      } else {
        throw new Error(`${key} must be "HH:MM" (24h) or empty to clear`);
      }
    }
  }

  return patch;
}

// ── DB-backed store (30s per-tenant cache — hot path) ───────

interface CacheEntry { prefs: NotificationPrefs; at: number }
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

/** Test-isolation helper. */
export function clearPrefsCache(): void {
  cache.clear();
}

function mergeWithDefaults(doc: Partial<NotificationPrefs> | null | undefined): NotificationPrefs {
  return {
    inApp: doc?.inApp ?? DEFAULT_PREFS.inApp,
    push: doc?.push ?? DEFAULT_PREFS.push,
    email: doc?.email ?? DEFAULT_PREFS.email,
    events: { ...DEFAULT_PREFS.events, ...(doc?.events ?? {}) },
    quietStart: doc?.quietStart,
    quietEnd: doc?.quietEnd,
  };
}

/**
 * Tenant preferences, merged over defaults. Never throws — DB down or missing
 * doc yields the defaults so the event path keeps flowing.
 */
export async function getPreferences(tenantId: string): Promise<NotificationPrefs> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.prefs;

  let prefs = mergeWithDefaults(null);
  if (isConnected()) {
    try {
      const { NotificationPrefsModel } = await import('../shared/db.js');
      if (NotificationPrefsModel) {
        const doc = await NotificationPrefsModel.findOne(tenantScope(tenantId)).lean<Partial<NotificationPrefs>>();
        prefs = mergeWithDefaults(doc);
      }
    } catch (err) {
      log.warn({ err, tenantId }, 'Failed to load notification preferences — using defaults');
    }
  }
  cache.set(tenantId, { prefs, at: Date.now() });
  return prefs;
}

/**
 * Upsert the tenant's preferences with a sanitized patch and return the merged
 * result. Throws when the DB is unavailable (callers surface a 503).
 */
export async function updatePreferences(tenantId: string, patch: Partial<NotificationPrefs>): Promise<NotificationPrefs> {
  if (!isConnected()) throw new Error('database unavailable');
  const { NotificationPrefsModel } = await import('../shared/db.js');
  if (!NotificationPrefsModel) throw new Error('database unavailable');

  const set: Record<string, unknown> = {};
  const unset: Record<string, 1> = {};
  for (const key of ['inApp', 'push', 'email', 'events'] as const) {
    if (patch[key] !== undefined) set[key] = patch[key];
  }
  for (const key of ['quietStart', 'quietEnd'] as const) {
    if (key in patch) {
      if (patch[key] === undefined) unset[key] = 1;
      else set[key] = patch[key];
    }
  }

  // No $setOnInsert for tenantId — the filter's equality supplies it on insert
  // (duplicating it would raise a Mongo path-conflict error).
  const update: Record<string, unknown> = {};
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(unset).length) update.$unset = unset;

  const doc = await NotificationPrefsModel.findOneAndUpdate(
    tenantScope(tenantId),
    update,
    { new: true, upsert: true },
  ).lean<Partial<NotificationPrefs>>();

  cache.delete(tenantId);
  return mergeWithDefaults(doc);
}
