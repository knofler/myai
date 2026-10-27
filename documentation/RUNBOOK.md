# Operator Runbook — recurring gateway/runner failure modes

> Companion to [`OBSERVABILITY.md`](./OBSERVABILITY.md) (Sentry/status/uptime),
> [`BACKUP_RESTORE.md`](./BACKUP_RESTORE.md) (brain/config snapshot+restore),
> and [`MONGO_MIRROR.md`](./MONGO_MIRROR.md) (local mongo mirror + failover
> mechanics). Those docs explain *what the system does*; this doc is the
> **incident checklist** — one numbered, copy-pasteable procedure per failure
> mode, so a recurring incident is executed from a checklist instead of
> re-derived from session-history prose every time. Linked from `CLAUDE.md`
> under "On Session Start".

Every procedure follows the same shape: **Symptom → Verify → Fix → Confirm →
Rollback**. Verify steps are read-only (safe to run any time, including
mid-incident, to confirm you have the right diagnosis before touching
anything). Fix steps are the smallest change that resolves the symptom.

**DEPLOY GUARD applies throughout this doc:** this workspace is a clone —
`docker compose build/up/restart/down` on the shared `myai` gateway stack
(gateway/dashboard/mongo) must only run from the **MASTER checkout**, never
from here (the clone has no real `.env` and will silently rebind to an empty
local mongo, split-brain-ing the fleet queue — LL 2026-07-04). Where a fix
below needs a gateway rebuild, it says so explicitly instead of running it.

---

## 1. Docker VM disk 100% full → local mongo `WT_PANIC` crash-loop

**Symptom:** `myai-mongo` is restarting continuously (hundreds to thousands of
restarts in `docker ps`), gateway health checks flap, and `docker logs
myai-mongo` shows `WT_PANIC: No space left on device`. Real incident
(19 Jul 2026): the Docker VM disk hit 100% (0 B free of 125 GB), and
`myai-mongo` entered a **3,141-restart crash-loop** before it was caught.

**Proactive guard (catches this BEFORE the crash-loop, same idea as
CLAUDE.md's "2 GB RAM ceiling check" / `hooks/session/13-ram-guard.sh`):**
`scripts/docker_vm_disk_snapshot.sh` runs this section's own Verify step
(`docker run --rm alpine df -P /`) on every runner fire (piggybacked in
`cli_task_runner.sh` alongside `pool_capacity_snapshot.sh` /
`mongo_mirror_status_snapshot.sh`) and writes
`state/docker-vm-disk-status.json`. The gateway's
`runtime/src/monitoring/docker-vm-disk-alerter.ts` reads it and pushes a
Telegram + dashboard-bell alert at 80% (warning) and 90% (critical) used —
env-configurable via `MYAI_DOCKER_DISK_ALERT_PCT` /
`MYAI_DOCKER_DISK_ALERT_PCT_CRITICAL` — well before the 100% WT_PANIC
threshold above. The manual procedure below is still the fix once an alert
(or the crash-loop symptom) fires.

### Alert-triage — what a "Docker VM disk" page means, and ruling out a false positive

**What it means:** two severities, both env-configurable on the gateway —
`MYAI_DOCKER_DISK_ALERT_PCT` (default 80, "warning") and
`MYAI_DOCKER_DISK_ALERT_PCT_CRITICAL` (default 90, "critical"). The alert
title says which (`Docker VM disk: warning` / `Docker VM disk: CRITICAL`)
and the body includes the measured `pctUsed`. Delivery is Telegram (when
`TELEGRAM_DEFAULT_CHAT` is configured) **and** a dashboard bell/toast — the
bell always fires even if Telegram isn't set up, so "no Telegram message"
does not mean "no alert". A still-breached reading doesn't re-page every
15-minute check cycle: `MYAI_DOCKER_DISK_ALERT_COOLDOWN_MIN` (default 120
min) dedups same-severity re-alerts, but a warning→critical escalation
always fires immediately, and dropping back under the warn threshold clears
the cooldown so the next breach pages right away. Disable entirely (e.g.
during planned heavy-build work) with `DOCKER_VM_DISK_ALERTS_DISABLED=1` on
the gateway — **MASTER CHECKOUT ONLY** to apply (DEPLOY GUARD).

**Rule out a false positive before touching anything:**

```bash
cat state/docker-vm-disk-status.json | python3 -m json.tool   # the exact artifact the alerter read
docker run --rm alpine df -P /                                 # re-run the same read-only check live, right now
```

Three things would invalidate an alert instead of confirming it — a
delivered alert has already cleared all three, but check them anyway:

1. **Staleness** — the alerter ignores any artifact older than
   `MYAI_DOCKER_DISK_ALERT_STALE_HOURS` (default 6h) and never pages on it.
   Compare the artifact's `generatedAt` against "now"; if it's fresh and
   still shows the same `pctUsed` as the live re-run above, the alert
   reflects current reality, not a stale snapshot.
2. **`available: false`** — the snapshot script sets this when the Docker
   daemon was unreachable at snapshot time (e.g. mid-restart); the alerter
   never fires in that case, so a delivered alert implies `available: true`
   — Docker was genuinely up and genuinely under pressure when it ran.
3. **Sanity of `pctUsed`** — the alerter discards non-numeric or
   out-of-`[0,100]` readings before evaluating thresholds, so a delivered
   alert's `pctUsed` is already a plausible percentage; corroborate it
   against `docker system df` (next section) rather than assuming a bad
   read.

If the live re-run agrees with the artifact and is still at/above the
alert's threshold, it's real — go straight to **Fix** below (the same
`docker builder prune -af && docker image prune -af` remediation the alert
message itself quotes). If the live re-run comes back comfortably under
threshold, pressure already resolved on its own (another session pruned
first, or a large build's layers were cleaned up) — no action needed, just
note it.

### Verify (read-only)

```bash
docker system df                       # TOTAL/RECLAIMABLE per type — look for high "Build Cache" + "Images" reclaimable
docker ps --format '{{.Names}}\t{{.Status}}' | grep myai-mongo   # restart count is in the Status column
docker logs --tail 50 myai-mongo | grep -i panic                # confirm WT_PANIC, not some other crash
df -h /                                 # host disk (Docker Desktop VM disk is separate — see next line)
docker run --rm alpine df -h /          # disk INSIDE the Docker VM — this is the one that actually fills
```

If `docker system df` shows large `RECLAIMABLE` under **Build Cache** and
**Images**, and the in-VM `df -h /` is near 100%, this is the failure mode.

### Fix

Reclaim space **without touching volumes** (mongo's data volume must survive):

```bash
docker builder prune -af      # build cache — safe, rebuildable from Dockerfiles
docker image prune -af        # dangling + unused images — safe, re-pullable/rebuildable
# do NOT run `docker system prune --volumes` or `docker volume prune` here —
# that would delete myai-mongo-data and any other stack's live data.
```

The 19 Jul incident reclaimed 66 GB this way (disk 100%→57%) with zero data
loss. If space is still critically low after both prunes, check for a
runaway log/volume (`docker system df -v` to see per-volume size) before
considering anything more destructive — and if it's the shared `myai` stack,
that decision belongs to the **master checkout**, not this workspace.

### Confirm

```bash
docker run --rm alpine df -h /                          # VM disk back under ~80%
docker ps --format '{{.Names}}\t{{.Status}}' | grep myai-mongo   # "Up X" not "Restarting"
docker exec myai-mongo mongosh --eval 'db.runCommand({ping:1})' --quiet 2>&1 | grep -q 'ok: 1' && echo "mongo OK"   # mongosh 2.x prints `{ ok: 1 }`
```

If the gateway container was also affected (restarted mid-panic, picked up a
build from before the latest `runtime/` merge), it now needs the stale-image
check in **§2** — a disk-full incident and a stale-image incident often land
in the same session.

### Rollback

Nothing to roll back — `builder prune`/`image prune` only removes rebuildable
cache and unused images; no volumes, running containers, or code were
touched. If mongo still won't come up after reclaiming space and confirming
disk headroom, the failure is no longer disk-driven — stop and escalate
(don't keep pruning).

---

## 2. Stale gateway image after a `runtime/` change

**Symptom:** code merged into `runtime/` (or `dashboard/`) isn't reflected in
the running gateway's behavior — new MCP tools 404, a bugfix doesn't take,
`/health/deep` reports an old build. Recorded repeatedly across July sessions
(office→home machine switches, post-merge sessions that forgot the rebuild
step) — "stale gateway image" is one of the most frequently recurring notes
in the session archive.

### Verify (read-only)

```bash
docker inspect --format='{{.Image}}' myai-gateway | xargs docker image inspect --format='{{.Created}}'   # IMAGE build timestamp — the honest signal
git log -1 --format='%cI %h %s' -- runtime/                 # latest commit touching runtime/
git log -1 --format='%cI %h %s' -- dashboard/                # same for dashboard/, if relevant
```

If the latest `runtime/`-touching commit's timestamp is **after** the
**image build** timestamp, the running image predates that code — the
gateway is stale. Do NOT use the container's own `Created` timestamp
(`docker inspect --format='{{.Created}}' myai-gateway`) as the age signal: a
plain `docker compose up -d` recreates the container from whatever image
already exists, so a container recreated today from a July image looks
fresh while serving stale code. (Real example, 26 Jul 2026: `runtime/` had a
commit at `2026-07-26T09:27:52Z` newer than the running gateway's build —
i.e. the gateway was serving code from before that merge.)

You can also check the gateway's self-reported health for corroboration —
**on port 3200** (`GATEWAY_HTTP_PORT`, the Express HTTP API; port 3100 is
the MCP transport, whose own minimal `/health` returns
`{"server":"myai-framework"}` and which has NO `/health/deep` route at all,
so `curl localhost:3100/health/deep` 404s even on a perfectly fresh gateway
— do not read that 404 as staleness, a July session made exactly that
misdiagnosis):

```bash
curl -sf http://localhost:3200/health/deep | python3 -m json.tool
```

A `404` **on 3200** (curl prints nothing, `json.tool` errors `Expecting
value`) is corroborating evidence: it means the running image predates the
commit that added a route that `git grep` confirms exists in the current
`runtime/src/core/server.ts`. A healthy fresh gateway returns
`"status": "healthy"` JSON here.

### Fix — MASTER CHECKOUT ONLY

This is a deploy action and must not be run from a workspace clone (DEPLOY
GUARD, top of this doc). From the **master `ai_management` checkout**:

```bash
docker compose build gateway && docker compose up -d gateway
# add `dashboard` to both commands too if dashboard/ also changed
```

If you are in a workspace clone and hit this failure mode, the correct action
is to **say so in your result/handoff** ("gateway image is stale, needs a
master-checkout rebuild") rather than run the compose commands yourself.

### Confirm

```bash
docker inspect --format='{{.Image}}' myai-gateway | xargs docker image inspect --format='{{.Created}}'   # image build now newer than the runtime/ commit that triggered the fix
curl -sf http://localhost:3200/health/deep | python3 -m json.tool   # "healthy", no unexpected `degraded` components
```

### Rollback

If the rebuilt image regresses something, redeploy the last known-good
`runtime/`/`dashboard/` commit from the master checkout:

```bash
git log --oneline -5 -- runtime/     # find the last good SHA
git checkout <good-sha> -- runtime/  # or `git revert` the bad commit properly
docker compose build gateway && docker compose up -d gateway
```

Prefer a proper `git revert` on the offending commit over a bare
`checkout -- path` when the bad change has already been pushed — a revert
keeps history honest and is what the next machine's `git pull` expects.

---

## 3. Atlas unreachable → `MYAI_DB_FAILOVER=local`

**Symptom:** gateway can't reach the Atlas cluster (`cluster0.example`) at
boot — connection errors in gateway logs, `/health/deep` reports `mongodb:
unhealthy`, MCP tools that touch memory/registry/tasks start failing.

### Verify (read-only)

```bash
curl -sf http://localhost:3200/health/deep | python3 -m json.tool | grep -A5 '"mongodb"'   # 3200 = Express API port; 3100 is the MCP transport (no /health/deep)
docker logs --tail 100 myai-gateway | grep -iE 'mongo|atlas|ECONNREFUSED|ENOTFOUND|timed? ?out'
# confirm it's genuinely Atlas, not local mongo, that's unreachable:
docker exec myai-mongo mongosh --eval 'db.runCommand({ping:1})' --quiet
```

### Fix

`MYAI_DB_FAILOVER=local` is an **explicit, opt-in, boot-time, READ-ONLY**
degraded mode — never a silent swap (2026-07-04 split-brain lesson). Full
mechanics in [`MONGO_MIRROR.md`](./MONGO_MIRROR.md#read-side-local-first-failover-2026-07-24--myai_db_failover=local).

1. Confirm you have a reasonably fresh local mirror (failover is only as
   fresh as the last successful mirror run):
   ```bash
   myai mirror --schedule-status      # or: cat ~/.myai/mongo-mirror.last
   ```
   If it's stale or was never run, run one now if Atlas is reachable enough
   to source from, or accept that failover will serve stale reads.
2. Set the failover flag in `AI/.env` next to `MONGODB_URI`:
   ```bash
   MYAI_DB_FAILOVER=local
   # optional: MYAI_DB_FAILOVER_URI=<explicit mirror URI> (defaults to the
   # compose local mongo service host with LOCAL_MONGO_USER/LOCAL_MONGO_PASS)
   ```
3. Restart the gateway so it picks up the new env — **MASTER CHECKOUT ONLY**
   (DEPLOY GUARD):
   ```bash
   docker compose up -d gateway
   ```

### Confirm

```bash
curl -sf http://localhost:3200/health/deep | python3 -m json.tool | grep -A8 '"mongodb"'
# expect: "status": "degraded", details.failover.active: true, with primaryUriHost/failoverUriHost/reason/activatedAt
docker logs --tail 50 myai-gateway | grep -i failover   # activation is logged at error level, loudly, by design
```

The dashboard `/status` page and the `health_status` MCP tool both surface
the same failover state — check either as a second confirmation source.
While failover is active, writes are rejected with `DbReadOnlyError` (by
design) — don't mistake that for a new bug.

### Rollback

Failover **never flips back automatically mid-process** (by design — see
MONGO_MIRROR.md). Once Atlas is reachable again:

```bash
# remove or comment out MYAI_DB_FAILOVER in AI/.env, then — MASTER CHECKOUT ONLY:
docker compose up -d gateway
curl -sf http://localhost:3200/health/deep | python3 -m json.tool | grep -A5 '"mongodb"'  # "status": "up", no failover block
```

If Atlas came back mid-session and you need failover off without a full
restart cycle delay, there is no live re-connect swap (explicitly out of
scope, see MONGO_MIRROR.md's "Scope note") — the gateway restart above is the
only exit path.

---

## 4. Blocked/review task pileups → `reconcile_review_tasks.sh`

**Symptom:** the fleet task queue (dashboard `/fleet`, `tasks_list`) shows a
growing pile of tasks stuck in `review` or `blocked` that were actually
already shipped — the CLI runner flips a task to `review` on push but never
back to `done`, and `blocked` tasks (resource-cap kill, trust-dialog death)
can still have been shipped later by a different session. Left unreconciled,
every `/fleet` pass wastes time re-triaging phantom entries.

### Verify (read-only)

```bash
bash scripts/reconcile_review_tasks.sh --dry-run --no-fetch
```

This prints, per repo, whether it's indeterminate (no resolvable host path),
`UNSHIPPED (test ahead by N)` with a per-task ancestor check, or the
whole-repo fast path (`test`==`main` → everything phantom), and ends with a
`flipped:0 left-in-place:N skipped:N (dry-run, nothing flipped)` summary —
dry-run never writes anything, so it's safe to run any time to see the real
state before deciding whether to reconcile for real.

### Fix

```bash
bash scripts/reconcile_review_tasks.sh              # sweeps every repo with review/blocked tasks
bash scripts/reconcile_review_tasks.sh --repo ai_management   # scope to one repo
```

It is fail-safe by construction: it only flips a task to `done` when it can
*prove* the work is on `main` — either the whole repo has nothing ahead of
`main` (`test`==`main`), or that specific task's stamped commit SHA(s) are an
ancestor of `origin/main`. Squash/rebase merges (new SHAs) and unstamped
tasks are left in place for a human — it never ships, merges, or touches git
history, only the task board.

This already runs automatically (throttled ≤1/hr) in the CLI runner, `/fleet`
scan, `agent mode`, and `wrap up` — running it manually is for when a pileup
is suspected between those automatic passes, or to scope a fix to one repo.

### Confirm

```bash
bash scripts/reconcile_review_tasks.sh --dry-run --no-fetch   # re-run dry-run; flipped tasks no longer appear as candidates
```

Cross-check the dashboard `/fleet` page or `tasks_list` (filtered to
`status=review,blocked`) to confirm the pile shrank by the expected count.

### Rollback

Because the flip is provably-safe (git-ancestor checked), there is normally
nothing to roll back. If a task was flipped in error (e.g. the ancestor check
raced a force-push that rewrote history after the check), restore it via the
gateway's `tasks_update` MCP tool / REST `PATCH` with the task ID and the
correct prior status — this script never deletes task history, only the
status field, so the task record itself is intact to correct.

---

## 5. Actions-billing-blocked merge path → `scripts/local-ci.sh`

**Symptom:** a PR's required checks (build, Security Audit, Ready to Merge,
Enforce branch policy) never fire — GitHub Actions runs show instant
2s/0-step "startup failure", or no run appears at all for the pushed SHA
within a couple of minutes. Cause: the shared personal-account Actions
free-tier minutes are exhausted for the billing period (recurring — see
`AI_RULES.md` §GH-ACTIONS-BILLING notes across the July archive).

### Verify (read-only)

```bash
gh run list --branch test --limit 5                          # look for "startup_failure" or nothing for the latest SHA
gh api repos/<owner>/<repo>/actions/permissions        # confirm Actions is enabled (billing block ≠ disabled, just can't run)
./scripts/local-ci.sh --dry-run                                # run the real local gates, post NOTHING — see what would pass/fail/skip
```

`local-ci.sh --dry-run` runs the actual required-check equivalents (tsc,
tests, build) in Docker per `lib/ci_check_map.sh` and prints per-check
PASS/FAIL/skip without touching the PR — use this to confirm the code is
genuinely green before doing anything that posts a status or bypasses a gate.

### Fix

Only take this path when Actions genuinely can't run (billing/outage) — never
to bypass a real failing check.

```bash
./scripts/local-ci.sh                     # runs the real gates, posts `success` ONLY for checks that actually passed
# add --trust-build ONLY if you've manually verified the build yourself already
```

If the required check is still `BLOCKED` on the PR after local-ci posts green
(app-pinned check, Actions still can't run it) and branch protection allows
admin bypass (`enforce_admins: false`):

```bash
gh pr merge <PR#> --merge --admin
```

Guardrails (non-negotiable, from `CLAUDE.md`'s `ship it` keyword protocol):
run the real gates locally first; never post/merge over a check that didn't
genuinely pass; bypass only for the billing/outage condition, never a
genuinely failing test/tsc/build; announce the bypass every time; `--admin`
only works where branch protection permits it — if GitHub rejects it, report
and wait rather than forcing further.

### Confirm

```bash
gh pr view <PR#> --json state,mergedAt,mergeCommit           # state: MERGED
gh api repos/<owner>/<repo>/commits/main/status | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["state"])'
```

### Rollback

If a local-ci-posted status or admin-merge later turns out to have covered a
real regression (a check that should have failed didn't get exercised
locally the same way Actions would have):

```bash
git revert -m 1 <merge-commit-sha>    # revert the merge on main, -m 1 = keep main's parent line
git push origin main                  # only after user confirmation — this touches main
```

Once GitHub Actions billing/outage is resolved, stop using the local-ci
fallback for new PRs and let Actions run required checks normally again —
this path is a stopgap, not a standing replacement.

### Same root cause: Docs Site (github-pages) workflow — moved to self-hosted (2026-09-15)

The billing block also killed the `Docs Site` workflow (`.github/workflows/
docs.yml`, push-to-main): five consecutive merges (#440/#443/#444/#453/#454)
got a red X from a job that died in 4-6s before its first step. Two knock-on
effects made this worse than cosmetic: (1) each failed run still registered a
**github-pages deployment** against the merge sha ~1s after merge — a decoy
that `scripts/verify_deployment.sh` matched instead of the real Vercel
Production deploy landing ~74s later (helper fix tracked separately as
task-e0af7e38); (2) a permanently-red check on main trains sessions and
operators to skim past red, which is how a genuine failure gets waved through.

**Decision taken: option (a) — keep the docs site, move the job to
`runs-on: [self-hosted, myai-local]`** (the same pattern as merge-gate /
script-unit-tests / fleet-smoke / dependency-scan / dashboard-typecheck).
The site is still wanted: the README badge and docs section link to
<https://<owner>.github.io/<repo>/>, and Vercel serves the dashboard,
not these docs. Retiring it (option b) was rejected for that reason;
`continue-on-error` was never an option — it hides the signal. The runner
image bakes Node 22, which is all `scripts/build_docs.mjs` needs (zero
dependencies, no npm install), so `setup-node` was dropped. The check is not
required on any branch and fires only on push-to-main, so a runner outage
delays a docs deploy but never blocks a merge (no new mode-9 exposure).
Revert path once hosted billing is fixed: restore `runs-on: ubuntu-latest`
and re-add `actions/setup-node` (noted in the workflow header).

---

## 6. Pool-capacity ledger drift → `pool_capacity_drift_check.sh` alert

**Symptom:** a Telegram/dashboard-bell alert titled `Pool-capacity drift:
warning` or `Pool-capacity drift: CRITICAL`. The capability×cost×
availability router (task-21dc2746) and the API-credit reserve
(task-874364a3) both make routing/throttling decisions off
`state/pool-capacity.json`'s claude-<runner-profile> `dailySpentTokens`/
`weeklySpentTokens`, which come from an **incremental** ledger
(`scripts/lib/session_tokens.py` snapshot/delta, plain integer files at
`~/.ai-cli-runner/pacing/tok-<day|week>`, incremented on every runner fire).
`scripts/lib/pool_capacity_drift.py` independently re-sums
`message.usage.output_tokens` straight from the Claude Code transcripts for
the same day/week window and compares the two — this alert means the two
independently-computed numbers disagree beyond tolerance, which is the
signal that the incremental ledger may have silently drifted from reality
(a missed transcript, a snapshot marker lost across a runner restart, a
`CLAUDE_CONFIG_DIR` mismatch).

### Verify (read-only) — confirm it's not a false positive

```bash
cat state/pool-capacity-drift-status.json | python3 -m json.tool          # the exact artifact the alerter read
tail -20 ~/.ai-cli-runner/pool-capacity-drift.log                          # durable history of every run (OK and DRIFT)
python3 scripts/lib/pool_capacity_drift.py state/pool-capacity.json "${CLAUDE_CONFIG_DIR:-$HOME/.claude-<runner-profile>}" 10 5000   # re-run the check live, right now
```

Four things to check before treating a delivered alert as actionable —
each one is already double-checked by the alerter/script itself, but verify
directly against the artifact rather than trusting the alert text alone:

1. **Staleness** — the alerter ignores any artifact older than
   `MYAI_POOL_DRIFT_ALERT_STALE_HOURS` (default 6h). Compare the artifact's
   `checkedAt` against "now"; a delivered alert implies the reading was
   fresh when it fired, but re-running live (above) confirms it's still
   true right now.
2. **`skipped` must be `null`** — a non-null `skipped` (`no-snapshot`,
   `<pool>-pool-missing`, `bad-generatedAt`) means the check couldn't
   even run and never alerts; a delivered alert always has `skipped: null`.
3. **Double-gated tolerance** — a window only shows `DRIFT` when **both**
   the absolute diff clears `tolFloor` (default 5000 tokens) **and** the
   relative diff clears `tolPct` (default 10%, computed against actual
   usage). This is deliberately sized above one in-flight session's
   not-yet-charged tokens, so a delivered `DRIFT` has already cleared real
   noise — check each window's `diff`/`diffPct` in the artifact to see the
   actual margin, not just the pass/fail label.
4. **Severity = how systemic it is** — a single window (`day` OR `week`)
   drifting is `warning` and can be a session straddling a window boundary
   (e.g. a session spanning Sydney midnight) that self-resolves as the
   window rolls forward on the next runner fire. **Both** windows drifting
   at once is `critical` — day and week share no boundary, so simultaneous
   disagreement on both points at a real ledger bug, not timing.

If the live re-run still reports `DRIFT` with a similar magnitude, treat it
as real and move to **Fix**. If the live re-run now reports `OK` (or the
artifact's window has since rolled), the drift was the timing case in point
4 and self-resolved — note it, no action needed.

### Fix

This is a monitoring self-check, **not** an auto-corrector by design —
neither `pool_capacity_drift.py` nor its wrapper ever rewrite
`state/pool-capacity.json` or the pacing ledger; a second, possibly-also-
buggy computation "fixing" the first would be worse than a human looking at
it. Root-cause first, using the causes named in the script's own header
comment:

```bash
# 1. sanity-check the pacing ledger files the router/reserve actually read
cat ~/.ai-cli-runner/pacing/tok-$(TZ=Australia/Sydney date +%Y%m%d)     # today's recorded total
cat ~/.ai-cli-runner/pacing/tok-$(TZ=Australia/Sydney date +%G-W%V)     # this week's recorded total

# 2. a runner restart mid-session can lose a snapshot marker — check for one around the drift window
ls -lt ~/.ai-cli-runner/logs/ | head -10

# 3. confirm the config dir the check used matches what the runner actually uses (default ~/.claude-<runner-profile>)
echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude-<runner-profile>}"
ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude-<runner-profile>}"/projects/**/*.jsonl 2>/dev/null | wc -l   # transcripts present/readable at all?
```

If a persistent, confirmed root cause turns up (missed transcript, wrong
`CLAUDE_CONFIG_DIR`, lost snapshot marker), the real fix is in the
ledger-writer code path (`scripts/lib/session_tokens.py` /
`cli_task_runner.sh`'s `pace_add_tokens`) — file a task rather than
hand-editing the ledger. A one-off value correction is a **last resort**,
only behind a confirmed root cause (not just "the two numbers disagree" —
either side could be the wrong one):

```bash
echo <confirmed-correct-total> > ~/.ai-cli-runner/pacing/tok-$(TZ=Australia/Sydney date +%Y%m%d)
```

Disable the alert entirely (e.g. during a known ledger migration) with
`POOL_CAPACITY_DRIFT_ALERTS_DISABLED=1` on the gateway — **MASTER CHECKOUT
ONLY** to apply (DEPLOY GUARD).

### Confirm

```bash
python3 scripts/lib/pool_capacity_drift.py state/pool-capacity.json "${CLAUDE_CONFIG_DIR:-$HOME/.claude-<runner-profile>}" 10 5000
# both "day" and "week" print OK, or a window that's still DRIFT is the known transient from Verify step 4
```

### Rollback

Nothing to roll back for the check itself — it's read-only. If a ledger
value was hand-edited per the Fix step's last resort and turns out wrong,
the pacing files are plain integers: re-derive the correct total the same
way the drift check does (sum `output_tokens` across transcripts in the
window) and overwrite again. There's no retroactive fix for router/reserve
decisions already made while the ledger was wrong — only for the ledger
value going forward.

---

### 2026-09-08 — what the ledger measures changed (read this before the steps above)

The first CRITICAL alert (28% day / 45% week, 2026-09-08T08:19Z) was **not a
bookkeeping fault**. The two numbers measured different things by design:
`session_tokens.py delta` attributes tokens to ONE runner fire, so
`tok-<day|week>` only ever held **runner** spend, while the drift check summed
**every** transcript in the profile — and interactive claude-<runner-profile> sessions draw
on the same Team pool. The "drift" was the size of the blind spot the router
and the API-credit reserve had.

**Model since 2026-09-08 (PR #442):** `tok-<day|week>` is the **pool** ledger.

- `session_tokens.py reconcile <cfg> <ledger>` raises `tok-<day>`/`tok-<week>` to
  the transcript-derived pool total for the Sydney window, **minus**
  `apicredit-tok-<key>` (the API-key lane is billed to API credit, not the pool;
  `pace_add_apicredit_tokens` writes that ledger after each metered run).
  **Monotonic** — it never lowers a ledger — and idempotent. Audit sidecar:
  `tok-<key>.reconcile.json` (recordedBefore / transcriptTotal /
  apicreditExcluded / poolActual / added).
- It runs (a) in `cli_task_runner.sh` right before every `pace_fire_decision`
  (`pace_reconcile_pool`, skip with `RUNNER_RECONCILE_POOL=off`), (b) at the top
  of `pool_capacity_snapshot.sh` (skip with `POOL_RECONCILE=off`), and (c)
  `pool_capacity_drift_check.sh` refreshes the snapshot before comparing unless a
  fixture `POOL_CAPACITY_OUT` is supplied or `POOL_CAPACITY_DRIFT_REFRESH=off`.
- **What DRIFT means now:** the ledger could not be brought up to what the
  transcripts show (unreadable transcripts, wrong `CLAUDE_CONFIG_DIR`, a failed
  ledger write) — or the ledger sits **above** the transcripts (pruned
  transcript files, or a double-charge bug in `pace_add_tokens`). Both are real
  faults; neither is "interactive work happened today".
- Runner-only attribution is unchanged for per-task cost (`session_tokens.py
  delta` around each fire) — only the pool totals gained the interactive share.

Tests: `scripts/tests/test_session_tokens_reconcile.sh` (raise / monotonic /
idempotent / API-key exclusion / clamp / missing dir) alongside
`test_pool_capacity_drift_check.sh`.

## 7. `myai` MCP "Failed to reconnect" in Claude sessions → empty `GATEWAY_LOCAL_TOKEN`

**Status: FIXED AT THE ROOT (task-35c9e181).** `.mcp.json`'s myai server used
to be `"type": "http"` with header `x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}`.
Claude Code substitutes `${VAR}` from **its own launch environment** — it never
reads this repo's `.env`. If the shell that started `claude` hadn't exported
`GATEWAY_LOCAL_TOKEN`, the header went out **blank**, the gateway rejected the
MCP handshake with `{"error":"unauthorized"}`, myai never connected, and all
134 tools (every `brain_*`) silently vanished — with nothing surfacing it, so
a whole session could run on file-reads/grep instead of `brain_delta` and
nobody would notice. The old workaround (a manual `~/.zshrc` loader, one Mac
at a time) is retired — this section now documents the permanent fix and how
to confirm it's working.

**The fix:** `.mcp.json`'s myai entry is now a **command-type stdio wrapper**
(`scripts/lib/mcp_myai_stdio.sh`, or `AI/scripts/lib/mcp_myai_stdio.sh` in a
managed repo) instead of a direct HTTP entry:

```json
"myai": {
  "command": "bash",
  "args": ["${CLAUDE_PROJECT_DIR}/scripts/lib/mcp_myai_stdio.sh"]
}
```

The wrapper sources `scripts/lib/gateway.sh`, which resolves
`GATEWAY_LOCAL_TOKEN` by reading **this repo's `.env`/`AI/.env` straight off
disk** (falling back to the process env if already set) — completely
independent of whatever environment Claude Code was launched with. It then
execs `npx -y mcp-remote <gateway-url> --header "x-gateway-local-token:<resolved>"`,
passing the real value as a literal argument, so no `${VAR}` substitution ever
has to happen inside Claude Code's process. This self-serves on a fresh
machine or a freshly cloned managed repo — no per-Mac shell setup required.

**Regression guard:** `hooks/session/24-myai-mcp-health.sh` runs on every
session start, replicates this same handshake, and prints a **loud red
warning** (not a silent no-op) if the wrapper is missing/non-executable or the
gateway rejects the token — so this can't quietly regress again.

### Verify (read-only)

```bash
# 1. gateway is actually up? (rules out a real container problem)
docker compose ps | grep gateway            # expect: Up ... (healthy)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/health   # expect 200

# 2. does the wrapper resolve a real token, independent of this shell's env?
env -u GATEWAY_LOCAL_TOKEN bash -c '. scripts/lib/gateway.sh; echo "${GATEWAY_LOCAL_TOKEN:0:12}..."'
# managed repo: '. AI/scripts/lib/gateway.sh; ...'  — not <EMPTY>, even with no shell export

# 3. prove the resolved token is accepted by the gateway
curl -s -X POST http://localhost:3100/mcp -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -H "x-gateway-local-token: $(grep -E '^GATEWAY_LOCAL_TOKEN=' .env | cut -d= -f2-)" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}'
# real initialize result => good. {"error":"unauthorized"} => token in .env doesn't match the running gateway
```

### If it's still broken

- `mcp_myai_stdio.sh: gateway.sh not found next to this script` — the repo
  layout is off (wrapper and `gateway.sh` must sit side-by-side in
  `scripts/lib/` or `AI/scripts/lib/`); re-sync via `myai mcp repo`.
- Gateway rejects with 401/403 even with the right-looking token — the
  running gateway's `GATEWAY_LOCAL_TOKEN` (docker-compose/.env on the
  container) doesn't match the repo `.env` this machine reads; rotate/align
  them (`scripts/myai_rotate_keys.sh`) or rebuild the gateway.
- `npx mcp-remote` fails outright — no network for the on-demand `npx`
  fetch (same requirement as the context7/shadcn-ui/playwright/docker
  entries already in `.mcp.json`); check connectivity or pre-warm the npx
  cache.
- Session-start hook `24-myai-mcp-health.sh` stayed silent on a real
  failure — that's a bug in the hook itself; it's meant to be loud, never
  quiet, on any of the above.

### Confirm

```bash
# in a freshly launched Claude session:
/mcp   # → myai shows connected, tool count > 0 (brain_*, tasks_*, recall_session, …)
```

### Rollback

Revert `.mcp.json` / `templates/mcp.json`'s myai entry to the old
`"type": "http"` + header shape, and remove
`hooks/session/24-myai-mcp-health.sh` from `.claude/settings.json`. Not
recommended — that's the exact shape that caused this P0.

---

## 8. Dropbox stale tree → `pull --ff-only` blocked / files you never touched show modified

**Symptom:** on session boot, one or both of:

- `git pull --ff-only` **aborts** with `error: The following untracked working
  tree files would be overwritten by merge` (and/or `Your local changes to the
  following files would be overwritten`), listing files you never touched this
  session, while `git status` shows the branch many commits behind.
- `git status` shows `M`/`D` on tracked files you did not edit — sometimes
  minutes after a clean boot (files can vanish or revert mid-session).

**Mechanism (2026-09-11, atom `ed3e615a`):** both Macs' checkouts of this repo
live in the **same Dropbox folder**. `.git` is Dropbox-ignored (AI_RULES §12)
so history never syncs — but **working files do**. A Mac that sits N commits
behind holds OLD file contents in its working tree, and Dropbox replays them
over the up-to-date Mac's files as spurious modifications and untracked
collisions. Cleaning up HERE does not fix the source: the stale Mac keeps
re-uploading yesterday's files **until it pulls**.

**Why this mode is urgent — the silent-failure trap:** the pull ABORTS. An
agent that shrugs and moves on **boots on stale code without any further
error** — on 2026-09-14 that would have been 30 commits behind. Never skip the
pull; run this procedure instead. Occurrences: 2026-09-11 (×3, incl. two
mid-session file-overwrite events and the first blocked pull), 2026-09-14 (×2,
one blocking a 30-commit pull against 8 untracked collisions). The recipe
below is the one that worked, unchanged, both times it blocked a pull.

Substitute your branch for `test` below if you're on something else
(`BR=test` is the common case — it's the boot/pull branch).

### Verify (read-only) — prove the reset would be lossless

```bash
BR=test
git fetch origin

# 1. tracked files: an EMPTY diff means every tracked file already matches
#    origin — the "local changes" git warns about are Dropbox echoes, not work.
git diff --name-only "origin/$BR"

# 2. untracked collisions: byte-compare each against origin's copy.
git ls-files --others --exclude-standard | while IFS= read -r f; do
  if git cat-file -e "origin/$BR:$f" 2>/dev/null; then
    a=$(shasum -a 256 "$f" | cut -d' ' -f1)
    b=$(git show "origin/$BR:$f" | shasum -a 256 | cut -d' ' -f1)
    [ "$a" = "$b" ] && echo "IDENTICAL  $f" || echo "DIFFERS    $f"
  else
    echo "LOCAL-ONLY $f"    # no counterpart on origin — not a collision
  fi
done
```

Read the output before touching anything:

- **All `IDENTICAL` + step 1 empty** → the reset in Fix is provably lossless.
- **Any `DIFFERS`** → decide per file which side is newer (`ls -l "$f"` vs
  `git log -1 --format=%ci "origin/$BR" -- "$f"`) **before** Fix step 1. On
  2026-09-14 exactly one of nine differed — `state/runner-repo-staleness.json`,
  newer locally — and it was preserved and committed (`1251c1a6`); everything
  else was a stale echo.
- **`LOCAL-ONLY` files** are untouched by this procedure (nothing below
  deletes them) — leave them alone.
- **Can't tell which side of a `DIFFERS` file is newer?** Don't guess:
  `git stash push -u -m "dropbox stale tree $(date +%F)"` keeps everything
  recoverable, then pull (this was the second-occurrence fix; the stash
  `<host> stale Dropbox tree 2026-09-11` was retained for exactly this
  reason). If other sessions may share the stash stack, capture your entry's
  SHA immediately (`git stash list --format='%H %gs'`) and later `apply` that
  SHA, never blind `pop`.

### Fix

1. **Preserve every `DIFFERS` file that is genuinely newer locally** (skip if
   there were none):
   ```bash
   cp "state/some-differing-file.json" /tmp/preserve-some-differing-file.json   # per file
   # (the 2026-09-14 example file, state/runner-repo-staleness.json, is no
   # longer tracked — per-host by name since task-1eba9e51)
   ```
2. **Reset tracked files** to what origin (and, per Verify step 1, the local
   history) already has:
   ```bash
   git checkout -- .
   ```
3. **Remove the byte-identical untracked collisions** so the merge can write
   them — targeted, from the `IDENTICAL` list only (do NOT reach for a blanket
   `git clean -fd`, which would also take the `LOCAL-ONLY` files):
   ```bash
   git ls-files --others --exclude-standard | while IFS= read -r f; do
     git cat-file -e "origin/$BR:$f" 2>/dev/null || continue
     [ "$(shasum -a 256 "$f" | cut -d' ' -f1)" = "$(git show "origin/$BR:$f" | shasum -a 256 | cut -d' ' -f1)" ] && rm -v "$f"
   done
   ```
4. **Pull:**
   ```bash
   git pull --ff-only origin "$BR"
   ```
5. **Restore the preserved files** from step 1 and, if they belong in git,
   commit them (2026-09-14: `chore(state): refresh runner staleness cache` →
   `1251c1a6`).

### Confirm

```bash
git status --porcelain        # empty (bar files you preserved in step 5)
git log --oneline -1 HEAD "origin/$BR"   # same SHA — you are no longer behind
```

Then continue the boot **on the pulled code**. If containers were built from
the pre-pull tree, remember the 2026-09-14 lesson: staleness can be PARTIAL —
prove a rebuild by grepping bundle CONTENT for a string the new commits
introduce, never by timestamps or "it restarted".

### Rollback

Every path above is recoverable: step-1 copies live in `/tmp`, the stash
variant is explicitly recoverable by tag/SHA, and `git checkout -- .` only
discarded contents proven byte-identical to origin in Verify. If you ran the
stash variant and need the old tree back: `git stash apply <sha>`.

### Fixing the SOURCE (or it happens again next boot)

This procedure heals the victim Mac only. The stale Mac keeps re-uploading
old files until **it** pulls — so on boot on ANY Mac: `git status` FIRST;
`M`/`D` on files you didn't touch is Dropbox, and the fix starts at Verify
above, never with an improvised `reset --hard`. The durable fleet fix
(working trees out of the shared Dropbox sync path, not just `.git`) has no
shipped mechanism yet — until then, expect a recurrence after any session
where one Mac ends the day unpulled.

---

## 9. Self-hosted runner offline → required checks queue serially (one left) or block every PR (none left)

**Symptom:** required checks on a PR sit `queued` for minutes, each starting
only after the previous one finishes (on 2026-09-14 `Enforce branch policy`
sat queued behind `Static lint`), or — worse — never start at all. Hosted
Actions is billing-blocked (mode 5), so the self-hosted pool is the ONLY path
to a green required check: with one runner offline the pool degrades to serial
single-runner throughput; with ALL runners offline every PR is blocked exactly
as the billing block did.

**Pool semantics (why "one offline" is degraded, not down):** every workflow
selects `runs-on: [self-hosted, myai-local]`. `myai-local` is the POOL label
carried by every registered runner; the runner NAME is the machine identity
(`myai-local` = legacy name on the first runner host, `myai-<hostname>` elsewhere — see
`scripts/runner_selfhosted.sh` header). Jobs land on whichever labelled runner
is free, so losing one machine halves throughput but changes nothing else.
Corollary from the 2026-09 archive: with two runners the SAME job can pass on
one machine and fail on the other (environment skew) — a check that flips
between re-runs is a runner-skew signal, not flakiness to shrug at.

**SPOF posture (explicit, so nobody re-litigates it mid-incident):** the fleet
ACCEPTS single-runner operation as a degraded-but-working mode — serial checks
are slow, not broken, and no action is *required* beyond restoring the second
runner when convenient. What the fleet does NOT accept is zero runners, and it
does not accept a runner left offline *silently*: if you find one offline,
either restore it (Fix below) or record it as a known outage in the handoff.

**Known root causes (both seen in production):**

1. **The Mac slept.** Lid close / idle sleep kills the runner container's
   connection to GitHub. Durable fix shipped 2026-09-12: the `sleep_guard`
   root LaunchDaemon keeps `disablesleep 1` on AC power, checked every 60s
   (`scripts/sleep_guard.sh --install-daemon`, once per machine). Since
   2026-10-21 it lets the Mac sleep on BATTERY (since 2026-10-23 it just sets
   `disablesleep 0` on battery — no lid detection) — a runner on battery in a bag going offline is expected; plug in, or
   `sudo scripts/sleep_guard.sh --stay-awake 2h`.
2. **`RUNNER_NAME` collision.** `entrypoint.sh` registers with
   `config.sh --replace`, so a second machine using the SAME name silently
   TAKES OVER the registration and knocks the first machine's runner offline
   with no error anywhere. Guarded since 2026-08 (per-host default name +
   ownership pre-flight in `runner_selfhosted.sh`) — but a manually exported
   `RUNNER_NAME` can still recreate it.

### Verify (read-only)

```bash
gh api repos/<owner>/<repo>/actions/runners \
  --jq '.runners[] | {name, status, busy}'          # who is online/offline right now
gh run list --branch test --limit 5                  # queued runs = pool saturated or empty
# on the machine whose runner is offline:
scripts/runner_selfhosted.sh status                  # registration + container state, matched by NAME
scripts/runner_selfhosted.sh check                   # one OK/WARN line per runner (slot container + GitHub)
docker ps --filter name=myai-gh-runner               # every runner container (myai-gh-runner-<repo>[-N])
scripts/sleep_guard.sh --check                       # rc 1 = sleep posture drifted (root cause 1)
```

### Fix

Run on the OFFLINE machine, from its MASTER checkout (the runner is `ci`
profile CI infra, not the gateway stack — the DEPLOY GUARD does not apply to
`runner_selfhosted.sh`, which scopes every compose verb to the `gh-runner`
service):

```bash
scripts/runner_selfhosted.sh up          # build + register + start; verifies Online by NAME
scripts/runner_selfhosted.sh logs        # if it registers then drops: look for session/token errors
sudo scripts/sleep_guard.sh --install-daemon   # if --check showed drift (once per machine)
```

If `up` refuses with a name-ownership error, do NOT pass `RUNNER_REPLACE=1`
casually — that is the takeover path. Confirm which machine genuinely owns the
name first (`gh api .../actions/runners`), and delete a stale offline
registration in GitHub → Settings → Actions → Runners rather than replacing a
live one.

### Break-glass (whole pool down, PR must merge)

Only when NO runner can be restored now (machine physically unavailable) AND
hosted Actions still cannot run. This is exactly the mode-5 situation, so its
guardrails apply verbatim — real gates first, never over a genuine failure,
announce the bypass:

```bash
./scripts/local-ci.sh --dry-run          # prove the code green in Docker, posts nothing
./scripts/local-ci.sh                    # post success ONLY for checks that genuinely passed
gh pr merge <PR#> --merge --admin        # only if a pinned check stays BLOCKED and protection allows it
```

Once any runner is back Online, re-run the skipped required checks for the
record — `gh run rerun <run-id>` on the queued/failed run, or trigger fresh
via `gh workflow run <workflow> --ref test` (all self-hosted workflows carry
`workflow_dispatch`) — and stop using the break-glass path immediately.

### Confirm

```bash
gh api repos/<owner>/<repo>/actions/runners \
  --jq '.runners[] | {name, status}'     # target runner: online
gh run list --branch test --limit 3      # previously-queued runs picked up, checks run in parallel again
```

### Rollback

`scripts/runner_selfhosted.sh down <owner/repo> [--instance N]` stops that
runner's slot (registration persists in its pinned volume; the next `up` is
instant). `reset` deregisters and wipes the volume — only for a genuinely
corrupt registration, since it forces a full re-register. Every call targets
one slot service of project `myai`; nothing in this mode touches the
app/gateway stack.

## 10. Host RAM exhausted while the RAM guard reports "under ceiling"

**Symptom:** the Mac is sluggish or swapping, and/or the CLI runner keeps
tree-killing its own tasks on `RAM CAP HIT` — yet the session-start banner says
`RAM Guard: NNN MB / 2048 MB (under ceiling)`. On 2026-09-18 five of the last
twelve runner jobs on one host died this way (peaks 1536–1622 MB against the
1536 MB cap, 7–19 processes) while every job on the personal Mac in the same
window returned `done`.

**Why the guard misses it — this is the whole point of the mode.**
`hooks/session/13-ram-guard.sh` sums `docker stats` across this project's
**default-profile containers only**. That is correct and deliberate (CLAUDE.md
§2: the ceiling covers the APP stack; the `ci`-profile `gh-runner` is excluded
as CI infra). But it means three large pools are structurally invisible to it:

1. **Idle `claude` CLI sessions.** Each terminal tab left open holds its own
   process plus a full MCP child stack, indefinitely. They are host processes,
   not containers, so the guard never sees them.
2. **Per-session MCP servers.** Every session spawns its own `mcp-remote`
   (myai), `playwright-mcp`, `mcp-server-github`, `shadcn-mcp`, `docker-mcp`
   and `gk mcp`. `playwright-mcp` additionally launches real Chrome instances
   that outlive the run that created them.
3. **Containers outside this compose file.** Other projects' stacks (e.g.
   another app's container, which alone ran to ~2.8 GB) and Docker Desktop's MCP Toolkit
   sandboxes (`mcp/node-code-sandbox`, label `docker-mcp=true`, unnamed
   `pedantic_rosalind`-style names) are not myai services, so they are excluded
   from the sum by design while still consuming the same physical RAM.

**Measured on home-mac, 2026-09-19** — guard read 636 MB / 2048
("under ceiling") while the host actually carried: 10 `claude` sessions
= 1251 MB, 102 MCP child processes = 322 MB, 2 stray MCP sandbox containers,
plus the myai stack and one app stack. Nine of the ten sessions had been idle 1d 5h.
Reclaimed ~950 MB of agent-attributable RAM by closing seven of them.

> **NOTE on Chrome:** most `Google Chrome` RSS on a desktop Mac is the
> operator's OWN browser (root process parented by `launchd`). Only a Chrome
> whose root is parented by a `playwright-mcp` node process is ours to kill.
> Check the parent before attributing — or killing — anything Chrome.

### Standing rule (home Mac, operator directive 2026-09-19)

**Only `myai` and one app stack run on the personal Mac.** Any other repo's `claude`
session or stack is closed when not actively in use. Either may be stopped too
if its MCP surface isn't needed; both restart cleanly, and a restart is the
right moment to apply a `mem_limit`. Keep exactly one myai phone doorway alive
(`remote_fleet.sh status` → the `master` session) — that is not spare capacity.

### Verify (read-only)

```bash
# 1. Every live claude session, with its working directory
ps -eo pid,tty,etime,rss,comm | awk '$5=="claude"'
for p in $(pgrep -x claude); do \
  echo "$p $(lsof -a -p $p -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"; done

# 2. Which of them are phone-drivable (master) — NEVER kill these blind
./scripts/remote_fleet.sh status

# 3. Agent-attributable host RAM, by family
ps -eo rss,command | grep -E 'mcp-remote|server-github|shadcn-mcp|playwright-mcp|/docker-mcp|gk.* mcp' \
  | grep -v grep | awk '{s+=$1} END {printf "mcp children: %.0f MB\n", s/1024}'
ps -eo rss,comm | awk '$2=="claude"{s+=$1} END {printf "claude sessions: %.0f MB\n", s/1024}'

# 4. Containers the guard does NOT count
docker ps --format '{{.Names}}\t{{.Status}}' | grep -v '^myai-'
docker ps --filter 'label=docker-mcp=true' -q            # Docker MCP Toolkit sandboxes
```

### Fix

```bash
# Close a session cleanly (SIGTERM reaps its whole MCP child stack).
kill -TERM <claude-pid>

# Master/phone sessions: use the fleet script, which also clears the tmux shell.
./scripts/remote_fleet.sh stop <repo>

# Stale playwright browsers, WITHOUT killing the operator's own Chrome:
ps -eo pid,ppid,command | grep 'MacOS/Google Chrome ' | grep -v Helper
#   → kill only roots whose ppid is a playwright-mcp node process.
#     playwright-mcp relaunches a fresh browser on next use.

# Docker MCP Toolkit sandboxes (respawn on demand):
docker rm -f $(docker ps --filter 'label=docker-mcp=true' -q)
```

**Do not** raise the runner's 1536 MB cap as the first move. The cap is what
stops a fan-out from taking the machine down; the logs name the real cause
("subagent/parallel-tool fan-out, N processes in the tree at kill time"). Free
the host first, then re-run. Raise the cap only once the host baseline is clean
and a task still needs more.

## 11. Host disk full, `du` finds nothing → a DELETED file still held open

**Symptom.** macOS reports the disk (Data volume) nearly full — office-mac on
2026-10-18: 99%, 878 of 926 GB used, 6 GB free — but every folder, even
`sudo du -xh -d 3 /System/Volumes/Data`, adds up to a fraction of that
(~234 GB). No Time Machine local snapshots, no other users.

**Cause.** A process is holding open a file that has been DELETED. The name is
gone, so nothing that walks the filesystem can see it, but the blocks are only
freed when the holder exits. That day: an orphaned iOS-Simulator
`SimRenderServer` (parent launchd, up 16 days, no Simulator running) was still
writing a screen recording to `/private/tmp/<uuid>.mp4.sb-…` — **592 GB**.

**Find it** (no sudo needed for your own processes):

```bash
lsof +L1 | awk 'NR==1 || $7+0 > 104857600'   # SIZE/OFF = bytes the deleted file still holds
ps -o pid,ppid,etime,command -p <pid>        # ppid 1 = orphaned; etime = how long
```

**Fix.** End the holder — `kill <pid>` (then `kill -9` if it lingers). The
space comes back instantly (6 → 640 GB free that day). For a SimRenderServer
with no Simulator open nothing is lost: the file is already deleted and macOS
relaunches the helper on demand.

**Prevention (automatic).** `scripts/host_disk_guard.sh`, run by
`scripts/machine_selfheal.sh` step 13 at every session start and in the daily
08:00 boot:
- deleted-but-open files ≥ 5 GB (`HOST_DISK_HELD_GB`): known-safe orphans in
  `HOST_DISK_AUTOKILL` (default `SimRenderServer`; full process name, ppid 1,
  its app not running) are ended automatically; anything else is reported with
  pid, size, path and the exact `kill` — never killed unasked;
- free < 50 GB (`HOST_DISK_WARN_FREE_GB`): Docker build cache + dangling images
  pruned; < 20 GB (`HOST_DISK_CRIT_FREE_GB`): unused images too. Docker
  VOLUMES are never touched (Mongo data). A hung Docker is skipped after 5 s;
- still low → 🔴 line + macOS notification. Log:
  `~/.myai/logs/host-disk-guard.log`. Report-only run:
  `scripts/host_disk_guard.sh --check`.

**Not a leak — "System Data" that is just big.** Storage settings files hidden
folders, VM disks, swap and caches under "System Data": Docker's VM disk
(`~/Library/Containers/com.docker.docker/…/Docker.raw`), iOS Simulator runtimes
(`xcrun simctl runtime list`), Ollama models (`~/.ollama`), swap (APFS `VM`
volume — cleared by a restart), the Claude desktop VM bundle, `~/Library/Caches`.
`diskutil apfs list` shows the volume sizes.
