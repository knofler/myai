'use client';

// Settings control for the idle-session auto-logout (see
// src/lib/idle-timeout.ts + idle-timeout-guard.tsx). Lives on /sessions
// alongside device management since it's the same "who can stay signed in,
// for how long" concern. Writes the tenant-scoped preference and dispatches
// IDLE_TIMEOUT_CHANGED_EVENT so a mounted guard picks it up immediately.

import { useEffect, useState } from 'react';
import { useTenant } from '@/lib/tenant-context';
import {
  IDLE_TIMEOUT_CHANGED_EVENT,
  IDLE_TIMEOUT_OPTIONS,
  readStoredIdleTimeoutMinutes,
  writeStoredIdleTimeoutMinutes,
  type IdleTimeoutMinutes,
} from '@/lib/idle-timeout';

const LABELS: Record<IdleTimeoutMinutes, string> = {
  15: '15 minutes',
  30: '30 minutes',
  60: '1 hour',
  120: '2 hours',
  0: 'Never',
};

export function IdleTimeoutSettings() {
  const { current } = useTenant();
  const tenantId = current?.tenantId ?? null;
  const [minutes, setMinutes] = useState<IdleTimeoutMinutes>(30);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setMinutes(readStoredIdleTimeoutMinutes(window.localStorage, tenantId));
  }, [tenantId]);

  const onChange = (value: IdleTimeoutMinutes) => {
    setMinutes(value);
    writeStoredIdleTimeoutMinutes(window.localStorage, value, tenantId);
    window.dispatchEvent(new Event(IDLE_TIMEOUT_CHANGED_EVENT));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  return (
    <div className="rounded-lg border border-zinc-800 p-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-200">Auto sign-out after inactivity</p>
          <p className="mt-1 text-xs text-zinc-500">
            Shows a warning before signing this device out automatically — useful on a shared machine.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {saved && <span className="text-xs text-emerald-400">Saved</span>}
          <select
            value={minutes}
            onChange={(e) => onChange(Number(e.target.value) as IdleTimeoutMinutes)}
            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1.5 text-xs text-zinc-200"
          >
            {IDLE_TIMEOUT_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {LABELS[opt]}
              </option>
            ))}
          </select>
        </div>
      </div>
    </div>
  );
}
