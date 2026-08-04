# Local Mongo Mirror — memory + registry resilience

> Closes a resilience hole: when the gateway runs on a shared **Atlas** cluster,
> the local `myai-mongo` container is unused by it, so RAG memory, the agent/
> skill/repo registry, tasks, handoffs, and budgets live **only in Atlas**.
> Atlas-down or offline ⇒ no memory/registry on localhost. (The **brain** is
> git-backed at `~/.myai/brain` + its configured private remote, so it already
> has a local copy — memory/registry did NOT.)

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

## Usage

```bash
myai mirror                       # Atlas → local, whole db (default)
myai mirror --dry-run             # show the resolved plan, touch nothing
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
