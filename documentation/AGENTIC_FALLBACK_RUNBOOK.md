# Non-Claude Agentic Fallback Lane — Operator Runbook

Operator-facing how-to for the DeepSeek/Kimi fallback lane that keeps the
runner draining the task queue during Claude session-cap dead windows. For
the *design* rationale (why this lane exists, options considered, safety
gates), see `plan/ADR_AGENTIC_FALLBACK_LANE.md`. This doc is the *how*:
enable/disable, cost-cap tuning, deny-list extension, reading the ledger,
and diagnosing a lane that silently declines. Implementation lives in
`scripts/lib/agentic_fallback.sh` (rails: git checkout/commit/push, USD
ledger, readiness gate) and `scripts/lib/openai_agent.py` (the bounded
tool loop that does the actual edit→test work).

## What it is, in one paragraph

When the Claude subscription's 5-hour session window is exhausted, the
runner's default move is to release the task back to `pending` and idle.
This lane is an **opt-in, real-dollar** alternative: it hands the task to
DeepSeek or Kimi (Moonshot) — both OpenAI-compatible, billed separately
from Claude — via a small stdlib-only tool loop with real repo access
(`list_files`/`read_file`/`write_file`/`run_command`). It only ever
touches the `test` branch, commits once, pushes with one rebase retry,
and never force-pushes. It is OFF by default and stays off unless you
turn it on.

## Enable / disable

The switch lives in `.env` (gitignored, machine-local) as `MYAI_*` vars,
which `config/runner_budget.conf` imports and maps onto the
`AGENTIC_FALLBACK*` vars that `scripts/lib/agentic_fallback.sh` actually
reads. Don't edit `runner_budget.conf` itself — it's committed and shared
across machines; `.env` is where your personal/this-machine settings go.

**Enable for this repo/machine:**

1. Copy the block from `.env.example` into `.env` if it isn't there yet:
   ```
   MYAI_AGENTIC_FALLBACK=off
   MYAI_AGENTIC_FALLBACK_MODELS=deepseek-chat
   MYAI_AGENTIC_FALLBACK_DAILY_USD_CAP=2.00
   DEEPSEEK_API_KEY=
   MOONSHOT_API_KEY=
   ```
2. Set `MYAI_AGENTIC_FALLBACK=on`.
3. Fill in the key for whichever vendor `MYAI_AGENTIC_FALLBACK_MODELS`
   points at — `DEEPSEEK_API_KEY` for `deepseek-*` models,
   `MOONSHOT_API_KEY` for `kimi-*`/`moonshot-*` models. The wrapper reads
   the key from the environment first, then extracts *only* that one
   named var from `.env` (it never blanket-sources the file, so other
   secrets in `.env` — Mongo URI, gateway tokens — are never leaked into
   the lane's environment).
4. No rebuild/restart needed — `runner_budget.conf` is re-sourced by the
   runner on its next task pickup.

**Disable:** set `MYAI_AGENTIC_FALLBACK=off` (or delete the line — `off`
is the default when unset). Takes effect on the runner's next pickup;
nothing to restart.

**Verify it's live** without waiting for a real session cap: run
`agentic_fallback_ready` manually after sourcing the lib —
```bash
bash -c 'source scripts/lib/agentic_fallback.sh; agentic_fallback_ready && echo READY || true'
```
On failure it prints the exact reason (see the Troubleshooting section).

## Queue-depth overflow lane (opt-in, independent of the crisis trigger)

The lane above only engages *reactively* — after the whole Claude chain has
already died on a session cap. `AGENTIC_OVERFLOW` is a **second, independent**
opt-in switch that engages *proactively*: while Claude/Fable still have
headroom, a deep P2/P3 backlog is routed straight to the same paid lane
instead of waiting for a cap. Useful for a scheduled off-hours window where
you'd rather spend a few dollars draining low-priority backlog than let it
sit idle overnight. See `plan/ADR_AGENTIC_FALLBACK_LANE.md` § "Queue-depth
overflow lane" for the full design.

**Enable:**

```
MYAI_AGENTIC_OVERFLOW=on
MYAI_AGENTIC_OVERFLOW_PRIORITIES="P2 P3"     # which priorities are eligible
MYAI_AGENTIC_OVERFLOW_MIN_QUEUE_DEPTH=8      # pending-task floor before it engages
```

It shares the crisis trigger's model config (`MYAI_AGENTIC_FALLBACK_MODELS`),
API key, and `MYAI_AGENTIC_FALLBACK_DAILY_USD_CAP` — there is only ONE $/day
ledger for the whole agentic lane, spent by whichever trigger fires. You do
**not** need `MYAI_AGENTIC_FALLBACK=on` for this to work — the two switches
are independent; turn on overflow alone if you only want the proactive drain,
not the crisis fallback (or vice versa, or both).

**Verify it's live:**

```bash
bash -c 'source scripts/lib/agentic_fallback.sh; agentic_overflow_ready 10 P2 && echo READY || true'
```

The first arg is a test queue-depth, the second a test priority — this lets
you check the gate without needing a real deep backlog. On failure it prints
the exact reason (disabled / priority outside band / depth below floor / not
ready for the same model+key+budget reasons as the crisis trigger).

**Disable:** set `MYAI_AGENTIC_OVERFLOW=off` (or delete the line).

**Activating it for real?** It shipped default-off with no canary ever run.
Follow `plan/ADR_AGENTIC_FALLBACK_LANE.md` → "Queue-depth overflow lane" →
"Rollout Plan — activation checklist" before flipping the switch on a live
machine — conservative starting config, canary verification, and the
before/after comparison command
(`./scripts/cli_task_runner.sh --overflow-report`) are all there.

## All-pools-capped demotion lane (opt-in, independent of the other two triggers)

A THIRD, independent opt-in switch — distinct from both the crisis trigger
(reacts only after a live Claude session has already died on the account
limit) and the overflow trigger (proactive, engages while Claude still has
headroom). This one fires *before* a session is even attempted: the runner's
capability×cost×availability router (`route_task_model`) already tracks
`state/pool-capacity.json` + the pacing ledgers and sets `ROUTE_EXHAUSTED`
when EVERY Claude pool it checks (tech + Fable) is confirmed out of headroom
for an already-claimed task. Before this switch existed, that task was
simply released back to `pending` until the next reset ("paused until
Monday"). With `MYAI_AGENTIC_EXHAUSTION_DEMOTION=on`, it is offered to the
same paid DeepSeek/Kimi lane first ("demoted to metered API until Monday")
instead. See `plan/MULTI_PROVIDER_ORCHESTRATION.md` §4b for the full design.

**Enable:**

```
MYAI_AGENTIC_EXHAUSTION_DEMOTION=on
```

Shares the crisis trigger's model config, API key, and $/day cap — same one
ledger for the whole lane, spent by whichever trigger fires. Independent of
`MYAI_AGENTIC_FALLBACK` / `MYAI_AGENTIC_OVERFLOW` — enable any subset.
Unlike the overflow trigger, there is no separate priority/depth gate: an
already-claimed task with nowhere else to go is eligible regardless of
priority, since `ROUTE_EXHAUSTED` is already the rare, hard signal (both
pools genuinely out of budget, not just "hot"). Also unlike the other two
triggers, the resulting run does **not** fall back to a Claude model on
failure — every Claude pool is already confirmed capped, so retrying one in
the same fire would just fail again; a declined attempt falls through to the
normal task-failure close-off instead.

**Verify it's live:**

```bash
bash -c 'source scripts/lib/agentic_fallback.sh; agentic_exhaustion_ready && echo READY || true'
```

**Disable:** set `MYAI_AGENTIC_EXHAUSTION_DEMOTION=off` (or delete the line).

## Choosing / tuning the model

`AGENTIC_FALLBACK_MODELS` (env: `MYAI_AGENTIC_FALLBACK_MODELS`, default
`deepseek-chat`) is a space-separated list, but today only the **first**
token is used (`agentic_first_model` in `agentic_fallback.sh`) — treat it
as a single model id, not a real fallback chain. Valid id prefixes are
matched by `agentic_model_match`: `deepseek-*`, `kimi-*`, `moonshot-*`.
Anything else is rejected as "no valid lane model configured".

The base URL is derived from the model prefix and is overridable per
vendor if you need a proxy or regional endpoint:
- `deepseek-*` → `DEEPSEEK_BASE_URL` (default `https://api.deepseek.com/v1`)
- `kimi-*`/`moonshot-*` → `MOONSHOT_BASE_URL` (default `https://api.moonshot.ai/v1`)

## Cost-cap tuning

Two independent knobs govern spend, both env vars read by
`agentic_fallback.sh`:

| Var | `.env` name | Default | What it does |
|---|---|---|---|
| `AGENTIC_FALLBACK_DAILY_USD_CAP` | `MYAI_AGENTIC_FALLBACK_DAILY_USD_CAP` | `2.00` | Hard daily USD ceiling. Checked before a run starts (`agentic_fallback_ready`/`agentic_fallback_run`) AND the ledger is written regardless of run outcome, so a failed/blocked run still counts against the cap. |
| `AGENTIC_LEDGER_DIR` | — (machine env only) | `${RUNNER_STATE_DIR:-$HOME/.ai-cli-runner}/agentic` | Where the day-ledger files live. Machine-local, never git. |

To raise or lower the cap, change `MYAI_AGENTIC_FALLBACK_DAILY_USD_CAP` in
`.env` and let it re-source on the next pickup — no code change needed.

The ledger is one file per Sydney-calendar-day:
`$AGENTIC_LEDGER_DIR/YYYYMMDD.usd`, one appended line per run (raw USD
float, no header). To see today's spend directly:
```bash
cat ~/.ai-cli-runner/agentic/$(TZ=Australia/Sydney date +%Y%m%d).usd
awk '{s+=$1} END {print s}' ~/.ai-cli-runner/agentic/$(TZ=Australia/Sydney date +%Y%m%d).usd
```
To reset today's spend (e.g. after manually verifying a bad estimate),
delete or truncate that one file — it's machine-local scratch state, not
tracked in git.

**Pricing table** (used to convert token usage into the `cost_usd` that
gets written to the ledger) lives in `PRICES_PER_M` in
`scripts/lib/openai_agent.py` — USD per 1M (input, output) tokens per
model prefix, with an expensive-by-design fallback price for unknown
model ids (the budget gate would rather overestimate than under-count).
Override without touching code via `AGENTIC_PRICE_IN_PER_M` /
`AGENTIC_PRICE_OUT_PER_M` env vars (both must be set together, or they're
ignored and the table/fallback is used). Refresh the table itself when
vendor pricing changes — it's a static snapshot dated "2026-07" in a
comment above the dict.

**Other tunables** (env-only, not yet surfaced as `MYAI_*` vars — set
directly in `.env` or the runner's environment if you need non-default
values):

| Var | Default | What it does |
|---|---|---|
| `AGENTIC_MAX_ITERS` | `24` | Max tool-call round-trips per run before the agent gives up (`openai_agent.py --max-iters`). Raise for tasks needing many read/write/test cycles; lower to fail fast and cheap. |
| `AGENTIC_CMD_TIMEOUT_SEC` | `300` | Wall-clock timeout (seconds) for each individual `run_command` call inside the loop. Raise if your test suite legitimately takes longer than 5 minutes. |

## Deny-list — what's blocked, and how to extend it safely

`run_command` (the only tool that shells out) refuses any command line
containing one of these substrings (case-insensitive, whitespace-
collapsed match — see `command_denied()` in `scripts/lib/openai_agent.py`):

```
git push        git commit      sudo            shutdown
reboot          npm install     npm ci          pip install
brew install    docker compose up               docker compose down
--force         rm -rf /
```

Rationale: `git commit`/`git push` are owned by the harness (single
commit, `test` branch only, one rebase retry — letting the model commit
would break that contract); the rest are host-mutating or destructive
operations out of scope for a headless fallback lane running on someone's
Mac.

**To extend it** (e.g. block another destructive pattern you've hit),
edit the `COMMAND_DENYLIST` tuple in `scripts/lib/openai_agent.py`:
```python
COMMAND_DENYLIST = (
    "git push", "git commit", "sudo ", "shutdown", "reboot",
    "npm install", "npm ci", "pip install", "brew install",
    "docker compose up", "docker compose down", "--force", "rm -rf /",
    "your-new-pattern-here",
)
```
Rules of thumb:
- It's a **substring** match on the whole (whitespace-collapsed,
  lowercased) command line, not a word/argv match — a short or common
  pattern can over-block (e.g. adding `"install"` bare would also refuse
  `pip install --dry-run` style diagnostics you might actually want to
  allow). Prefer the more specific two/three-word form you actually saw
  fail.
- Never remove the existing `git push`/`git commit`/`sudo `/`--force`
  entries — those protect the harness's single-commit contract and the
  "never force-push" safety rail from the ADR.
- After editing, re-run `scripts/tests/test_openai_agent.py` (see
  Verification below) — it has explicit deny-list assertions and will
  catch a regex/substring mistake before it ships.
- This list is **not** currently exposed as an env var — it's a code
  change, reviewed like any other, by design (letting an env var punch
  holes in the sandbox from `.env` would be a much larger attack surface
  than editing a committed Python literal).

## Reading the per-run token/USD ledger line

Each run emits two machine-readable log lines, visible in the runner's
per-task log (`~/.ai-cli-runner/logs/<timestamp>-<repo>-<task-id>.log` —
the lane's stdout/stderr is captured into that same file, whether it ran
via direct model routing or the session-cap fallback trigger):

1. From `openai_agent.py`, right before it exits:
   ```
   [openai-agent] usage {"model":"deepseek-chat","prompt_tokens":4213,"completion_tokens":812,"cost_usd":0.001522}
   [openai-agent] done ok=true edited=true
   ```
   `prompt_tokens`/`completion_tokens` are cumulative across every
   tool-loop iteration in that run; `cost_usd` is those tokens priced via
   `PRICES_PER_M`/the price-override env vars.

2. From `agentic_fallback.sh`, after it parses the line above and appends
   to today's ledger:
   ```
   [agentic] spend this run: $0.001522 (today: $0.014 of $2.00)
   ```
   This is the line to grep for a quick spend summary:
   `grep '\[agentic\] spend this run' ~/.ai-cli-runner/logs/*-<repo>-*.log`

Note the spend line is written **even when the run fails or is deny-list
blocked** — a failed run still consumed billed tokens, so it still counts
against the cap (see `_agentic_run_inner` in `agentic_fallback.sh`).

## Reading the per-provider quality ledger (pass-rate)

The USD ledger above answers "how much did this lane cost"; a second,
separate ledger answers "was it worth it" — plan/ADR_AGENTIC_FALLBACK_LANE.md's
follow-up: *"per-model quality tracking (does DeepSeek's review-rate justify
the spend)"*. Every fallback attempt (see `_agentic_run_inner` in
`agentic_fallback.sh`) appends one line to
`$AGENTIC_LEDGER_DIR/outcomes.log`: `<ISO8601-UTC> <provider> <outcome>
<taskId>`, keyed by **provider** (`deepseek`/`kimi`, via
`agentic_provider_name`) rather than the exact model id — that's the finest
grain the task store persists (`executionProvider`, task-b1776200).

Outcomes:

| Outcome | Meaning | Counts as |
|---|---|---|
| `shipped` | Clean push to `origin/test`, recorded the moment the attempt lands | pass |
| `confirmed` | A stronger, later signal: `reconcile_review_tasks.sh` proved this task's diff survived all the way to `main` (review→done) | pass |
| `no-fix` / `no-changes` / `commit-failed` / `push-failed` | The attempt didn't land — see the matching `[agentic] ...` log line for which stage failed | fail |

`agentic_quality_pass_rate <provider>` computes a rolling pass-rate over the
last `AGENTIC_QUALITY_WINDOW` (default `20`) recorded attempts for that
provider; `agentic_quality_rollup` prints one line per provider:
```bash
bash -c 'source scripts/lib/agentic_fallback.sh; agentic_quality_rollup'
# [agentic] deepseek   pass-rate=0.83 (n=12, window=20)
# [agentic] kimi       pass-rate=0.60 (n=5, window=20)
```
Empty pass-rate (not `0.00`) means that provider has no recorded attempts
yet — distinguish "never ran" from "ran and always failed" before acting on
it. There is no automated model→endpoint reweighting yet — this ledger is
the observability the ADR asked for; an operator reads the rollup and
adjusts `AGENTIC_FALLBACK_MODELS` by hand.

**Caveat:** `confirmed` depends on `reconcile_review_tasks.sh` actually
running (wired into `agent mode`/`wrap up`/the runner, throttled) and on a
task carrying a stamped `[pushed-shas]` note. There's no task revert/reopen
lifecycle event in this fleet yet, so a fallback diff that shipped but later
needed real human rework has no distinct "reverted" outcome — it just never
gets a `confirmed` record. Treat the rollup as a lower bound on quality, not
a verdict.

## Troubleshooting a lane that silently declines

The lane fails *closed* by design (any doubt → skip, fall back to the
normal release-to-pending path), which can look like "nothing happened."
`agentic_fallback_ready` (called before every attempt) prints the exact
reason to the log — check for one of these lines:

| Log message | Cause | Fix |
|---|---|---|
| `lane disabled (AGENTIC_FALLBACK=off)` | `MYAI_AGENTIC_FALLBACK` is `off`/unset in `.env` | Set `MYAI_AGENTIC_FALLBACK=on` (see Enable/disable above) |
| `no valid lane model configured ('...')` | `MYAI_AGENTIC_FALLBACK_MODELS` is empty or doesn't start with `deepseek-`/`kimi-`/`moonshot-` | Fix the model id, e.g. `deepseek-chat` |
| `no API key for <model> (<VAR> unset)` | Neither the env var nor a matching line in `.env` resolves | Set `DEEPSEEK_API_KEY`/`MOONSHOT_API_KEY` — check for exact var name, no quotes issues, no stray whitespace in `.env` |
| `daily USD cap reached ($X of $Y)` | Today's ledger total is at/over the cap | Wait for the next Sydney day, raise `MYAI_AGENTIC_FALLBACK_DAILY_USD_CAP`, or clear/inspect the ledger file (see Cost-cap tuning) |

If none of those print and the lane still didn't seem to run, check
**when** it's even allowed to engage — this is a fallback lane, not a
general worker:

- **Session-cap fallback trigger** (`cli_task_runner.sh`, the main path):
  only fires when (a) the Claude model chain has already failed for this
  task, AND (b) the last ~600 bytes of that failed run's log match the
  account-limit signature (`AGENTIC_LIMIT_REGEX` in
  `agentic_fallback.sh`: `hit your (session|usage) limit`, `usage
  limit.*resets`, `out of usage credits`, etc.). An ordinary task failure
  (bad diff, failing test) does **not** trigger it — that's intentional,
  it's meant to survive a dead Claude window, not paper over broken code.
- **Direct routing**: pin a task's `recommendedModel` to a
  `deepseek-*`/`kimi-*`/`moonshot-*` id and the runner routes straight to
  `agentic_fallback_run`, bypassing the session-cap check entirely — the
  fastest way to test the lane end-to-end without waiting for a real cap.
- **A genuine push is the only success signal**: `agentic_fallback_run`
  returns non-zero on anything short of a landed `git push origin test`
  — including "agent said done but left no diff" and "push failed after
  one rebase retry" — so a run that *looks* like it did work but didn't
  push will also show as declined. Check the full log for `[agentic]
  agent did not land a fix`, `left no changes`, or `push to origin/test
  failed after rebase retry` immediately above the decline.

For a fully offline sanity check (no API calls, no queue involvement),
run the existing test suites:
```bash
bash scripts/tests/test_agentic_fallback.sh   # routing, gates, key resolution, budget
python3 scripts/tests/test_openai_agent.py    # tool loop, deny-list, key scrubbing, usage accounting
```

## Safety rails (unconditional — not tunable)

- `test` branch only; never `main`; never `--force`.
- One rebase-and-retry on a rejected push, then give up cleanly.
- The API key is dropped from the child process environment before any
  `run_command` executes, and masked (`***`) in any tool output that
  happens to echo it.
- `git push`/`git commit`/`sudo` are permanently deny-listed inside the
  loop — the shell wrapper, not the model, owns every commit and push.

## Verification (config-knob coverage)

Every env var `agentic_fallback.sh` reads is documented above:
`AGENTIC_FALLBACK`, `AGENTIC_FALLBACK_MODELS`,
`AGENTIC_FALLBACK_DAILY_USD_CAP`, `AGENTIC_MAX_ITERS`,
`AGENTIC_CMD_TIMEOUT_SEC`, `AGENTIC_LEDGER_DIR`, `DEEPSEEK_BASE_URL`,
`MOONSHOT_BASE_URL`, `AGENTIC_ENV_FILE` (test-only override of the `.env`
path, not needed in normal operation). Every knob `openai_agent.py` reads
is documented above: `AGENTIC_PRICE_IN_PER_M`, `AGENTIC_PRICE_OUT_PER_M`,
plus the two `--max-iters`/`--cmd-timeout` CLI flags that
`agentic_fallback.sh` always passes from the env vars of the same name.
The queue-depth overflow lane's own vars (`AGENTIC_OVERFLOW`,
`AGENTIC_OVERFLOW_PRIORITIES`, `AGENTIC_OVERFLOW_MIN_QUEUE_DEPTH`) are
covered in its own section above and by
`scripts/tests/test_agentic_fallback.sh`'s "queue-depth OVERFLOW trigger",
"agentic_overflow_queue_depth", and "agentic_overflow_compare_report"
blocks — the last of these is the canary's before/after comparison, see
the ADR's Rollout Plan.
The all-pools-capped demotion lane's own var (`AGENTIC_EXHAUSTION_DEMOTION`)
is covered in its own section above and by
`scripts/tests/test_agentic_fallback.sh`'s "all-pools-capped DEMOTION
trigger" block and `scripts/tests/test_capacity_router.sh`'s
`route_exhaustion_demote` block.
