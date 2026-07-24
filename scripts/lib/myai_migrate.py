#!/usr/bin/env python3
"""myai_migrate.py — idempotent config + brain schema migrator (`myai upgrade`).

`myai upgrade` self-updates the global npm package, then calls THIS to bring the
on-disk state up to the framework's current schema. Two independent domains:

  * config  — the `$MYAI_HOME/config` JSON file (default ~/.myai/config).
              Its `version` field is the config-schema version.
  * brain   — the git-versioned brain repo. Its applied migration level is
              recorded OUT-OF-BAND in the config file under `schema.brain`, so a
              healthy brain's git history is never touched by an upgrade.

Every migration is IDEMPOTENT: running twice is a no-op after the first. The
current levels are read from disk; only the gap [current+1 .. TARGET] runs, and
each step is written to be safe even if it was somehow already applied.

Usage:
  myai_migrate.py --home <dir> --brain <dir> [--check|--dry-run] [--json]

Modes:
  (default)   APPLY  — run pending migrations, write changes.
  --dry-run   plan only, touch nothing; exit 0.
  --check     report only, touch nothing; exit 0 if up-to-date, 20 if pending.

Output: a human summary, or a single JSON object with --json:
  {"changed":bool,"pending":int,
   "config":{"present":bool,"from":int,"to":int,"applied":[...]},
   "brain": {"present":bool,"from":int,"to":int,"applied":[...]}}
"""
import argparse
import json
import os
import subprocess
import sys

# ── Target schema versions (bump when a breaking on-disk change ships, and add
#    the matching migrate_* step below). Version 0 == legacy/unversioned. ───────
CONFIG_SCHEMA_VERSION = 1
BRAIN_SCHEMA_VERSION = 1


def load_config(path):
    """Read the config JSON; return {} for a missing/empty/invalid file so the
    migrator always has a dict to work from (a corrupt file is treated as v0)."""
    if not os.path.isfile(path):
        return {}
    try:
        with open(path, "r", encoding="utf-8") as fh:
            data = json.load(fh)
        return data if isinstance(data, dict) else {}
    except (ValueError, OSError):
        return {}


def write_config(path, data):
    """Atomically write config JSON (temp file + rename) so a crash mid-write can
    never leave a half-written config."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2, sort_keys=True)
        fh.write("\n")
    os.replace(tmp, path)


def brain_is_repo(brain_dir):
    return bool(brain_dir) and os.path.isdir(os.path.join(brain_dir, ".git")) \
        and os.path.isfile(os.path.join(brain_dir, "BRAIN.md"))


# ── config migrations ─────────────────────────────────────────────────────────
def migrate_config_1(cfg):
    """v0 → v1: stamp the schema version. The pre-versioned config had no
    `version` field; adding it is the whole migration. Idempotent (setting an
    already-present value is a no-op)."""
    cfg["version"] = 1
    return "stamped config schema version = 1"


CONFIG_MIGRATIONS = {1: migrate_config_1}


# ── brain migrations ──────────────────────────────────────────────────────────
def migrate_brain_1(brain_dir, dry_run):
    """v0 → v1 (layout v1): guarantee the `memory/` and `repos/` trees exist with
    their .gitkeep placeholders — repairs a brain created before that layout, or
    one that lost the dirs. Commits ONLY the files it actually creates, so a
    healthy brain is never touched (no dirs created → no commit)."""
    created = []
    for sub in ("memory", "repos"):
        keep = os.path.join(brain_dir, sub, ".gitkeep")
        if not os.path.exists(keep):
            created.append(os.path.join(sub, ".gitkeep"))
            if not dry_run:
                os.makedirs(os.path.dirname(keep), exist_ok=True)
                open(keep, "a", encoding="utf-8").close()
    if created and not dry_run and brain_is_repo(brain_dir):
        # Local git identity is set at brain init, so this works headless.
        subprocess.run(["git", "-C", brain_dir, "add", "-A"],
                       check=False, capture_output=True)
        subprocess.run(["git", "-C", brain_dir, "commit", "-q", "-m",
                        "brain: migrate layout -> v1 (myai upgrade)"],
                       check=False, capture_output=True)
    if created:
        return "created brain layout: " + ", ".join(created)
    return "brain layout already v1 (no change)"


BRAIN_MIGRATIONS = {1: migrate_brain_1}


def run(home, brain_dir, mode):
    """mode: 'apply' | 'dry-run' | 'check'. Returns the summary dict."""
    dry = mode in ("dry-run", "check")
    config_path = os.path.join(home, "config")
    cfg = load_config(config_path)
    config_existed = os.path.isfile(config_path)
    brain_present = bool(brain_dir) and os.path.isdir(brain_dir)

    # ── config domain ──────────────────────────────────────────────────────
    # Only migrate the config when there's a reason to: an existing config file,
    # OR a brain present (whose applied level must be recorded IN the config). A
    # machine with neither gets nothing written — `myai upgrade` never fabricates
    # state on a host that had none (mirrors `myai backup`'s "nothing to do").
    cfg_from = int(cfg.get("version", 0) or 0)
    cfg_applied = []
    if config_existed or brain_present:
        for v in range(cfg_from + 1, CONFIG_SCHEMA_VERSION + 1):
            step = CONFIG_MIGRATIONS.get(v)
            if step:
                cfg_applied.append({"version": v, "detail": step(cfg)})

    # ── brain domain ─────────────────────────────────────────────────────────
    schema = cfg.get("schema") if isinstance(cfg.get("schema"), dict) else {}
    brain_from = int(schema.get("brain", 0) or 0)
    brain_applied = []
    if brain_present:
        for v in range(brain_from + 1, BRAIN_SCHEMA_VERSION + 1):
            step = BRAIN_MIGRATIONS.get(v)
            if step:
                brain_applied.append({"version": v, "detail": step(brain_dir, dry)})
        # Record the applied brain level in config (out-of-band marker).
        if brain_applied:
            schema["brain"] = BRAIN_SCHEMA_VERSION
            cfg["schema"] = schema

    changed = bool(cfg_applied or brain_applied)

    # Persist config ONLY when something changed and we're applying. A brain
    # migration needs the config to exist (to record schema.brain); create it.
    if changed and mode == "apply":
        if config_existed:
            # Back up before overwriting — never lose a user's config.
            try:
                with open(config_path, "r", encoding="utf-8") as src, \
                        open(config_path + ".bak", "w", encoding="utf-8") as dst:
                    dst.write(src.read())
            except OSError:
                pass
        write_config(config_path, cfg)

    return {
        "changed": changed,
        "pending": len(cfg_applied) + len(brain_applied),
        "config": {
            "present": config_existed,
            "from": cfg_from,
            "to": CONFIG_SCHEMA_VERSION,
            "applied": cfg_applied,
        },
        "brain": {
            "present": brain_present,
            "from": brain_from,
            "to": BRAIN_SCHEMA_VERSION if brain_present else brain_from,
            "applied": brain_applied,
        },
    }


def render_human(result, mode):
    lines = []
    verb = {"apply": "Migrated", "dry-run": "Would migrate", "check": "Pending"}[mode]
    for domain in ("config", "brain"):
        d = result[domain]
        if not d["present"]:
            lines.append(f"  {domain:6} — not present (nothing to migrate)")
        elif d["applied"]:
            lines.append(f"  {domain:6} — {verb} v{d['from']} -> v{d['to']}:")
            for a in d["applied"]:
                lines.append(f"             • v{a['version']}: {a['detail']}")
        else:
            lines.append(f"  {domain:6} — already at v{d['to']} (up to date)")
    if not result["changed"]:
        lines.append("\nSchema up to date — no migrations pending.")
    elif mode == "apply":
        lines.append(f"\nApplied {result['pending']} migration(s).")
    else:
        lines.append(f"\n{result['pending']} migration(s) pending — run `myai upgrade` to apply.")
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="myai config + brain schema migrator")
    ap.add_argument("--home", required=True, help="$MYAI_HOME (config lives at <home>/config)")
    ap.add_argument("--brain", default="", help="brain repo dir (empty = no brain)")
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--dry-run", action="store_true", help="plan only, touch nothing")
    g.add_argument("--check", action="store_true", help="report only; exit 20 if pending")
    ap.add_argument("--json", action="store_true", help="emit a single JSON object")
    args = ap.parse_args(argv)

    mode = "check" if args.check else "dry-run" if args.dry_run else "apply"
    result = run(args.home, args.brain, mode)

    if args.json:
        print(json.dumps(result))
    else:
        print(render_human(result, mode))

    # --check is a status probe: non-zero signals "migrations pending" so CI /
    # scripts can gate on it. apply/dry-run always exit 0 on success.
    if mode == "check" and result["pending"]:
        return 20
    return 0


if __name__ == "__main__":
    sys.exit(main())
