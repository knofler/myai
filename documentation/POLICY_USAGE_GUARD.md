# Usage Guard + Token Budget Protocol — Session Capacity Management

> Load-on-demand policy. `CLAUDE.md` keeps a one-line pointer to this file; the full text lives here to keep the per-turn context small. The hooks referenced below run automatically every session regardless of whether this file is loaded — the warnings are **mandatory directives, not suggestions.**

The Usage Guard tracks session capacity via two metrics: **elapsed time** and **weighted action count** (tool calls as token proxy). The higher percentage is the effective level. Config: `config/session-limits.json`. Metrics: `state/.session-metrics`.

> **These are self-imposed framework guards, NOT Claude/API limits.** The numbers are tunable proxies to prompt clean wrap-ups before context grows large; raising them costs nothing and grants no extra model capacity (the real ceiling is the context window, which auto-compacts). Current defaults: **480 min / 800 weighted actions**, **warn-only** (`block_at_percent: null`, `block_tools: []`) — the guard nags at 80/90/95% but never freezes tools. To re-enable the hard block, set `block_at_percent` (e.g. `95`) and `block_tools` in `config/session-limits.json`; the `10-usage-guard.sh` hook reads both.

Hooks automatically emit warnings. **These are mandatory directives, not suggestions.**

## Token Budget Guard — REAL token burn + account rolling window (since 2026-06-10)

Separate from, and more important than, the action-count guard above. The action counter is a *proxy*; this reads **actual token usage** from the session transcript JSONL (`~/.claude/projects/.../<session>.jsonl`, path `.message.usage.output_tokens`). Config: `config/session-limits.json` → `token_budget`. Hooks: `hooks/pre-tool/15-token-budget-guard.sh` (live metering) + `hooks/session/15-token-budget-status.sh` (session-start awareness). Ephemeral state: `state/.token-metrics`, `state/.token-rolling-cache` (gitignored).

Two signals, both in raw **output tokens** (the scarce resource on token-hungry models like Fable):

- **Session budget** (`session_output_budget`, default 600k). At `checkpoint_at_percent` (default 70%) the pre-tool hook emits a **`TOKEN GUARD: CHECKPOINT`** box — a MANDATORY directive to **write `state/AI_AGENT_HANDOFF.md` immediately** (done / in-progress / next / blockers) and commit it. This is a SAVE POINT, not a stop: it exists so that if the account limit is hit mid-task, the session is always resumable. Honor it the moment it fires.
- **Account rolling window** (`rolling_window`, default 3M output tokens / 300 min). This is the **cross-repo, account-level** signal a per-repo counter can never see: it sums output tokens across **all** transcripts under `~/.claude/projects` (one Claude.ai account is shared by every repo/agent). This is the limit that freezes *every* session at once. The session-start hook prints it before any work; the pre-tool hook warns at 70/85/95%. At 85%+ → finish + `wrap up` on ALL active sessions; at 95%+ → write handoffs everywhere and stop starting new work.

**Warn-only — never blocks** (blocking on token burn would strand you worse). Propagated fleet-wide via `update_all.sh`; every repo's guard reads the same global rolling window.

**Periodic `/usage` ground-truth nudge (`usage_ground_truth`, since 2026-06-10).** Because the metering above is only an estimate and the agent **cannot run `/usage` itself** (it's an interactive Claude Code command with no tool/MCP surface), the pre-tool hook emits a **throttled reminder** — at most once per `interval_minutes` (default **2 min**) — once the higher of session/rolling burn reaches `floor_percent` (default **70%**). The reminder directs: run `/usage` now (or ask the user to) for the authoritative reading, and recalibrate `output_budget` if it diverges. This is the fleet-wide answer to "check usage every ~2 minutes": the hook can't invoke `/usage`, but it keeps the ground-truth check in front of you on a 2-minute cadence whenever burn is elevated. Config in `config/session-limits.json` → `token_budget.usage_ground_truth`; set `enabled:false` to silence.

**Ground truth is the `/usage` command, not this hook.** Claude Code's `/usage` shows the authoritative server-side numbers (session % + reset timer, weekly all-models %, weekly Sonnet-only %, daily routine runs) for your plan (the user is on a **Team** plan). Those percentages are computed server-side and are **not persisted to any disk file** a hook can read (verified 2026-06-10: `~/.claude/stats-cache.json` holds cumulative token history only; `sessions/*.json` is process metadata; there's no rate-limit cache). So hook 15 is a deliberately-approximate **early-warning estimate** from transcript output-token sums, not a mirror of `/usage`. It was **calibrated 2026-06-10**: the estimator read ~2.76M output tokens when `/usage` showed **63%** of the session limit → `output_budget` set to **4.4M** (so the estimate's % roughly tracks the real session %). When it drifts from `/usage`, recalibrate: `output_budget = (session-start hook's token count) / (real /usage session% ÷ 100)`. For an exact reading, run `/usage`.

## At 80% — YELLOW WARNING

You will see: `USAGE GUARD: YELLOW WARNING — 80% CAPACITY`

1. **Announce** to user: "Session at 80% — ~Xm and ~Y actions remaining."
2. **Finish** current task — do NOT start new work.
3. **Prioritize** remaining budget: commit > push > state update > handoff.
4. **Skip** non-essential ops: no refactors, no exploratory reads, no test runs unless critical.

## At 90% — RED WARNING

You will see: `USAGE GUARD: RED WARNING — 90% CAPACITY`

1. **Stop** all work immediately.
2. **Run `wrap up`** — full session close.
3. If `wrap up` would exceed budget, skip to 95% emergency protocol.
4. **Tell user**: "Session at 90% — wrapping up now. Continue with Gemini/Copilot using AI_AGENT_HANDOFF.md."

## At 95% — EMERGENCY

You will see: `USAGE GUARD: EMERGENCY — 95% CAPACITY`. With the **default warn-only config**, tools are **NOT** blocked — this is a strong nudge, not a freeze. (If `block_at_percent`/`block_tools` are set in config, Bash/Edit/Write/Agent are blocked except writes to AI_AGENT_HANDOFF.md.)

1. **Write `state/AI_AGENT_HANDOFF.md` immediately** with minimal content: what was done (bullets), what's in progress (branch, uncommitted files), what should be done next (prioritized), current blockers, last machine hostname.
2. **Prioritize** the rest of the budget: handoff > commit > push > STATE.md > logs.
3. If the hard block IS enabled, only handoff writes pass — tell the user to commit/push manually.
4. Tell user: "At 95% — handoff saved. Wrapping up / continue with another agent if needed."
