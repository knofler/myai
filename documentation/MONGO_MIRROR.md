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

The script is idempotent and safe to run on a timer. Two fleet-consistent
options — pick one; neither is installed automatically (so a machine never grows
a surprise job):

- **launchd (macOS)** — a `StartInterval` agent that runs `myai mirror` hourly.
- **cron / systemd-timer (Linux/VPS)** — a line invoking `myai mirror`.

Example crontab entry (hourly):

```cron
0 * * * * /usr/local/bin/myai mirror >> ~/.myai/logs/mongo-mirror.log 2>&1
```

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

## Next step (not in this change) — read-side local-first failover

Local-first mode (above) still requires the operator to point `MONGODB_URI`
at local mongo and rebuild the gateway themselves. It does NOT make the
gateway **automatically read from** the local mirror when Atlas becomes
unreachable mid-session — that is a larger, riskier change to
`runtime/src/core/index.ts` connection handling and must avoid the
2026-07-04 split-brain lesson (the gateway must never silently serve stale
local data as if it were canonical). Recommended shape when it lands: an
explicit, logged, read-only degraded mode (`MYAI_DB_FAILOVER=local`) that the
operator opts into, never an automatic silent swap. Tracked as a follow-up.
