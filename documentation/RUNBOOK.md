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
docker exec myai-mongo mongosh --eval 'db.runCommand({ping:1})' --quiet 2>&1 | grep -q '"ok" : 1' && echo "mongo OK"
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
(work-desktop→MBP machine switches, post-merge sessions that forgot the rebuild
step) — "stale gateway image" is one of the most frequently recurring notes
in the session archive.

### Verify (read-only)

```bash
docker inspect --format='{{.Created}}' myai-gateway         # image build/creation timestamp
git log -1 --format='%cI %h %s' -- runtime/                 # latest commit touching runtime/
git log -1 --format='%cI %h %s' -- dashboard/                # same for dashboard/, if relevant
```

If the latest `runtime/`-touching commit's timestamp is **after** the
container's `Created` timestamp, the running image predates that code — the
gateway is stale. (This is a live, real example as of this session: the
running `myai-gateway` container was created `2026-07-26T03:56:46Z`, but
`runtime/` has a commit at `2026-07-26T09:27:52Z` — i.e. the gateway is
currently serving code from before that merge.)

You can also check the gateway's self-reported health for corroboration:

```bash
curl -sf http://localhost:3100/health/deep | python3 -m json.tool
```

A `404`/`Cannot GET /health/deep` here (curl prints nothing, `json.tool`
errors `Expecting value`) is itself strong corroborating evidence, not a
separate bug — it means the running image predates the commit that added the
route (`runtime/src/core/server.ts`). This is exactly what the live check
above found in this session: the running `myai-gateway` container was
created before the newest `runtime/` commit, and `/health/deep` 404s while
`git grep` confirms the route exists in the current `runtime/src` — textbook
stale-image signature.

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
docker inspect --format='{{.Created}}' myai-gateway     # now newer than the runtime/ commit that triggered the fix
curl -sf http://localhost:3100/health/deep | python3 -m json.tool   # "healthy", no unexpected `degraded` components
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
curl -sf http://localhost:3100/health/deep | python3 -m json.tool | grep -A5 '"mongodb"'
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
curl -sf http://localhost:3100/health/deep | python3 -m json.tool | grep -A8 '"mongodb"'
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
curl -sf http://localhost:3100/health/deep | python3 -m json.tool | grep -A5 '"mongodb"'  # "status": "up", no failover block
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
gh api repos/knofler/ai_management/actions/permissions        # confirm Actions is enabled (billing block ≠ disabled, just can't run)
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
gh api repos/knofler/ai_management/commits/main/status | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d["state"])'
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

---

## 6. Pool-capacity ledger drift → `pool_capacity_drift_check.sh` alert

**Symptom:** a Telegram/dashboard-bell alert titled `Pool-capacity drift:
warning` or `Pool-capacity drift: CRITICAL`. The capability×cost×
availability router (task-21dc2746) and the API-credit reserve
(task-874364a3) both make routing/throttling decisions off
`state/pool-capacity.json`'s claude-tech `dailySpentTokens`/
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
python3 scripts/lib/pool_capacity_drift.py state/pool-capacity.json "${CLAUDE_CONFIG_DIR:-$HOME/.claude-tech}" 10 5000   # re-run the check live, right now
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
   `claude-tech-pool-missing`, `bad-generatedAt`) means the check couldn't
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

# 3. confirm the config dir the check used matches what the runner actually uses (default ~/.claude-tech)
echo "${CLAUDE_CONFIG_DIR:-$HOME/.claude-tech}"
ls "${CLAUDE_CONFIG_DIR:-$HOME/.claude-tech}"/projects/**/*.jsonl 2>/dev/null | wc -l   # transcripts present/readable at all?
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
python3 scripts/lib/pool_capacity_drift.py state/pool-capacity.json "${CLAUDE_CONFIG_DIR:-$HOME/.claude-tech}" 10 5000
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
