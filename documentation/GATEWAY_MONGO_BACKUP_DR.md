# Hosted Gateway Mongo — Backup & Disaster Recovery

Disaster-recovery backup for the **hosted gateway's own production MongoDB**
(the shared Atlas database `runtime/src/shared/db.ts`'s `connectDB()`
registers every model against — tasks, schedules, agent/skill registry,
audit chain, subscription budgets, vectors, tenants, ...). See
[ADR-037](../architecture/ADR-037-hosted-gateway-mongo-backup-dr.md) for the
full design rationale.

**Not what you're looking for?**
- One operator's own local brain → `documentation/BACKUP_RESTORE.md` (`myai backup`/`myai restore`)
- The hosted-brain bare-git tenant repos → `architecture/ADR-036-hosted-brain-backup-replication.md`
- A local dev copy of Atlas for offline resilience → `documentation/MONGO_MIRROR.md` (`scripts/mongo_mirror.sh`) — a live cache, not a DR backup

## Scheduled backup

```bash
# One-time, on the gateway host only:
./scripts/setup_gateway_mongo_backup_schedule.sh                    # daily, 03:00
./scripts/setup_gateway_mongo_backup_schedule.sh --every-hours 12   # custom cadence
./scripts/setup_gateway_mongo_backup_schedule.sh --status           # installed? last run?
./scripts/setup_gateway_mongo_backup_schedule.sh --uninstall

# Ad-hoc / manual run:
GATEWAY_MONGO_BACKUP_ENABLED=1 ./scripts/gateway_mongo_backup.sh
```

**`GATEWAY_MONGO_BACKUP_ENABLED=1` is required** for the backup to actually
run (ADR-037 §2) — without it the script exits 0 having done nothing. This is
deliberate: it stops a workspace clone or a laptop with a stray `MONGODB_URI`
pointed at production from accidentally dumping it. The scheduled cron/launchd
job bakes this variable into its own job environment; never export it in an
interactive shell profile.

Each run writes a dated archive to `$MYAI_HOME/gateway-mongo-backups/`
(override with `GATEWAY_MONGO_BACKUP_DIR`), prunes anything older than
`GATEWAY_MONGO_BACKUP_RETENTION_DAYS` (default 14), and — if
`GATEWAY_MONGO_BACKUP_REMOTE` is set — hands the finished archive to that hook
for rotation to object storage:

```bash
# Example rotation hook — anything executable that takes the archive path as $1
export GATEWAY_MONGO_BACKUP_REMOTE=/usr/local/bin/upload-to-s3.sh
# upload-to-s3.sh:  #!/usr/bin/env bash
#                    aws s3 cp "$1" s3://myai-gateway-backups/mongo/
```

Without `GATEWAY_MONGO_BACKUP_REMOTE` set, backups are **local-only** — a
single point of failure the script warns about loudly on every run. Set it.

## Restore procedures

Two supported recovery paths, matching what each mechanism actually
guarantees:

### 1. Restore to a backup boundary (this repo's scripted path)

Restores to the state as of the moment a specific `mongodump` finished —
granularity is your backup cadence (daily by default).

```bash
# Inspect what's available:
ls -la "$MYAI_HOME/gateway-mongo-backups/"

# Dry run first — see the plan, touch nothing:
./scripts/gateway_mongo_backup.sh --restore <archive> --to-uri "<target-mongo-uri>" --dry-run

# Restore for real (--drop replaces existing collections in the target db —
# omit it to restore additively into an empty/scratch database instead):
./scripts/gateway_mongo_backup.sh --restore <archive> --to-uri "<target-mongo-uri>" --drop
```

**Never point `--to-uri` at the live production database unless you have
already decided this IS the recovery** (i.e. production is actually down/
corrupted and this is the incident response, not a drill). For a drill or a
test restore, always target a scratch database/cluster.

### 2. Restore to an arbitrary point in time (Atlas Continuous Backup)

The scripted path above can only restore to a backup boundary, not to an
arbitrary second in between. For that — the actual "point-in-time restore" in
the strict sense — use Atlas's own Continuous Backup / PITR feature (requires
an M10+ cluster tier with Continuous Backup enabled):

```bash
# Atlas CLI:
atlas backups restores start \
  --clusterName <cluster> \
  --projectId <project-id> \
  pointInTime \
  --pointInTimeUTCMillis <epoch-millis-of-target-second> \
  --targetProjectId <project-id> \
  --targetClusterName <restore-target-cluster>
```

Or via the Atlas UI: cluster → Backup → "Restore" → "Point in Time" → pick the
target timestamp → restore into a new cluster, then cut the gateway's
`MONGODB_URI` over once verified. This is the primary tool for a true
arbitrary-timestamp recovery (accidental delete/drop noticed hours later,
etc.); the scripted `mongodump`/`mongorestore` path above is the
provider-independent fallback that also works against any self-hosted replica
set, not just Atlas.

## Restore drill (automated, scheduled)

Proves the newest backup archive is actually recoverable — the scripted
equivalent of "we tested our backups" rather than assuming it. Runs entirely
against a **throwaway, disposable mongod container** on its own throwaway
docker network; it never touches the shared `myai-mongo`/gateway stack or any
real `--to-uri`.

```bash
./scripts/setup_gateway_mongo_restore_drill_schedule.sh                  # quarterly (default)
./scripts/setup_gateway_mongo_restore_drill_schedule.sh --status         # installed? last result?

# Ad-hoc:
./scripts/gateway_mongo_restore_drill.sh                # drills the newest archive
./scripts/gateway_mongo_restore_drill.sh --archive <f>   # drills a specific archive
```

Verification: every collection's restored document count is compared against
the archive manifest's pre-dump snapshot (`manifest.json`'s
`collectionCounts`). Any mismatch, missing collection, or restore failure is a
loud, non-zero `FAIL` recorded to `$MYAI_HOME/gateway-mongo-restore-drill.last`
(no archive yet is a `SKIP`, not a failure). `myai doctor`-style tooling can
surface this file the same way it already does for the mongo-mirror and
hosted-brain-backup schedules.

## What's in an archive

```
gateway-mongo-backup-<host>-<YYYYMMDD-HHMMSS>.tar.gz
├── manifest.json       {kind, formatVersion, createdAt, host, db,
│                         collectionCounts: {name: count}}
└── mongo.archive.gz    mongodump --archive --gzip payload, scoped to $db
```

The dump is scoped to the hosted gateway's own database (not a full-instance
dump), so each collection is consistent with itself as of when it was read,
but the archive is not guaranteed atomic across collections in the same run
— for that guarantee, use the Atlas Continuous Backup path above instead.
Inspect an archive without restoring it:

```bash
tar -xzOf <archive> manifest.json | jq
```
