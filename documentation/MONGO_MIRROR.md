# Local Mongo Mirror — Atlas is the source of truth, local is a read replica

> **Posture (operator, 2026-10-02): "keep all myai data on local mongo and Atlas
> in both; Atlas is the true source, and localhost will be a replica."**
>
> - **Atlas (`cluster0…`) is the SOURCE OF TRUTH.** Every gateway **write** goes
>   to Atlas — always. The gateway's `MONGODB_URI` points at Atlas; nothing in
>   the normal path writes to the local store.
> - **Local `myai-mongo` is a WARM READ REPLICA.** `scripts/mongo_mirror.sh`
>   streams Atlas → local on a schedule so a full local copy is always on disk
>   for read-side failover (`MYAI_DB_FAILOVER=local`, below) when Atlas is
>   unreachable. The replica is refreshed by overwrite, never promoted silently.
> - **One-way only.** The mirror is **Atlas → local**. The reverse direction
>   (local → Atlas) exists but is guarded behind `--reverse --yes`; routine
>   operation never pushes local data up, so the replica can never corrupt the
>   source of truth.
>
> This closes a resilience hole: when the gateway runs on a shared **Atlas**
> cluster, the local `myai-mongo` container is otherwise unused by it, so RAG
> memory, the agent/skill/repo registry, tasks, swarms, mailbox_messages,
> handoffs, and budgets would live **only in Atlas**. Atlas-down or offline ⇒ no
> memory/registry on localhost. (The **brain** is git-backed at `~/.myai/brain`
> + its configured private remote, so it already has a local copy — the rest did
> NOT.)

## What it does

`scripts/mongo_mirror.sh` (CLI: `myai mirror`) keeps a warm **local copy** of the
gateway's Mongo database by streaming a dump→restore:

```
mongodump --uri=<Atlas> --archive --gzip  |  mongorestore --uri=<local> --archive --gzip --drop --nsInclude=<db>.*
```

It runs inside a **throwaway `mongo:7` container** (which bundles `mongodump`/
`mongorestore`) attached to the local mongo's docker network — **no host mongo
tools required** (Docker-only, AI_RULES §1). Direction is **Atlas → local by
default** (a backup/mirror); the reverse (local → Atlas) is guarded.

## What gets mirrored — full replica minus a justified deny-list

The default whole-db mirror copies **every collection in the `myai` database**
(all ~73 — including `swarms`, `mailbox_messages`, `tasks`, `vectors`, `agents`,
`repos`, …) **except** a short, explicitly justified **deny-list** of genuinely
ephemeral / high-churn collections whose stale copy would be useless or
misleading in a replica. The list is dump-side (`mongodump --excludeCollection`)
so denied collections never transfer — keeping the replica lean under the 512m
RAM slice (see **RAM budget**). Default `MIRROR_DENY_COLLECTIONS`:

| Collection | Why it's denied |
|---|---|
| `runner_heartbeats` | Liveness pings — every machine every ~10 min. A frozen heartbeat after failover is worthless (ephemeral, high churn). |
| `runner_leases` | Current task locks. A stale lease in the replica would actively mislead a reader into thinking a task is held. (ephemeral) |
| `gatewaysessions` | Gateway session store, regenerated on next login. No value frozen in a replica. (ephemeral) |

Everything **not** on this list is mirrored. Override per run or per host:

```bash
MIRROR_DENY_COLLECTIONS="" myai mirror                 # mirror LITERALLY everything
MIRROR_DENY_COLLECTIONS="usageevents,stripeevents" myai mirror  # trim more under disk/RAM pressure
myai mirror --collections vectors,agents,skills,repos  # or an explicit allow-list (deny-list ignored)
```

An explicit `--collections` allow-list and the guarded `--reverse` push both
bypass the deny-list — it only applies to the default Atlas → local whole-db run.

## Usage

```bash
myai mirror                       # Atlas → local, full db minus the deny-list (default)
myai mirror --dry-run             # show the resolved plan + deny-list, touch nothing
myai mirror --collections vectors,agents,skills,repos,aipatterns   # scope it
myai mirror --src "mongodb+srv://…" --dst "mongodb://…"            # explicit
myai mirror --reverse --yes       # local → Atlas (DANGEROUS — guarded)
```

**Source resolution** (first hit wins): `--src` → `$MONGODB_URI` → the running
`myai-gateway` container's env (authoritative — whatever the gateway actually
uses) → root `.env` → `AI/.env`.

**Destination default**: the local `myai-mongo` container, reachable inside its
docker network as `mongodb://<user>:<pass>@myai-mongo:27017/<db>?authSource=admin`
(same db name the source carries; `<user>:<pass>` default to the compose root
creds). Credentials/host/network/image are all overridable via env
(`LOCAL_MONGO_USER`, `LOCAL_MONGO_PASS`, `LOCAL_MONGO_CONTAINER`,
`MONGO_TOOLS_IMAGE`, `--dst`).

**Safety rails**

- Refuses to mirror a database onto itself (identical src/dst).
- `--reverse` (local → Atlas) can overwrite the shared cloud store, so it is
  **refused unless** `--yes` (or `MIRROR_ALLOW_PUSH=1`) is also given.
- `--drop` applies per **restored** collection only — collections not in
  `--nsInclude` are untouched.

## Verifying

```bash
# counts in the local mirror after a run ("$MGU"/"$MGP" = your local root creds)
docker exec myai-mongo mongosh -u "$MGU" -p "$MGP" --authenticationDatabase admin \
  --quiet --eval 'const d=db.getSiblingDB("myai"); \
  ["agents","vectors","tasks","aipatterns","notifications"].forEach(c=>print(c+": "+d.getCollection(c).countDocuments({})))'
```

## Per-run freshness + the dashboard replica row

Every successful Atlas → local run records **freshness + the per-collection
count delta (Atlas vs the replica)** so coverage is observable, not assumed:

1. `scripts/mongo_mirror.sh` → `capture_coverage()` runs `mongosh` against both
   sides (in the same throwaway tools container, URIs passed via env so no
   credential lands in `docker` process args) and writes
   `~/.myai/mongo-mirror-counts.json`:

   ```json
   {
     "capturedAt": 1696200000,
     "mirroredCollections": 70,
     "totalCollections": 73,
     "deniedCollections": ["runner_heartbeats", "runner_leases", "gatewaysessions"],
     "localDataSizeBytes": 123456789,
     "ramWarnBytes": 419430400,
     "ramFlag": false,
     "perCollection": [{ "name": "tasks", "atlas": 17936, "local": 17936, "delta": 0 }, …]
   }
   ```

   `delta` is `atlas − local` per collection: `0` for a healthy mirrored
   collection, the full Atlas count for a denied one, and a non-zero value flags
   unexpected drift. This step is **best-effort** — a counting failure never
   fails the mirror itself.

2. `scripts/mongo_mirror_status_snapshot.sh` folds that object into
   `state/mongo-mirror-status.json` as `coverage` (the host → repo bridge the
   gateway/dashboard already read off the mount — same pattern as
   `runner_health.sh`). The existing `installed` / `intervalSec` / `last` fields
   are unchanged, so `mongo-mirror-alerter.ts` and `myai doctor` keep working.

3. The dashboard reads it via `dashboard/src/lib/mongo-mirror.ts` and renders a
   **"Local Mongo replica"** card on **System → Runner Health**, showing the
   one-line status:

   ```
   local replica: 70/73 collections, last sync 4m ago
   ```

   plus a **RAM headroom** tile that turns amber when `ramFlag` is set.

## RAM budget (the 512m slice)

The local `myai-mongo` is capped at **512 MB RAM** by the app-stack ceiling
(`CLAUDE.md` § On Session Start → "2 GB RAM ceiling"; the suggested split is app
1 GB + db 512 MB + sidecars 512 MB). WiredTiger clamps its cache to the
container's memory, so a replica whose working set grows past the slice risks
cache thrash. The mirror records the replica's on-disk `dataSize` each run and
sets `ramFlag: true` once it reaches `MIRROR_RAM_WARN_BYTES` (default ~400 MiB) —
surfaced as an amber tile on the dashboard and a `c_warn` in the run log.

**If the replica no longer fits:** widen the deny-list
(`MIRROR_DENY_COLLECTIONS="…,usageevents,stripeevents"` — the biggest
append-only/metering collections are the usual culprits), or raise the db's
`mem_limit` per host. A fleet-wide ceiling bump is tracked per host
(per-host limits); this mirror only **flags** the condition, it never changes the
cap on its own.

## Scheduling a periodic mirror (optional)

The script is idempotent and safe to run on a timer.
`scripts/setup_mongo_mirror_schedule.sh` installs the job — **never installed
automatically** (a machine must not grow a surprise job); the operator runs it
once, explicitly:

```bash
myai mirror --install-schedule                     # hourly (the default)
myai mirror --install-schedule --every-minutes 30  # custom cadence
myai mirror --schedule-status                      # installed? last run?
myai mirror --uninstall-schedule                   # remove
```

Platform routing (mirrors the CLI runner's launchd pattern,
`setup_cli_runner_schedule.sh`):

- **macOS** — a user LaunchAgent (`com.myai.mongo-mirror`) with `StartInterval`;
  launchd not cron because macOS TCC blocks cron from the home directory by
  default. Logs → `~/.myai/logs/mongo-mirror.{out,err}`.
- **Linux/VPS** — an idempotent, marker-tagged (`# myai-mongo-mirror`) crontab
  line; reinstall replaces only that line, other crontab entries are preserved.

Reinstalling is idempotent (rewrites the job in place with the new cadence).

**Re-verified 2026-09-01 (task-67e5df37):** fleet re-dispatched this as
"schedule `mongo_mirror.sh` periodically instead of manual-only invocation" —
it's a stale duplicate of task-b4c58215, shipped 2026-07-24 in `2a2813c2`
(`scripts/setup_mongo_mirror_schedule.sh` + the `--install-schedule` /
`--schedule-status` / `--uninstall-schedule` passthrough above + the `myai
doctor` last-run check). Re-ran both suites: `test_mongo_mirror_schedule.sh`
(32/32) and `test_mongo_mirror.sh` (21/21), all green. No code change made.

**Re-verified 2026-09-04 (task-d97ce85b):** fleet re-dispatched this a third
time as "schedule `scripts/mongo_mirror.sh` periodically (launchd/cron)
instead of manual-only invocation" — still the same stale duplicate of
task-b4c58215. Confirmed `scripts/setup_mongo_mirror_schedule.sh` (installer),
the `--install-schedule` / `--schedule-status` / `--uninstall-schedule`
passthrough in `scripts/mongo_mirror.sh`, and the `myai doctor` "mongo mirror
schedule" warn-only check (`runtime/tests/unit/cli-dispatch.test.ts`, doctor
in-process handler) are all present. Re-ran both bash suites again:
`test_mongo_mirror_schedule.sh` (32/32) and `test_mongo_mirror.sh` (21/21),
all green. No code change made.

**Observability:** every non-dry mirror run records its outcome
(epoch/rc/direction/db/collections) in `~/.myai/mongo-mirror.last`.
`myai doctor` surfaces this as the warn-only **`mongo mirror schedule`** check:
not scheduled (optional hint), never run, last run failed, or stale (more than
two intervals since the last success) — a fresh successful run reads `OK`.

## Local-first mode (2026-07-22, ADR-022) — `scripts/mongo_sync.sh`

`mongo_mirror.sh` above always mirrors Atlas→local by default and treats
local→Atlas as the dangerous, guarded direction. `scripts/mongo_sync.sh`
(CLI: `myai sync`) builds on it to add an explicit **local-first mode**: an
operator-declared "primary" designation that flips which direction is safe.

```bash
myai sync status                 # show current primary + last successful sync
myai sync set-primary local      # opt into local-first mode (explicit, not automatic)
myai sync                        # sync PRIMARY → SECONDARY (idempotent, resumable)
myai sync set-primary atlas      # back to the default posture
```

Going local-first is **two explicit, independent steps** — never coupled
automatically (2026-07-04 split-brain lesson):

1. `mongo_sync.sh set-primary local` — flips the designation in
   `state/.mongo_primary` (git-ignored, per-machine). From now on,
   `mongo_sync.sh` pushes local→Atlas instead of Atlas→local.
2. Point the gateway's `MONGODB_URI` at the local mongo service host
   (`mongo`, per the compose comment in `docker-compose.yml`) and
   rebuild/restart the gateway stack — a deploy action, done from the
   **master checkout only** (DEPLOY GUARD, `CLAUDE.md`), never by this script.

While local is primary, `mongo_sync.sh` (run on the same timer as before —
see Scheduling below) keeps pushing local writes back up to Atlas, so
reconnecting later costs nothing extra. Flip back with `set-primary atlas`
once Atlas is reachable again to resume the original Atlas→local mirror
direction.

**Idempotent + resumable**: every run is a full dump→restore convergence of
whichever side is currently primary — re-running (including after a failed
or interrupted run) always converges to the primary's current state; there
is no separate delta/resume step to track. See ADR-022 for the full
design and the trade-off against true bidirectional replication.

### Scheduling mongo_sync + staleness alerting (2026-07-26, ADR-022 follow-up)

ADR-022's scheduling section said to "run `mongo_sync.sh` on a cron/launchd
timer" but shipped no such timer — convergence depended on an operator
remembering to run it by hand. `mongo_sync.sh schedule` (CLI: `myai sync
schedule`) closes that gap, same as `myai mirror --install-schedule` does
for the mirror:

```bash
myai sync schedule install                   # install: HOURLY (default)
myai sync schedule install --every-minutes 30   # custom cadence
myai sync schedule status                    # installed? last sync? last staleness check?
myai sync schedule uninstall                 # remove
```

**Never installed automatically** — the operator runs this once, explicitly
(same rule as the mirror's own `--install-schedule`). Platform routing
mirrors `setup_mongo_mirror_schedule.sh`: a macOS user LaunchAgent
(`com.myai.mongo-sync`), or an idempotent, marker-tagged (`# myai-mongo-sync`)
crontab line on Linux.

`myai sync schedule install` installs **two** independent jobs on the same
cadence:

1. `mongo_sync.sh` itself — the PRIMARY → SECONDARY convergence run.
2. `mongo_sync_staleness.sh` — an independent staleness canary. It reads the
   timestamp `mongo_sync.sh` records on every successful run
   (`state/.mongo_sync_last`) and, if the last successful sync is older than
   `MONGO_SYNC_STALE_MINUTES` (default 150 — 2.5× the hourly default cadence)
   — or no successful sync has ever been recorded — raises a
   notification-engine alert (`notifications_send` via the gateway MCP
   endpoint, falling back to `notify-telegram.sh` directly if the gateway
   itself is unreachable; same mechanism as `brain_sync_canary.sh`). It never
   touches docker or mongo itself, so it keeps alerting reliably even while
   the sync job is failing every run (mongo down, docker not running, disk
   full). Alerts only fire on a stale/never-synced check — a healthy check is
   silent, matching the notification service's own noise policy.

```bash
./scripts/mongo_sync_staleness.sh            # run once: check, alert if stale
./scripts/mongo_sync_staleness.sh --status   # print last recorded check, no run
```

## Read-side local-first failover (2026-07-24) — `MYAI_DB_FAILOVER=local`

The follow-up landed: the gateway can now fail its **reads** over to the warm
local mirror when the primary (Atlas) is unreachable **at boot** — as an
explicit, logged, **READ-ONLY** degraded mode. Never a silent swap
(2026-07-04 split-brain lesson):

- **Opt-in only.** Off unless the gateway env carries `MYAI_DB_FAILOVER=local`
  (set it in `AI/.env` next to `MONGODB_URI`). Any other value = off.
- **Mirror URI**: `MYAI_DB_FAILOVER_URI` if set; otherwise the compose local
  mongo (`mongo` service host, root creds — overridable via
  `LOCAL_MONGO_USER` / `LOCAL_MONGO_PASS` / `LOCAL_MONGO_HOST`).
- **Loudly logged**: activation logs at `error` level with the redacted
  primary + mirror hosts and the original connection error.
- **Surfaced on the health panel**: `/health/deep` reports mongodb as
  `degraded` (never `up`) with a `details.failover` block
  (`{active, primaryUriHost, failoverUriHost, reason, activatedAt}`); the
  dashboard `/status` page shows "READ-ONLY failover to local mirror" on the
  mongo component, and the `health_status` MCP tool carries
  `mongodb.failover` for the api-health panel.
- **READ-ONLY enforced**: a global mongoose guard plugin
  (`runtime/src/shared/db-failover.ts`) rejects every write
  (save/insertMany/update*/delete*/findOneAnd*/replaceOne) with
  `DbReadOnlyError` while failover is active, and the boot-time
  agents/skills/hooks/rules `bulkWrite` syncs (which bypass mongoose
  middleware) skip themselves explicitly — so the mirror can never diverge
  from Atlas while it stands in.
- **Freshness caveat**: the mirror is only as fresh as the last `myai mirror`
  run — schedule it (see above) if you rely on failover.
- **Exit**: restore Atlas reachability and restart the gateway (a deploy
  action, MASTER checkout only). Failover never flips back mid-process.

Scope note: this covers **boot-time** unreachability (the common case: gateway
restarts while Atlas/network is down and still serves memory/registry reads).
A mid-session Atlas drop still surfaces as query errors — a live re-connect
swap would need connection-pool juggling that isn't worth the split-brain
risk today.

**Re-verified 2026-09-03 (task-0b6db26f):** fleet re-dispatched this as
"RELIABILITY: read-side local-first DB failover (MYAI_DB_FAILOVER=local) when
Atlas is unreachable" — a stale duplicate of task-605e90b6, already shipped
2026-07-24 in `9e5c7349`. Confirmed `runtime/src/shared/db-failover.ts` +
its `connectDB()`/`health.ts`/dashboard/`mcp/tools.ts` wiring are all still
present on this branch's HEAD. Ran the targeted suites fresh in an ephemeral
`node:22` container (Docker-only policy): `db-failover.test.ts` (21),
`health-db-failover.test.ts` (2), `health-mongo-boot.test.ts` (2),
`mcp-tools.test.ts` (104) — 129/129 passing; `tsc --noEmit` on `runtime/`
clean. No code change made. Found and removed the stale seed line for this
exact task in `config/runner_backlog.jsonl` (was line 103) causing repeat
dispatch; verified the remaining 469 JSON entries still parse and re-ran the
backlog/topup regression suites fresh — `test_archive_runner_backlog.sh`
13/13, `test_backlog_dupe_check.sh` 13/13,
`test_queue_topup_malformed_and_selfheal.sh` 7/7,
`test_queue_topup_planner_gate.sh` 7/7, `test_queue_topup_report.sh` 10/10 —
50/50 passing. Recorded here so a future duplicate dispatch of this task
finds the answer without re-deriving it.

## Failover drill (Atlas resilience task, on the pattern of ADR-036 §5)

An untested failover is a hypothesis. `scripts/atlas_failover_drill.sh`
proves the read-side failover above actually works — end to end, against
real MongoDB processes, never mocked — instead of trusting it silently:

```bash
./scripts/atlas_failover_drill.sh            # run once
./scripts/atlas_failover_drill.sh --quiet    # only the final PASS/FAIL line
./scripts/setup_atlas_failover_drill_schedule.sh              # install quarterly (default)
./scripts/setup_atlas_failover_drill_schedule.sh --status     # installed? last result?
```

It stands up a throwaway mongod (its own local mirror), deliberately points
`connectDB()` at an unreachable synthetic primary (an RFC 5737 TEST-NET-1
address — never a real host), and asserts: the connect does not throw,
`getDbFailoverState().active` flips true, reads succeed, and writes are
rejected with `DbReadOnlyError`. It then points a reachable mongod back at
`MONGODB_URI` (simulating "the primary returned") and asserts recovery:
direct connect, `active` flips back false, writes succeed again. Result is
recorded to `~/.myai/atlas-failover-drill.last` (`PASS`/`FAIL` + timestamp),
same convention as the other drill scripts. Never touches the shared
myai-gateway/myai-mongo stack or a real Atlas cluster — every URI it uses
points at a throwaway container it tears down on exit.

## Atlas cluster health alerts (Atlas resilience task)

`runtime/src/monitoring/atlas-cluster-health-alerter.ts` polls the Atlas
Admin API v2 (read-only) for the M0 free-tier cluster and pushes a Telegram +
dashboard-bell alert (same delivery as pool-capacity-alerter) on: connections
above `MYAI_ATLAS_ALERT_CONN_PCT`% of `MYAI_ATLAS_ALERT_CONN_CAP` (default
80% of 500), replication lag above `MYAI_ATLAS_ALERT_REPL_LAG_SECONDS`
(default 10s), disk above `MYAI_ATLAS_ALERT_DISK_PCT`% (default 75%), and any
cluster paused↔resumed transition. It is **inert** — no polling, no API
calls — until `ATLAS_PUBLIC_KEY` / `ATLAS_PRIVATE_KEY` (a **read-only** Atlas
project API key) plus `ATLAS_PROJECT_ID` / `ATLAS_CLUSTER_NAME` are set; see
`.env.example`. These alerts detect an M0 incident, they do not fix the
underlying tier limitation — the only real fix is an M10+ dedicated upgrade,
an operator billing decision this module never actions on its own.
