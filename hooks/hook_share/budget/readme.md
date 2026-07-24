# budget_hook — shareable Claude Code token-management hook

One self-contained file. Give it to anyone; they run `--install` once and their
Claude CLI follows the same token-management rules as the ai_management fleet.

## What your mate gets

- **At session start:** a line showing their **account rolling-window** output-token
  burn across **all** repos (the shared-account signal that freezes every session
  at once) — so they don't dive into a token-hungry model and hit the wall.
- **Before every tool call:** real output-token metering from the live transcript;
  warnings at 70/85/95%; an **early "write your handoff NOW" checkpoint** so hitting
  the wall is always survivable; and a throttled nudge to run `/usage` (the
  authoritative reading) when burn is high.
- **Warn-only** — it never blocks a tool. Pure safety net.

## Install (one command)

```bash
# 1. get the file (copy budget_hook.sh anywhere), then:
bash budget_hook.sh --install
# 2. restart Claude Code.
```

That's it. `--install` copies the script to `~/.claude/budget_hook.sh` and
wires it into `~/.claude/settings.json` (SessionStart + PreToolUse), **merging**
into any existing hooks (idempotent, non-destructive, makes a `.tokenguard.bak`).

Requires `jq` (`brew install jq` / `apt install jq`).

## Other commands

```bash
bash budget_hook.sh --status      # print current rolling-window burn
bash budget_hook.sh --uninstall   # remove it (leaves other hooks intact)
bash budget_hook.sh --help
```

## Tune the budgets (optional)

Defaults are starting points calibrated for one heavy user. The real ceiling is
your plan's limit — **ground truth is Claude Code's `/usage`**, this hook is an
on-disk estimate. Calibrate once: run `/usage`, note its session %, read the
session-start line's token count, then set
`output_budget = count / (pct / 100)`.

Drop a `~/.claude/token-guard.json` to override (all fields optional):

```json
{
  "session_output_budget": 600000,
  "checkpoint_at_percent": 70,
  "warn_at_percent": [70, 85, 95],
  "rolling_window": { "output_budget": 4400000, "window_minutes": 300 },
  "usage_ground_truth": { "enabled": true, "interval_minutes": 2, "floor_percent": 70 }
}
```

Or quick env overrides: `TOKEN_GUARD_SESSION_BUDGET`, `TOKEN_GUARD_ROLLING_BUDGET`.

## Why a hook, not a skill?

Token management must be **always-on and automatic** — it has to meter every turn
and warn before the wall. A skill only runs when explicitly invoked, so it can't
guard you. Hooks fire on every session start + tool call, which is exactly what
this needs.

## How it works (no magic)

It sums `message.usage.output_tokens` from the JSONL transcripts under
`~/.claude/projects` — the current session for the session budget, and everything
touched in the last N minutes (across all repos) for the account rolling window.
Read-only, ~30 ms per call, rolling scan cached ~90 s. No network, no repo layout
assumptions — purely `~/.claude`.
