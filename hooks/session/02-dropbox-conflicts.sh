#!/bin/bash
set +e
# Hook: Dropbox Conflict Scanner
# Event: SessionStart
# Scans for Dropbox conflict files that pollute the repo

# Skip inside a container (e.g. the gateway's own hook registry): the full-tree
# find over the Dropbox bind is slow there and blows the 10s hook timeout, and
# conflict scanning is the HOST's job — Dropbox syncs on the host, not in the
# container. Running it here is redundant and the timeout cascades into a crash.
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  echo "02-dropbox-conflicts: skipped (inside container — host-only hook)"
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)

CONFLICTS=$(find "$ROOT" -maxdepth 5 \
  \( -name "*conflicted*" -o -name "* (1)*" -o -name "* (2)*" \) \
  ! -path "*/node_modules/*" ! -path "*/.next/*" 2>/dev/null)

# ── workspace-wide sweep ─────────────────────────────────────────────────────
# The repo-scoped find above is not enough. On 2026-08-29 this hook printed
# "No Dropbox conflict files found" at boot while 21 conflict files sat one
# level up — 16 of them 7 weeks old, from the OTHER Mac (work-desktop). A conflict
# scanner that only ever looks at the current repo reports a clean workspace
# that is not clean, which is the same "silence is not health" failure mode
# plan/MYTHOS_IMPROVEMENT_PLAN.md Track 1 #2 exists to kill. Bounded depth +
# prunes so it stays well inside the hook timeout.
WS="${MYAI_WORKSPACE_ROOT:-$(dirname "$ROOT")}"
WS_CONFLICTS=""
if [ -d "$WS" ] && [ "$WS" != "$ROOT" ]; then
  WS_CONFLICTS=$(find "$WS" -maxdepth 6 \
    \( -name node_modules -o -name .next -o -name .git -o -name coverage \) -prune -o \
    -type f \( -name "*conflicted copy*" -o -name "*Case Conflict*" \) -print 2>/dev/null)
fi

# Handle empty result correctly (avoid false positive from grep -c on empty string)
if [ -z "$CONFLICTS" ] && [ -z "$WS_CONFLICTS" ]; then
  echo "No Dropbox conflict files found"
  exit 0
fi

if [ -n "$WS_CONFLICTS" ]; then
  WS_COUNT=$(printf '%s\n' "$WS_CONFLICTS" | grep -c .)
  echo "DROPBOX CONFLICTS (workspace-wide, outside this repo): $WS_COUNT file(s)"
  printf '%s\n' "$WS_CONFLICTS" | sed "s|^$WS/|  · |" | head -8
  [ "$WS_COUNT" -gt 8 ] && echo "  … $((WS_COUNT - 8)) more"
  echo "  review: ./scripts/dropbox_conflicts.sh --list    resolve: --clean-identical"
fi

if [ -z "$CONFLICTS" ]; then
  exit 0
fi

COUNT=$(echo "$CONFLICTS" | wc -l | tr -d ' ')

if [ "$COUNT" -gt 0 ]; then
  echo "DROPBOX CONFLICTS FOUND: $COUNT files"
  echo "$CONFLICTS" | head -20
  echo ""
  echo "Review before deleting — a conflicted copy may hold the only copy of an edit:"
  echo "  ./scripts/dropbox_conflicts.sh --list            # classify identical vs differing"
  echo "  ./scripts/dropbox_conflicts.sh --clean-identical  # remove ONLY byte-identical dupes"
fi

exit 0
