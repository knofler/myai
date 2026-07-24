# myai backup / myai restore — snapshot & restore the brain + config

`myai backup` and `myai restore` are the disaster-recovery and machine-migration
pair for your local myAI state. They snapshot the two things that live outside
any code repo and can't be regenerated:

1. **The brain** — the git-versioned agent memory repo (`~/.myai/brain` by
   default), including its full `.git` history.
2. **The config** — the top-level files under `~/.myai` (`config`, `brain.path`).

Everything else (agents, skills, hooks, docs) ships in the framework/npm package
and is reproducible; the brain and config are the irreplaceable local state.

Both commands are **self-contained** — no gateway, network, or Docker required.
They shell into `scripts/myai_backup.sh` / `scripts/myai_restore.sh` and need
only `tar` + `git`.

---

## Backup

```bash
myai backup                       # write into the current directory
myai backup ~/backups/myai           # write into a directory
myai backup --out /tmp/snap.tar.gz   # write to an exact path
myai backup --quiet               # print only the archive path (for scripts)
```

Produces one dated, gzip'd tar:

```
myai-backup-<host>-<YYYYMMDD-HHMMSS>.tar.gz
├── manifest.json      metadata: format version, host, brain HEAD/branch, atom counts
├── config/            top-level files from $MYAI_HOME (config, brain.path)
└── brain/             the FULL brain repo including .git — a lossless clone
```

The manifest records the source `brainDir`, the brain `HEAD` SHA + branch, and
session/handoff/memory atom counts, so you can inspect an archive without
extracting it (`tar -xzOf <archive> manifest.json | jq`).

`myai backup` exits non-zero (and writes nothing) if there is neither a brain
repo nor any config files to snapshot.

---

## Restore

```bash
myai restore <archive.tar.gz>                 # restore brain + config
myai restore <archive.tar.gz> --to ~/brain2   # restore brain into a specific dir
myai restore <archive.tar.gz> --force         # overwrite existing state
myai restore <archive.tar.gz> --dry-run       # preview; touch nothing
```

Restore is **machine-agnostic**: the brain is restored to *this* machine's
resolved brain dir (via `$MYAI_BRAIN_DIR` → `$MYAI_HOME/brain.path` →
`$MYAI_HOME/brain`), not the absolute path baked into the archive — so a backup
taken on one Mac restores cleanly on another. `--to <dir>` overrides the target,
and `brain.path` is repointed automatically when the restore location differs
from what the archive recorded.

**Clobber protection:** restore refuses to overwrite a non-empty brain dir (or an
existing config file) unless you pass `--force`. With `--force`, the existing
state is moved aside to `<path>.bak-<ts>` — it is **never deleted** — so a
mistaken restore is always recoverable.

Verify a restore with `myai brain status`.

---

## Round-trip guarantee

`backup` → `restore` reproduces the brain **HEAD and full git history**
byte-for-byte and the config files byte-exact. This is covered by the hermetic
unit suite `scripts/tests/test_myai_backup.sh` (run via
`./scripts/tests/run_all.sh`), which points `$MYAI_HOME`/`$MYAI_BRAIN_DIR` at a
scratch dir and asserts the full round-trip, clobber protection, `--dry-run`
no-op, and failure modes.

## Resolution / env vars

| Var | Meaning | Default |
|-----|---------|---------|
| `MYAI_HOME` | config home directory | `~/.myai` |
| `MYAI_BRAIN_DIR` | explicit brain repo location | (see resolution below) |

Brain location resolution (shared with `scripts/lib/brain.sh`):
`$MYAI_BRAIN_DIR` → `$MYAI_HOME/brain.path` pointer → `$MYAI_HOME/brain`.

## Suggested cadence

- Before a machine migration or OS reinstall.
- Before a risky `myai brain` history operation (`revert`, force merge).
- Periodically to a synced folder (Dropbox/iCloud) — the archive is portable and
  the brain history is fully contained, so any machine can restore from it.
