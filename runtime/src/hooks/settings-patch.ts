import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Hook enable/disable backed by .claude/settings.json (MYAI_DASHBOARD.md §3.2).
//
// Claude Code's hook schema has no `enabled` flag — the only way to disable a
// hook is to remove its command entry. To make that reversible (and safe to
// drive from the dashboard) a disabled entry is MOVED into a parallel
// top-level `disabledHooks` key that mirrors the `hooks` shape and records
// where the entry came from, so re-enabling restores it at its original
// position. Claude Code ignores the extra key. The patch is surgical: only
// `hooks` and `disabledHooks` are touched — every unrelated key in
// settings.json survives the round-trip untouched.

export interface SettingsHookEntry {
  type?: string;
  command?: string;
  timeout?: number;
  [key: string]: unknown;
}

interface SettingsHookGroup {
  matcher?: string;
  hooks?: SettingsHookEntry[];
  [key: string]: unknown;
}

/** One parked entry: the original group matcher + array positions for restore. */
interface DisabledHookRecord {
  matcher: string;
  groupIndex: number;
  hookIndex: number;
  entry: SettingsHookEntry;
}

export type SettingsDoc = Record<string, unknown> & {
  hooks?: Record<string, SettingsHookGroup[]>;
  disabledHooks?: Record<string, DisabledHookRecord[]>;
};

// Gateway hook names ↔ Claude Code settings.json event keys.
// Mirrors the loader's subdir layout: hooks/<subdir>/<script>.sh
const SUBDIR_TO_EVENT_KEY: Record<string, string> = {
  'session': 'SessionStart',
  'pre-tool': 'PreToolUse',
  'post-tool': 'PostToolUse',
  'stop': 'Stop',
};

/** Map a bash-hook subdir (session, pre-tool, …) to its settings.json key. */
export function settingsEventKey(subdir: string): string {
  return SUBDIR_TO_EVENT_KEY[subdir] ?? subdir;
}

/**
 * Parse a gateway bash-hook name (`bash:session/13-ram-guard.sh`) into its
 * subdir + script. Returns null for builtin/user hooks — those are not
 * settings.json-backed.
 */
export function parseBashHookName(name: string): { subdir: string; script: string } | null {
  const m = /^bash:([^/]+)\/([^/]+\.sh)$/.exec(name);
  if (!m) return null;
  return { subdir: m[1], script: m[2] };
}

function entryMatchesScript(entry: SettingsHookEntry, subdir: string, script: string): boolean {
  if (typeof entry.command !== 'string') return false;
  // Commands are relative paths like ./hooks/session/13-ram-guard.sh (or
  // AI/hooks/... in managed repos) — match on the subdir/script suffix so
  // both layouts resolve.
  return entry.command.includes(`${subdir}/${script}`);
}

/**
 * Pure toggle: returns a new settings document with the hook moved between
 * `hooks` and `disabledHooks`. `changed: false` means the hook was already in
 * the requested state (or isn't a settings.json-backed bash hook).
 */
export function setHookEnabled(
  settings: SettingsDoc,
  hookName: string,
  enabled: boolean,
): { settings: SettingsDoc; changed: boolean } {
  const parsed = parseBashHookName(hookName);
  if (!parsed) return { settings, changed: false };

  const eventKey = settingsEventKey(parsed.subdir);
  const next = structuredClone(settings);

  if (enabled) {
    const parked = next.disabledHooks?.[eventKey] ?? [];
    const idx = parked.findIndex(r => entryMatchesScript(r.entry, parsed.subdir, parsed.script));
    if (idx === -1) return { settings, changed: false };

    const record = parked[idx];
    parked.splice(idx, 1);
    if (parked.length === 0) {
      delete next.disabledHooks![eventKey];
      if (Object.keys(next.disabledHooks!).length === 0) delete next.disabledHooks;
    }

    if (!next.hooks) next.hooks = {};
    if (!next.hooks[eventKey]) next.hooks[eventKey] = [];
    const groups = next.hooks[eventKey];

    // Restore into the original group when its matcher still lines up,
    // otherwise the first group with the same matcher, otherwise a new group.
    let group = groups[record.groupIndex];
    if (!group || (group.matcher ?? '') !== record.matcher) {
      group = groups.find(g => (g.matcher ?? '') === record.matcher) as SettingsHookGroup;
    }
    if (!group) {
      group = { matcher: record.matcher, hooks: [] };
      groups.push(group);
    }
    if (!Array.isArray(group.hooks)) group.hooks = [];
    group.hooks.splice(Math.min(record.hookIndex, group.hooks.length), 0, record.entry);

    return { settings: next, changed: true };
  }

  // Disable: find the live entry and park it.
  const groups = next.hooks?.[eventKey] ?? [];
  for (let g = 0; g < groups.length; g++) {
    const entries = groups[g].hooks ?? [];
    for (let h = 0; h < entries.length; h++) {
      if (!entryMatchesScript(entries[h], parsed.subdir, parsed.script)) continue;

      const [entry] = entries.splice(h, 1);
      if (!next.disabledHooks) next.disabledHooks = {};
      if (!next.disabledHooks[eventKey]) next.disabledHooks[eventKey] = [];
      next.disabledHooks[eventKey].push({
        matcher: groups[g].matcher ?? '',
        groupIndex: g,
        hookIndex: h,
        entry,
      });
      return { settings: next, changed: true };
    }
  }

  return { settings, changed: false };
}

/** Scripts currently parked in disabledHooks, as `subdir/script` keys. */
export function readDisabledScripts(settingsPath: string): Set<string> {
  const disabled = new Set<string>();
  try {
    if (!existsSync(settingsPath)) return disabled;
    const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as SettingsDoc;
    for (const [eventKey, records] of Object.entries(doc.disabledHooks ?? {})) {
      const subdir = Object.entries(SUBDIR_TO_EVENT_KEY).find(([, k]) => k === eventKey)?.[0] ?? eventKey;
      for (const r of records ?? []) {
        const cmd = r.entry?.command;
        if (typeof cmd !== 'string') continue;
        const script = cmd.split('/').pop();
        if (script) disabled.add(`${subdir}/${script}`);
      }
    }
  } catch {
    // Unparseable settings — treat as nothing disabled.
  }
  return disabled;
}

/**
 * Read → patch → atomically rewrite settings.json (tmp + rename so a crash
 * can't leave a half-written file). Throws on missing/unparseable settings;
 * returns changed: false when the file already reflects the requested state.
 */
export function applyHookToggle(
  settingsPath: string,
  hookName: string,
  enabled: boolean,
): { changed: boolean } {
  if (!existsSync(settingsPath)) {
    throw new Error(`settings.json not found at ${settingsPath}`);
  }
  const doc = JSON.parse(readFileSync(settingsPath, 'utf-8')) as SettingsDoc;
  const { settings, changed } = setHookEnabled(doc, hookName, enabled);
  if (!changed) return { changed: false };

  const tmpPath = join(dirname(settingsPath), `.settings.json.tmp-${process.pid}`);
  writeFileSync(tmpPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8');
  renameSync(tmpPath, settingsPath);
  return { changed: true };
}
