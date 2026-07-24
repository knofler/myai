#!/bin/bash
set +e
# Hook: Dropbox artifact-ignore enforcer
# Event: SessionStart
# Policy: AI_RULES §12 — node_modules + build artifacts must NEVER sync to Dropbox.
#
# Auto-applies Dropbox's per-folder ignore flag to any node_modules/build dirs
# that have (re)appeared in THIS repo (e.g. after an npm install), on every
# machine. Scoped to the current repo so it stays well under the hook timeout;
# the full Dropbox-wide sweep is the manual `scripts/dropbox_ignore_artifacts.sh --all`.
# macOS + Dropbox only; silent no-op elsewhere. Idempotent.

# host-only (Dropbox runs on the host, not in containers)
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  exit 0
fi

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
SCRIPT="$ROOT/scripts/dropbox_ignore_artifacts.sh"
[ -f "$SCRIPT" ] || SCRIPT="$ROOT/AI/scripts/dropbox_ignore_artifacts.sh"  # managed-repo layout

if [ -x "$SCRIPT" ]; then
  "$SCRIPT" --quiet
else
  exit 0
fi
