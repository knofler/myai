'use client';

// Notification preferences panel — channels, per-event mutes, quiet hours, and
// per-device web push enrolment. Rendered on /notifications.
//
// Preferences persist per tenant via the gateway (PUT /api/notifications/
// preferences); push enrolment is per browser (PushManager subscription
// registered through /api/notifications/push).
//
// REALTIME_NOTIFICATIONS plan, Phases 6+7.

import { useCallback, useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { enablePush, disablePush, getPushSubscription, pushSupport } from '@/lib/push-client';

interface Prefs {
  inApp: boolean;
  push: boolean;
  email: boolean;
  slack: boolean;
  /** Write-only — sent on save, never present in a GET response (see `slackConfigured`). */
  slackWebhookUrl?: string;
  events: Record<string, boolean>;
  quietStart?: string;
  quietEnd?: string;
  pushConfigured?: boolean;
  emailConfigured?: boolean;
  slackConfigured?: boolean;
  subscriptions?: number;
}

const EVENT_LABELS: Array<{ key: string; label: string; hint: string }> = [
  { key: 'task', label: 'Task activity', hint: 'queue tasks created / updated' },
  { key: 'plan', label: 'Plan updates', hint: 'mythos plan day advanced / completed' },
  { key: 'runner', label: 'Runner lifecycle', hint: 'CLI runner leases fired / released' },
  { key: 'dispatch', label: 'Dispatch runs', hint: 'scheduled agent runs started / finished' },
  { key: 'message', label: 'Agent replies', hint: 'chat sessions — an agent answered' },
  { key: 'other', label: 'Everything else', hint: 'events without their own toggle' },
];

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${on ? 'bg-teal-500/80' : 'bg-zinc-700'}`}
    >
      <span
        className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${on ? 'translate-x-[18px]' : 'translate-x-0.5'}`}
      />
    </button>
  );
}

export function NotificationPreferences() {
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(false);
  const [pushOnDevice, setPushOnDevice] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushMsg, setPushMsg] = useState<string | null>(null);
  const [slackWebhookInput, setSlackWebhookInput] = useState('');
  const support = pushSupport();

  useEffect(() => {
    fetch('/api/notifications/preferences')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((p: Prefs) => setPrefs(p))
      .catch(() => setLoadError(true));
    getPushSubscription().then((s) => setPushOnDevice(Boolean(s))).catch(() => undefined);
  }, []);

  const save = useCallback(async (patch: Partial<Prefs>) => {
    setPrefs((cur) => (cur ? { ...cur, ...patch, events: { ...cur.events, ...(patch.events ?? {}) } } : cur));
    setSaving(true);
    try {
      const res = await fetch('/api/notifications/preferences', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const merged: Prefs = await res.json();
        setPrefs((cur) => ({ ...merged, subscriptions: cur?.subscriptions }));
        setSavedTick(true);
        setTimeout(() => setSavedTick(false), 1500);
      }
    } finally {
      setSaving(false);
    }
  }, []);

  const togglePushDevice = useCallback(async () => {
    setPushBusy(true);
    setPushMsg(null);
    try {
      if (pushOnDevice) {
        await disablePush();
        setPushOnDevice(false);
        setPushMsg('Push disabled on this device.');
      } else {
        await enablePush();
        setPushOnDevice(true);
        setPushMsg('Push enabled — this device gets notified when the app is closed.');
      }
    } catch (err) {
      setPushMsg(err instanceof Error ? err.message : 'Push setup failed.');
    } finally {
      setPushBusy(false);
    }
  }, [pushOnDevice]);

  if (loadError) {
    return (
      <Card title="Notification settings">
        <p className="p-4 text-xs text-[rgb(var(--text-muted))]">Preferences unavailable — gateway unreachable.</p>
      </Card>
    );
  }
  if (!prefs) {
    return (
      <Card title="Notification settings">
        <p className="p-4 text-xs text-[rgb(var(--text-muted))]">Loading…</p>
      </Card>
    );
  }

  return (
    <Card
      title="Notification settings"
      meta={saving ? 'Saving…' : savedTick ? 'Saved' : undefined}
    >
      <div className="p-4 space-y-5">
        {/* Channels */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-[rgb(var(--text-primary))]">In-app notifications</p>
              <p className="text-xs text-[rgb(var(--text-muted))]">Toasts + bell while the dashboard is open</p>
            </div>
            <Toggle on={prefs.inApp} onChange={(v) => save({ inApp: v })} label="In-app notifications" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-[rgb(var(--text-primary))]">Push notifications</p>
              <p className="text-xs text-[rgb(var(--text-muted))]">
                Delivered when no dashboard tab is open
                {prefs.pushConfigured === false && ' — gateway VAPID keys not set'}
                {typeof prefs.subscriptions === 'number' && prefs.subscriptions > 0 && ` · ${prefs.subscriptions} device${prefs.subscriptions === 1 ? '' : 's'}`}
              </p>
            </div>
            <Toggle on={prefs.push} onChange={(v) => save({ push: v })} label="Push notifications" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-[rgb(var(--text-primary))]">Email notifications</p>
              <p className="text-xs text-[rgb(var(--text-muted))]">
                Emailed when no dashboard tab is open
                {prefs.emailConfigured === false && ' — gateway SMTP not configured'}
              </p>
            </div>
            <Toggle on={prefs.email} onChange={(v) => save({ email: v })} label="Email notifications" />
          </div>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm text-[rgb(var(--text-primary))]">Slack notifications</p>
              <p className="text-xs text-[rgb(var(--text-muted))]">
                Posted to your workspace when no dashboard tab is open
                {!prefs.slackConfigured && ' — set a webhook URL below'}
              </p>
            </div>
            <Toggle
              on={prefs.slack}
              onChange={(v) => save({ slack: v })}
              label="Slack notifications"
            />
          </div>
          <div className="flex items-center gap-2 pl-0">
            <input
              type="url"
              value={slackWebhookInput}
              onChange={(e) => setSlackWebhookInput(e.target.value)}
              placeholder={prefs.slackConfigured ? 'Webhook set — paste a new URL to replace it' : 'https://hooks.slack.com/services/…'}
              className="flex-1 bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg px-2 py-1 text-xs text-[rgb(var(--text-primary))]"
              aria-label="Slack Incoming Webhook URL"
            />
            <button
              type="button"
              disabled={!slackWebhookInput}
              onClick={() => { save({ slackWebhookUrl: slackWebhookInput }); setSlackWebhookInput(''); }}
              className="px-3 py-1.5 rounded-lg border border-[rgb(var(--border-subtle))] text-xs text-teal-400 hover:text-teal-300 hover:border-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
            >
              Save
            </button>
            {prefs.slackConfigured && (
              <button
                type="button"
                onClick={() => save({ slackWebhookUrl: '' })}
                className="text-label text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] transition-colors shrink-0"
              >
                clear
              </button>
            )}
          </div>

          {/* Per-device enrolment */}
          <div className="rounded-lg border border-[rgb(var(--border-subtle))] bg-[rgb(var(--bg-surface))]/40 p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-[rgb(var(--text-secondary))]">
                {support === 'ok'
                  ? pushOnDevice ? 'This device is enrolled for push.' : 'This device is not enrolled for push.'
                  : support === 'insecure-context'
                    ? 'Push needs HTTPS or localhost — unavailable on this origin.'
                    : 'This browser does not support web push.'}
              </p>
              <button
                type="button"
                disabled={support !== 'ok' || pushBusy || prefs.pushConfigured === false}
                onClick={togglePushDevice}
                className="px-3 py-1.5 rounded-lg border border-[rgb(var(--border-subtle))] text-xs text-teal-400 hover:text-teal-300 hover:border-zinc-700 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
              >
                {pushBusy ? 'Working…' : pushOnDevice ? 'Disable on this device' : 'Enable on this device'}
              </button>
            </div>
            {pushMsg && <p className="text-label text-[rgb(var(--text-muted))]">{pushMsg}</p>}
          </div>
        </div>

        {/* Quiet hours */}
        <div>
          <p className="text-sm text-[rgb(var(--text-primary))]">Quiet hours</p>
          <p className="text-xs text-[rgb(var(--text-muted))] mb-2">Push + email are muted in this window (in-app + history unaffected)</p>
          <div className="flex items-center gap-2">
            <input
              type="time"
              value={prefs.quietStart ?? ''}
              onChange={(e) => save({ quietStart: e.target.value })}
              className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg px-2 py-1 text-xs text-[rgb(var(--text-primary))]"
              aria-label="Quiet hours start"
            />
            <span className="text-xs text-[rgb(var(--text-muted))]">to</span>
            <input
              type="time"
              value={prefs.quietEnd ?? ''}
              onChange={(e) => save({ quietEnd: e.target.value })}
              className="bg-[rgb(var(--bg-surface))] border border-[rgb(var(--border-subtle))] rounded-lg px-2 py-1 text-xs text-[rgb(var(--text-primary))]"
              aria-label="Quiet hours end"
            />
            {(prefs.quietStart || prefs.quietEnd) && (
              <button
                type="button"
                onClick={() => save({ quietStart: '', quietEnd: '' })}
                className="text-label text-[rgb(var(--text-muted))] hover:text-[rgb(var(--text-primary))] transition-colors"
              >
                clear
              </button>
            )}
          </div>
        </div>

        {/* Event families */}
        <div>
          <p className="text-sm text-[rgb(var(--text-primary))] mb-0.5">Event types</p>
          <p className="text-xs text-[rgb(var(--text-muted))] mb-2">Muted types are still recorded in history — just not surfaced live</p>
          <div className="space-y-2">
            {EVENT_LABELS.map(({ key, label, hint }) => (
              <div key={key} className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-xs text-[rgb(var(--text-primary))]">{label}</p>
                  <p className="text-label text-zinc-600">{hint}</p>
                </div>
                <Toggle
                  on={prefs.events[key] ?? true}
                  // PUT replaces the whole events map — send it in full.
                  onChange={(v) => save({ events: { ...prefs.events, [key]: v } })}
                  label={label}
                />
              </div>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}
