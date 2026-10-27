// Guards — read-only config/toggles that had no UI home before phase 6.
// Dashboard redesign phase 6 (tech handoff 2026-10-21): Settings side menu
// covering admin auth, the CLI session Usage Guard thresholds, and the
// autonomous-scheduling consent list. Everything here is surfaced from an
// EXISTING config file or env var — nothing is invented, nothing is editable
// from here (the Usage Guard and scheduling policy ship as repo files edited
// via `ship it`; admin auth is an env var set at deploy time).

import { StatCard, Card } from '@/components/ui/card';
import { readUsageGuardPolicy } from '@/lib/guard-policy';
import { readAdminAuthStatus } from '@/lib/admin-auth-status';
import { readSchedulePolicy } from '@/lib/schedule-policy';

export const dynamic = 'force-dynamic';

export default async function GuardsView() {
  const [usageGuard, adminAuth, schedulePolicy] = await Promise.all([
    readUsageGuardPolicy(),
    Promise.resolve(readAdminAuthStatus()),
    readSchedulePolicy(),
  ]);

  return (
    <div className="space-y-6">
      {/* ── Admin auth ─────────────────────────────────────────── */}
      <Card
        title="Admin auth"
        meta={<span title="process.env.ADMIN_API_TOKEN">read-only</span>}
      >
        <div className="p-4 space-y-4 text-sm">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <StatCard
              label="ADMIN_API_TOKEN"
              value={adminAuth.configured ? 'Configured' : 'Not configured'}
              sub={adminAuth.configured ? 'Admin-only panels are reachable' : 'Admin-only panels are disabled on this deployment'}
              icon={adminAuth.configured ? 'check' : 'cross'}
              tone={adminAuth.configured ? 'ok' : 'muted'}
            />
          </div>
          <div>
            <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">What it gates</p>
            <ul className="list-disc list-inside space-y-1 text-[rgb(var(--text-secondary))]">
              {adminAuth.gatedCapabilities.map((cap) => (
                <li key={cap}>{cap}</li>
              ))}
            </ul>
          </div>
          <p className="text-xs text-zinc-600">
            Set on the dashboard AND gateway (same value) to enable these panels. The token itself is never shown here.
          </p>
        </div>
      </Card>

      {/* ── Usage Guard (CLI sessions) ────────────────────────── */}
      <Card
        title="Usage Guard — CLI sessions"
        meta={<span title="config/session-limits.json">read-only</span>}
      >
        <div className="p-4 space-y-4 text-sm">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <StatCard
              label="Session duration"
              value={`${usageGuard.sessionDurationMinutes}m`}
              sub="Time budget per session"
              icon="clock"
              tone="muted"
            />
            <StatCard
              label="Max weighted actions"
              value={usageGuard.maxWeightedActions}
              sub="Action budget per session"
              icon="apps"
              tone="muted"
            />
            <StatCard
              label="Warn at"
              value={usageGuard.warnAtPercent.join(' / ')}
              sub="% capacity — yellow/red/emergency"
              icon="system"
              tone="warn"
            />
            <StatCard
              label="Block at"
              value={usageGuard.blockAtPercent === null ? 'Never' : `${usageGuard.blockAtPercent}%`}
              sub={usageGuard.blockTools.length ? `Tools: ${usageGuard.blockTools.join(', ')}` : 'Warn-only mode'}
              icon={usageGuard.blockAtPercent === null ? 'check' : 'cross'}
              tone={usageGuard.blockAtPercent === null ? 'ok' : 'warn'}
            />
          </div>

          {usageGuard.tokenBudget && (
            <div>
              <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">
                Token budget (output tokens, early-warning estimate)
              </p>
              <div className="flex flex-wrap gap-4 text-[rgb(var(--text-secondary))] text-xs">
                <span>Session: <span className="font-mono text-[rgb(var(--text-primary))]">{usageGuard.tokenBudget.sessionOutputBudget.toLocaleString()}</span></span>
                <span>
                  Rolling window: <span className="font-mono text-[rgb(var(--text-primary))]">{usageGuard.tokenBudget.rollingWindowOutputBudget.toLocaleString()}</span>
                  {' '}/ {usageGuard.tokenBudget.rollingWindowMinutes}m
                </span>
                <span>Warn at: <span className="font-mono text-[rgb(var(--text-primary))]">{usageGuard.tokenBudget.warnAtPercent.join(' / ')}%</span></span>
              </div>
            </div>
          )}

          {usageGuard.autosave && (
            <div>
              <p className="text-label text-[rgb(var(--text-muted))] uppercase tracking-wider mb-2">
                Checkpoint-as-you-go (handoff autosave)
              </p>
              <p className="text-xs text-[rgb(var(--text-secondary))]">
                Nags to write the handoff when it is &gt;{usageGuard.autosave.staleMinutes}m stale AND
                {' '}&ge;{usageGuard.autosave.minWeightedSince} weighted actions have accrued since the last write.
                {usageGuard.autosave.enabled ? '' : ' (disabled)'}
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* ── Scheduling consent ─────────────────────────────────── */}
      <Card
        title="Autonomous scheduling consent"
        meta={<span title="config/schedule_priority.txt + config/schedule_ignore.txt">read-only — full table on Work → Schedule</span>}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-4 text-sm">
          <StatCard
            label="Core-product repos"
            value={schedulePolicy.priorityRepos.length}
            sub="Always P0–P2"
            icon="check"
            tone="ok"
            href="/work?tab=schedule"
          />
          <StatCard
            label="Consent-gated repos"
            value={schedulePolicy.ignoreRepos.length}
            sub="No autonomous work without consent"
            icon="cross"
            tone="warn"
            href="/work?tab=schedule"
          />
        </div>
      </Card>
    </div>
  );
}
