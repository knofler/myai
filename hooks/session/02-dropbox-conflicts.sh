#!/bin/bash
set +e
# Hook: Dropbox Conflict Scanner + lossless auto-resolve
# Event: SessionStart
#
# Dropbox writes "<name> (HOST's conflicted copy YYYY-MM-DD).ext" whenever two
# machines touch one file between syncs. This hook used to only LIST them and
# tell the operator to run --clean-identical — which never applied, because a
# copy that differs from live is the normal case. Result (2026-09-22): the same
# 13 copies were reported at every session start and in three boot reports for
# five days, all of them provably lossless. Now:
#   1. THIS repo: run scripts/dropbox_conflicts.sh --clean-safe — removes only
#      what it can prove is lossless (identical · content already in git ·
#      regenerated snapshot per config/dropbox_conflict_policy.txt · append-only
#      log merged first). Differing/orphaned copies are reported, never deleted.
#   2. The rest of the workspace: report only (the daily `boot` sweep
#      auto-resolves there; a hook in repo X should not delete in repo Y).

# Skip inside a container (e.g. the gateway's own hook registry): the full-tree
# find over the Dropbox bind is slow there and blows the 10s hook timeout, and
# conflict scanning is the HOST's job — Dropbox syncs on the host, not in the
# container. Running it here is redundant and the timeout cascades into a crash.
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  echo "02-dropbox-conflicts: skipped (inside container — host-only hook)"
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
WS="${MYAI_WORKSPACE_ROOT:-$(dirname "$ROOT")}"

SCRIPT=""
for c in "$ROOT/scripts/dropbox_conflicts.sh" "$ROOT/AI/scripts/dropbox_conflicts.sh"; do
  if [ -f "$c" ]; then SCRIPT="$c"; break; fi
done

if [ -z "$SCRIPT" ]; then
  # Legacy path (repo without the framework scripts): list, never delete.
  CONFLICTS=$(find "$ROOT" -maxdepth 5 -type f -name "*conflicted copy*" \
    ! -path "*/node_modules/*" ! -path "*/.next/*" ! -path "*/.git/*" 2>/dev/null)
  if [ -z "$CONFLICTS" ]; then echo "No Dropbox conflict files found"; exit 0; fi
  echo "DROPBOX CONFLICTS FOUND: $(printf '%s\n' "$CONFLICTS" | grep -c .) files"
  printf '%s\n' "$CONFLICTS" | head -20
  echo "Review before deleting — a conflicted copy may hold the only copy of an edit."
  exit 0
fi

# ── 1. this repo: resolve the provably-lossless classes, report the rest ──────
OUT="$(bash "$SCRIPT" --clean-safe --root "$ROOT" 2>&1)"; RC=$?
REMOVED="$(printf '%s\n' "$OUT" | grep -E '^removed [0-9]+ lossless' | head -1)"
case "$RC" in
  0)
    if printf '%s' "$OUT" | grep -q 'none found'; then
      echo "No Dropbox conflict files found (this repo)"
    else
      echo "Dropbox conflicts (this repo): auto-resolved — ${REMOVED:-nothing to remove}"
      printf '%s\n' "$OUT" | grep -E '^  merged ' | head -5
    fi ;;
  3)
    echo "DROPBOX CONFLICTS (this repo) — a human must decide:"
    [ -n "$REMOVED" ] && echo "  ($REMOVED)"
    printf '%s\n' "$OUT" | grep -E '^(KEPT|DIFFERING|ORPHANED|  · )' | head -12
    echo "  inspect: $SCRIPT --diff --root '$ROOT'"
    echo "  then either copy the edit into the live file, or: $SCRIPT --clean-all --yes --root '$ROOT'" ;;
  *)
    echo "02-dropbox-conflicts: dropbox_conflicts.sh rc=$RC — $(printf '%s' "$OUT" | tail -1)" ;;
esac

# ── 2. workspace-wide: report only ────────────────────────────────────────────
# On 2026-08-29 a repo-scoped scan printed "No Dropbox conflict files found"
# while 21 conflict files sat one level up, 16 of them 7 weeks old. Silence is
# not health — but deleting in OTHER repos is the boot's job, not this hook's.
if [ -d "$WS" ] && [ "$WS" != "$ROOT" ]; then
  WOUT="$(DROPBOX_CONFLICTS_MAXDEPTH=6 bash "$SCRIPT" --list --root "$WS" 2>&1)"   # bounded: 10s hook budget
  if ! printf '%s' "$WOUT" | grep -q 'none found'; then
    N="$(printf '%s\n' "$WOUT" | sed -n 's/^dropbox_conflicts: \([0-9]*\) conflict.*/\1/p' | head -1)"
    SAFE="$(printf '%s\n' "$WOUT" | grep -E 'safe to remove|merge missing' | awk -F': ' '{s+=$2} END {print s+0}')"
    HUMAN="$(printf '%s\n' "$WOUT" | grep -E '^  (differing|orphaned)' | awk -F': ' '{s+=$2} END {print s+0}')"
    echo "DROPBOX CONFLICTS (workspace-wide): ${N:-?} file(s) — $SAFE lossless, $HUMAN need a human"
    printf '%s\n' "$WOUT" | grep -E '^  · ' | head -6
    [ "${N:-0}" -gt 6 ] 2>/dev/null && echo "  … $((N - 6)) more"
    [ "$SAFE" -gt 0 ] 2>/dev/null && echo "  resolve the lossless ones now: $SCRIPT --clean-safe --root '$WS'"
  fi
fi

exit 0
