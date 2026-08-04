#!/usr/bin/env bash
# =============================================================================
# validate_backlog_schema.sh — schema/lint check for config/runner_backlog.jsonl.
#
# The backlog well is hand-edited across many PLANNER passes with no structural
# validation. A malformed line, a missing field, or a repo that's actually on
# config/schedule_ignore.txt (no-autonomous-schedule list) can sit silently in
# the file until queue_topup.sh's pop path trips over it — or worse,
# schedule_task.sh silently refuses it (consent gate) and the runner slot that
# would have gone to that line is wasted. This catches all three before that
# happens.
#
# Checks per non-comment, non-blank line:
#   1. valid JSON object
#   2. has all required keys: repo, title, priority, agent, desc (non-empty strings)
#   3. priority is one of P0, P1, P2, P3
#   4. repo is NOT listed in config/schedule_ignore.txt (queueing it there is a
#      guaranteed wasted slot — schedule_task.sh refuses it without
#      SCHEDULE_CONSENT=1)
#
# Usage
#   scripts/validate_backlog_schema.sh                  # check config/runner_backlog.jsonl
#   scripts/validate_backlog_schema.sh <file.jsonl>      # check a candidate batch before appending
#   scripts/validate_backlog_schema.sh --quiet           # errors only, no per-line OK noise
#
# Exit: 0 all lines valid, 1 one or more schema violations found.
#
# Optional pre-commit hook: this repo's .githooks/pre-commit (installed via
# scripts/install_git_hooks.sh) is the natural place to wire this in — call it
# only when config/runner_backlog.jsonl is staged, same pattern as the existing
# Dropbox-conflict check in that file.
# =============================================================================
set -eu

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

QUIET=false
FILE="$ROOT/config/runner_backlog.jsonl"
for a in "$@"; do
  case "$a" in
    --quiet) QUIET=true ;;
    -*) echo "unknown flag: $a" >&2; exit 2 ;;
    *) FILE="$a" ;;
  esac
done

IGNORE_FILE="$ROOT/config/schedule_ignore.txt"

[ -f "$FILE" ] || { echo "validate_backlog_schema: no such file: $FILE" >&2; exit 2; }

FILE="$FILE" IGNORE_FILE="$IGNORE_FILE" QUIET="$QUIET" /usr/bin/python3 - <<'PY'
import json, os, sys

path = os.environ["FILE"]
ignore_path = os.environ["IGNORE_FILE"]
quiet = os.environ["QUIET"] == "true"

REQUIRED = ("repo", "title", "priority", "agent", "desc")
VALID_PRIORITIES = {"P0", "P1", "P2", "P3"}

ignored_repos = set()
if os.path.exists(ignore_path):
    for ln in open(ignore_path, encoding="utf-8"):
        ln = ln.strip()
        if ln and not ln.startswith("#"):
            ignored_repos.add(ln)

errors = []
checked = 0

with open(path, encoding="utf-8") as f:
    for lineno, raw in enumerate(f, start=1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        checked += 1

        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            errors.append(f"line {lineno}: invalid JSON — {e}")
            continue

        if not isinstance(obj, dict):
            errors.append(f"line {lineno}: not a JSON object")
            continue

        missing = [k for k in REQUIRED if k not in obj]
        if missing:
            errors.append(f"line {lineno}: missing required key(s): {', '.join(missing)}")
            continue

        empty = [k for k in REQUIRED if not isinstance(obj[k], str) or not obj[k].strip()]
        if empty:
            errors.append(f"line {lineno}: empty/non-string value for key(s): {', '.join(empty)}")

        priority = obj.get("priority")
        if priority not in VALID_PRIORITIES:
            errors.append(f"line {lineno}: invalid priority '{priority}' (must be one of P0, P1, P2, P3)")

        repo = obj.get("repo")
        if repo in ignored_repos:
            errors.append(
                f"line {lineno}: repo '{repo}' is on config/schedule_ignore.txt — "
                f"schedule_task.sh will refuse this line without SCHEDULE_CONSENT=1; "
                f"drop it or get explicit user consent before queueing"
            )

if errors:
    for e in errors:
        print(f"✗ {e}", file=sys.stderr)
    print(f"validate_backlog_schema: {len(errors)} error(s) across {checked} line(s) checked ({path})", file=sys.stderr)
    sys.exit(1)

if not quiet:
    print(f"✓ validate_backlog_schema: {checked} line(s) OK ({path})")
sys.exit(0)
PY
