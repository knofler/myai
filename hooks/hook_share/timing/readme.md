# hook_share/timing — SessionStart hook latency budget

`timed_hook.sh` is the shared timing wrapper every SessionStart hook in
`.claude/settings.json` runs through:

```json
{ "type": "command",
  "command": "./hooks/hook_share/timing/timed_hook.sh ./hooks/session/03-docker-health.sh",
  "timeout": 15000 }
```

## Why

`hooks/session/` holds 25+ boot hooks, several doing network or Docker I/O.
A slow or hanging hook silently taxes every session start, working against the
fast-cold-start goal in `plan/TOKEN_OPTIMIZATION.md`. Before this wrapper,
only three hooks touched timing at all — nothing measured where boot
wall-clock actually went.

## What it does

- Forwards stdin (the SessionStart JSON), all output, and the hook's exit
  code untouched. Timing failures never change hook behavior (non-fatal
  contract), and a failing hook still gets its duration recorded. A harness
  timeout kill is recorded as exit `124`.
- Appends `<boot_id> <start_ms> <dur_ms> <exit> <hook_basename>` to
  `state/.hook-timing.log.<host>` (per-machine suffix via
  `scripts/lib/local_state.sh`, gitignored, rotated at ~4000 lines down
  to 2000). `boot_id` is the `session_id` from the hook JSON, so one boot's
  parallel hooks group together.
- SessionStart hooks run **in parallel**, so the wrapper whose entry
  completes the boot (entry count reaches the wrapped-hook count in
  `.claude/settings.json`) emits the boot report — exactly once, via an
  atomic noclobber marker file.
- The report prints **only** when the boot's wall-clock (latest finish −
  earliest start) exceeds the budget:
  `config/session-limits.json → session_hooks.budget_ms` (default 20000 ms).
  A fast boot prints nothing.
- `myai doctor` → "session hook timing" reads the same log and shows the
  last boot's wall-clock, budget, and slowest 3 hooks.

## Notes

- Lives under `hooks/hook_share/` (not `hooks/session/`) on purpose: the
  gateway's bash-hook loader registers every `hooks/session/*.sh` as a hook,
  and the wrapper must never be registered/executed as one.
- The dashboard hook toggle (`runtime/src/hooks/settings-patch.ts`) matches
  entries by `subdir/script` substring, so wrapped commands stay toggleable.
- If a hook is SIGKILLed mid-boot its entry is missing, the count never
  completes, and that boot simply reports nothing inline — `myai doctor`
  still shows the partial breakdown.
- Env overrides for tests: `HOOK_TIMING_LOG`, `HOOK_TIMING_BOOT_ID`,
  `HOOK_TIMING_BUDGET_MS`, `HOOK_TIMING_EXPECTED`, `HOOK_TIMING_SETTINGS`,
  `HOOK_TIMING_MAX_LINES`, `HOOK_TIMING_KEEP_LINES`.
- Verified by `scripts/tests/test_session_hook_timing.sh` (fast path silent,
  injected slow hook warns, hook failure stays non-fatal).
