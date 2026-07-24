# myai upgrade — self-update the CLI + migrate on-disk schema

`myai upgrade` keeps a myAI install current in two steps, in order:

1. **Self-update the global CLI** — `npm update -g ai-management`, so the
   globally-installed `myai` binary matches the latest published version.
2. **Run pending schema migrations** — bring the two pieces of local state that
   live *outside* the npm package up to the framework's current on-disk schema:
   - **config** — the `~/.myai/config` JSON file (its `version` field is the
     config-schema version).
   - **brain** — the git-versioned brain repo layout (`memory/`, `repos/`). The
     brain's applied migration level is recorded **out-of-band** in the config
     file under `schema.brain`, so a healthy brain's git history is never touched.

Every migration is **idempotent**: a second `myai upgrade` after a clean one
applies zero migrations. It is safe to run any time — after a package update,
when moving to a new machine, or on a hunch.

Self-contained: no gateway, network, or Docker required for the migration step
(the npm step obviously needs npm + network). It shells into
`scripts/myai_upgrade.sh`, which drives the migration engine
`scripts/lib/myai_migrate.py` (needs only `python3` + `git`).

---

## Usage

```bash
myai upgrade                    # self-update + apply pending migrations
myai upgrade --check            # report pending migrations WITHOUT applying
myai upgrade --dry-run          # preview both phases; touch nothing
myai upgrade --no-self-update   # migrations only; skip the npm global update
myai upgrade --json             # emit the migration result as one JSON object
myai upgrade --quiet            # minimal output
```

`--check` and `--dry-run` never touch the global npm install.

### Exit codes

| Code | Meaning |
|------|---------|
| `0`  | success — migrations applied, or nothing pending |
| `20` | `--check` only: migrations are **pending** (nothing was written) |
| `2`  | bad flag / usage error |
| `1`  | environment error (no `python3`, missing migrator) |

`--check` returning `20` is the CI/scripting hook: gate a pipeline on
"is this install up to date?" without mutating anything.

---

## What a migration does

Migrations are keyed by target schema version and run only for the gap between
the on-disk version and the framework target:

- **config → v1** — stamp the `version` field on a pre-versioned config, leaving
  every other key untouched (the original is copied to `~/.myai/config.bak`
  first).
- **brain → v1 (layout v1)** — guarantee the `memory/` and `repos/` trees exist
  with their `.gitkeep` placeholders, repairing a brain created before that
  layout. It commits **only the files it actually creates**, so a healthy brain
  produces no commit at all.

A machine with neither a config file nor a brain gets **nothing written** —
`myai upgrade` never fabricates state on a host that had none (same philosophy as
`myai backup`'s "nothing to back up").

## Adding a new migration

1. Bump `CONFIG_SCHEMA_VERSION` or `BRAIN_SCHEMA_VERSION` in
   `scripts/lib/myai_migrate.py`.
2. Add a `migrate_config_<N>` / `migrate_brain_<N>` step and register it in the
   `CONFIG_MIGRATIONS` / `BRAIN_MIGRATIONS` table.
3. Write the step to be **idempotent** — safe to run even if already applied.
4. Add a fixture + assertion to `scripts/tests/test_myai_upgrade.sh`.

## Resolution

Mirrors `scripts/lib/brain.sh`:

```
$MYAI_HOME       config home           (default ~/.myai)
$MYAI_BRAIN_DIR → $MYAI_HOME/brain.path → $MYAI_HOME/brain   (brain repo)
```

## See also

- `documentation/BACKUP_RESTORE.md` — snapshot/restore the brain + config
- `TRY_BRAIN.md` — brain walkthrough
