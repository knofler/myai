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

# Handle empty result correctly (avoid false positive from grep -c on empty string)
if [ -z "$CONFLICTS" ]; then
  echo "No Dropbox conflict files found"
  exit 0
fi

COUNT=$(echo "$CONFLICTS" | wc -l | tr -d ' ')

if [ "$COUNT" -gt 0 ]; then
  echo "DROPBOX CONFLICTS FOUND: $COUNT files"
  echo "$CONFLICTS" | head -20
  echo ""
  echo "Clean with: find . -name '*conflicted*' -delete"
fi

exit 0
