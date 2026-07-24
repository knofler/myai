# YOLO Mode — Autonomous Execution Protocol

> Load-on-demand policy. `CLAUDE.md` keeps the `yolo god` / `yolo N` / `yolo off` keyword rows inline (they're short) plus a one-line pointer to this file for the full execution rules. Read this when YOLO is active or when a `yolo` keyword fires.

> **POLICY: zero-prompt is the default everywhere.** Even outside YOLO, the committed `.claude/settings.json` sets `permissions.defaultMode: "bypassPermissions"` + `skipDangerousModePermissionPrompt: true` + `skipAutoPermissionPrompt: true`. YOLO escalates further by silencing Claude's own clarifying questions on top of the bypassed permission gate. See `documentation/POLICY_ZERO_PROMPT.md`.

When YOLO is active (`state/.yolo` exists and not expired):

1. **No clarifying questions — 100000000000000% NO QUESTIONS, EVER.** Pick the best approach and execute. Don't ask "should I X or Y?" — decide and do it. This is policy level, not preference.
2. **No confirmation prompts.** Proceed with file writes, bash commands, git ops, Docker rebuilds without pausing. The permission gate is already bypassed via committed settings; YOLO closes any remaining gap.
3. **No summarizing before acting.** Skip "I'm going to do X, Y, Z" preamble — just do it and report results.
4. **Error recovery is autonomous.** If something fails, diagnose and fix. Only stop if 3 consecutive attempts at the same fix fail. **3-strikes postmortem (MANDATORY when this fires):** don't just halt — before your final RESULT/summary line, write a postmortem block starting with the words `3-strikes stop` on its own line, then one `Attempt N: <what you tried> -> <the last error>` line per attempt, in order. This is not optional flavor text: a bare stop with no breakdown forces the next session or the operator to re-derive the diagnosis from scratch by re-reading the whole transcript. In a headless fleet-runner session (`scripts/cli_task_runner.sh`), the `3-strikes stop` marker is detected by `runner_three_strikes_note()` and the whole breakdown is written onto the task's blocked note (capped ~1800 chars, vs the normal 800-char summary) — omitting the marker means only your single RESULT line survives onto the task.
5. **Still respect safety rails:** Never push to `main`, never commit secrets, never delete branches without recovery path. PreToolUse hooks (`01-block-push-main.sh`, `03-secret-scan.sh`, `04-protected-files.sh`) enforce these independently of YOLO and bypass mode — bypass mode skips PERMISSION prompts, not hook gates.
6. **Genuinely blocked is different from "wants confirmation":** if something cannot proceed because of missing input only the user can provide (e.g. account credentials, a decision explicitly delegated upstream), state the blocker once and stop. Do NOT ask "should I do X?" — that's a confirmation prompt.

## Timed Mode (`yolo N`)
- Active for N minutes from activation
- Check `state/.yolo` expiry before each action — if expired, delete file and announce "YOLO expired — back to normal mode"
- Show remaining time every 3rd action: `[YOLO: 7m remaining]`

## God Mode (`yolo god`)
- Active until next `git commit` succeeds OR current plan/task list is fully completed
- After successful commit: auto-run `./scripts/yolo.sh stop` and announce "YOLO god mode — deactivated (commit created)"
- After plan completion: auto-run `./scripts/yolo.sh stop` and announce "YOLO god mode — deactivated (plan complete)"

## Checking YOLO State
On session start, `11-yolo-status.sh` hook checks `state/.yolo`: active → display mode + time remaining; expired → delete file, show "YOLO expired"; absent → no output (silent).
