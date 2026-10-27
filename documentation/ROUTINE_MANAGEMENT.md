# Cloud Routine Management

> **Status:** policy draft, 2026-09-20. Written after auditing all 14 claude.ai
> routines on the operator's work-org account and disabling every one of them.
> The operator's verdict that prompted it: *"it is useful but costing a lot of
> money, so plan is required."*

A **routine** here means a scheduled cloud agent at `claude.ai/code/routines` —
a cron entry that spawns a full, isolated Claude Code session (CCR) in
Anthropic's cloud with its own git checkout. It is NOT:

- a myAI gateway schedule (`schedules_list` / `schedules_create`)
- a recurring runner task (`recurring_tasks_list`)
- a launchd job (`com.myai.cli-task-runner`, `com.myai.morning-boot`)
- a GitHub Actions `schedule:` trigger

Those four are local or self-hosted and effectively free on the Max plan. A
routine is the ONLY one of the five that bills cloud session time per fire, and
it is therefore the only one that needs a spending policy.

---

## 1. What was actually running (measured 2026-09-20)

| Routine | Cron | Fires/day | Repo | Tools |
|---|---|---|---|---|
| `myAI Fleet Steward (6h)` | `54 */6 * * *` | 4 | `<owner>/<framework-repo>` | Bash, Read, Glob, Grep |
| `<work repo> — daily PR review (never merge)` | `0 22 * * *` | 1 | `<work-org>/<repo>` | Bash, Read, **Write, Edit**, Glob, Grep |
| 11 × `<project> Day N/10` | one-shot, fired June | 0 | — | — |
| `<team hub> association health check` | `9 10,13,16,19,21 * * *` | 0 (disabled) | — | — |

**~5 cloud sessions per day**, every one on `claude-sonnet-5`, every one with
all four MCP connectors attached (monday_com, Atlassian, Canva,
Claude_Code_Remote) whether it needed them or not.

Observed durations, from `list_runs`: the PR-review routine ran 25 s on a quiet night and ~4 min
on a busy one; the Fleet Steward's last fire ran 00:54:42 → 00:58:44, about
4 minutes. The PR reviewer's prompt instructs it to run `npm ci`, `npx tsc --noEmit`,
`npx next lint` and `npx vitest run` **per open PR, per night** — an install and
a full verification suite in a cold cloud container.

That is the shape of the bill: not the cron count, the *work per fire*.

---

## 2. The decision rule

**A routine earns its place only if ALL FIVE are true. If any one fails, it
belongs somewhere else on the list in §3.**

1. **It must run when no human and no local machine is available.** If the
   answer can wait for the next `agent mode`, it is not a routine.
2. **Everything it needs is reachable from the cloud** — git, the GitHub API, an
   attached connector. Not `localhost:3100`, not Docker, not launchd, not a
   gitignored machine-local file.
3. **Its output changes a decision.** Someone reads it and does something
   differently. A report nobody opens is pure spend.
4. **A local hook or session banner cannot already do it for free.**
5. **The value per fire beats the cost per fire** — judged on the work inside
   the run, not the cron frequency.

### The free alternatives to check first

Before creating any routine, confirm none of these already covers it:

| Need | Free local mechanism |
|---|---|
| Ship drift, unshipped commits | `hooks/session/17-schedule-status.sh` (SCHEDULE banner) |
| Backlog well / planner drift | same banner |
| Runner alive, last run time | same banner |
| Stack freshness, RAM, Docker naming | session-start hooks |
| Overnight fleet sweep on a schedule | `com.myai.morning-boot` (launchd, 08:00 Mon–Fri) |
| Cross-repo PR state | `fleet` / `agent mode -resume all` |
| Autonomous work queue | the launchd CLI runner on the free Fable window |

---

## 3. What should NOT be a routine

Each of these is grounded in one of the 14 audited routines.

**Anything the local banner already reports.** The Fleet Steward reported ship
drift, backlog health and runner liveness four times a day. This session's own
startup banner reported all three, for free, at the moment work actually
started:

```
⛔ AUTO-SHIP OFF  config/autoship.off — test is 3 commit(s) ahead of main
⚠ WELL LOW       0 remaining / 376 total backlog items
runner: active · last: 19 Sep 15:37 AEST
```

Four cloud sessions a day to duplicate a free hook is the single largest waste
found in the audit.

**A routine that cannot reach what matters.** The Fleet Steward's own prompt
opens with a long *"WHAT YOU CANNOT REACH"* section — the gateway, the task
queue, the runner, the backlog cursor. It was paying cloud time to explicitly
NOT check the most important things, then reporting "needs a local session".
If the interesting half of a job requires the Mac, run the whole job on the Mac.

**Heavy verification.** The PR-review routine ran a dependency install plus tsc, lint and the full
vitest suite per PR per night. That is a CI job wearing a routine's costume.
Verification belongs in CI, where it is cached, incremental, and triggered by the
change rather than by the clock.

**Write-capable routines on repos nobody is watching.** The daily PR-review routine
carried `Write` and `Edit` in `allowed_tools` and posted PR comments as the
operator's GitHub account nightly. It ran
unnoticed for days — see §4.

**One-shots left behind after firing.** Eleven `<project> Day N/10` routines
(including one whose own name says `DUPLICATE — disabled`) fired in June and
have sat in the list ever since. A fired one-shot is inert but not harmless: it
is list noise that hides the live entries.

**Unbounded connector attachment.** Both live routines carried all four
connectors. A PR reviewer does not need Canva. Attach only what the prompt
actually uses — every connector is extra surface and extra context.

---

## 4. The visibility problem — the real finding

**Routines are per-account/org, and are invisible from a Claude Code session
running under a different profile.**

This is why plan day 2 ("stop the cloud PR reviewer") sat OVERDUE and marked
operator-only for days: every worker-profile session was structurally unable to
see the routine, so it could only ever be described, never acted on. It was
resolved in one session the moment the work happened under
`~/.claude-<master-profile>`, whose config points at the work org.

**Rule: every cloud routine MUST be registered in `config/cloud_routines.md` in
this repo, committed.** The web UI is the source of truth for *state*; the
committed file is the source of truth for *existence*. A routine that is not in
the file is unowned and should be deleted on sight. This is the only mechanism
that makes routines visible from a profile that cannot query them.

Each entry records: trigger id, name, cron, repo, fires/day, tools, connectors,
**owner**, **expiry date**, and one line on why a local mechanism can't do it.

---

## 5. Operational gotchas (measured, not assumed)

These cost real confusion during the 2026-09-20 audit:

- **The API has no delete.** `RemoteTrigger` exposes `list`, `get`, `create`,
  `update`, `run`, `create_webhook_trigger`, `list_runs`, `get_run_log`. An
  agent can disable a routine but can never remove one. **Deletion is web-UI
  only**, at `claude.ai/code/routines`.
- **Disabling does not clear `next_run_at`.** A disabled routine keeps
  displaying a future fire time indefinitely. `enabled` is the authoritative
  field; `next_run_at` on a disabled routine is display residue. Do not read it
  as "still scheduled" and do not re-disable in response to it.
- **Past runs stay `status: "active"` forever.** The PR-review routine had 10+ nightly run
  sessions all reading `active` / `worker_status: idle`. This — not the
  schedule — is what renders as an indicator dot in the UI. Deleting the routine
  is what clears them.
- **`list_runs` silence is not proof.** A fire refused before a session existed
  (paused routine, fire cap, kill switch, failed pre-creation checks) leaves no
  row at all. Check the routine with `get` before concluding it never fired.

---

## 6. Institutional knowledge rescued from the Fleet Steward prompt

The Fleet Steward is being deleted. Its prompt encoded operational history that
exists nowhere else in this repo, recorded here so it survives:

**The 56-task backlog failure mode (August 2026).** The runner finishes work
onto `test`, nothing merges to `main`, and the task queue cannot reconcile —
*because reconciliation only clears when `test == main` exactly*. Work piles up
invisibly. **Ship drift above ~5 commits is the leading indicator.** This is
live as of 2026-09-20: `test` sits 4 ahead of `main` with `config/autoship.off`
in force.

**Malformed backlog lines starve the queue — RE-MEASURED 2026-09-20, and the
August theory is WRONG today.** The prompt claimed 1250 lines with 64 unconsumed
ones failing to parse, as the prime suspect for `queue_topup.sh` reporting
"backlog exhausted" while valid work sat unused. Measured now:

```
non-blank lines      : 488
comment lines (#)    : 112
valid JSON items     : 376     <- matches the banner's "376 total" exactly
GENUINELY MALFORMED  : 0       <- the August defect is gone
```

The 112 "unparseable" lines are `#` comments — the file's own schema header. A
naive `json.loads` per line counts them as corruption, which is almost certainly
how the original figure was produced. **Count comments separately before calling
anything corrupt.**

The real cause of today's `WELL LOW — 0 remaining / 376 total` is that **the
consumed cursor is past the file's content**: the gateway's
`backlog_cursor_get` returns **920** against **376** items, so everything reads
as already-consumed. Note also that `config/.runner_backlog.cursor` is
**obsolete** — the cursor moved into the gateway (task-e9163eb9) and the stale
local file disagrees (775 vs 920). Never diagnose from it. `queue_topup.sh`
already carries a self-heal (~line 432, task-08dbc72f) that lowers a drifted
cursor; check whether it has run before treating this as a defect.

**This is the point of §6.** Rescued knowledge is a hypothesis with a date on
it, not a finding. Nothing re-tests a routine's prompt, so it goes stale
silently. Rescue it, then re-measure before acting on it.

**Read-only by default was right.** Both live routines' prompts ended with hard
rules — never merge, never push to `main`, never push to a PR branch, merging is
always the human's call. Keep that posture in anything that replaces them.

---

## 7. Recommended end state

1. **Delete all 13 remaining routines.** None passes §2. (The PR-review routine was
   already deleted by the operator during the audit.)
2. **Adopt the §2 rule** for anything proposed in future.
3. **Create `config/cloud_routines.md`** and require registration (§4). While
   zero routines exist, the file states that, which is itself the useful signal.
4. **Re-home the one genuinely lost capability.** Deleting the Fleet Steward
   gives up cross-repo PR/drift awareness for the other managed repos
   (e.g. `agentFlow` and `connect`) — the local SCHEDULE banner is this-repo-only. The right
   replacement is a local `fleet` / `agent mode -resume all` pass, not a cloud
   routine: it is free, it can reach the gateway, and it runs when the operator
   is actually there to act on it.
5. **Before ANY new routine:** write its `config/cloud_routines.md` entry first,
   including owner and expiry. If the entry cannot be written honestly, the
   routine should not exist.
