#!/usr/bin/env bash
# =============================================================================
# brain_sync_verify.sh — make cross-machine continuity VERIFIABLE, not hopeful.
#
# The gap (LL 2026-07-06): a `wrap up` (esp. -u) ran brain_merge, reported
# success, but the atom never reached the shared brain origin/main — because the
# machine's brain had no remote, or the push silently no-op'd. The next session
# on another machine booted from stale git, not the brain. Both sides failed
# silently. This script closes it:
#   1. Ensure the brain has an origin (auto-wire from MYAI_BRAIN_REMOTE if unset).
#   2. Push brain main.
#   3. VERIFY the local main SHA is actually on origin/main.
#   4. Print the `Brain: <sha>` anchor line for the handoff header (stdout).
#   5. Exit non-zero + LOUD if the atom did not land — so wrap-up can surface it.
#
# Usage:  scripts/brain_sync_verify.sh            # verify+push, print anchor
#         scripts/brain_sync_verify.sh --anchor-only   # just print the anchor
# Reads MYAI_BRAIN_REMOTE from AI/.env / .env. Offline is a reported failure,
# never a crash — the caller decides how loud to be.
# =============================================================================
set +e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MYAI_HOME="${MYAI_HOME:-$HOME/.myai}"
BRAIN_DIR="${MYAI_BRAIN_DIR:-$MYAI_HOME/brain}"
[ -f "$MYAI_HOME/brain.path" ] && [ -z "${MYAI_BRAIN_DIR:-}" ] && BRAIN_DIR="$(head -1 "$MYAI_HOME/brain.path")"
ANCHOR_ONLY=false; [ "${1:-}" = "--anchor-only" ] && ANCHOR_ONLY=true

if ! command -v git >/dev/null 2>&1 || [ ! -d "$BRAIN_DIR/.git" ]; then
  echo "brain-sync: no brain at $BRAIN_DIR — skip (file-based handoff only)"; exit 0
fi

SHA="$(git -C "$BRAIN_DIR" rev-parse --short HEAD 2>/dev/null)"
if [ "$ANCHOR_ONLY" = true ]; then echo "Brain: ${SHA:-none}"; exit 0; fi

# 1. ensure origin (auto-wire from MYAI_BRAIN_REMOTE)
if ! git -C "$BRAIN_DIR" remote get-url origin >/dev/null 2>&1; then
  REMOTE=""
  for src in "$ROOT/.env" "$ROOT/AI/.env" "$MYAI_HOME/brain.remote"; do
    [ -f "$src" ] || continue
    case "$src" in *.env) REMOTE="$(grep -E '^MYAI_BRAIN_REMOTE=' "$src" 2>/dev/null | head -1 | cut -d= -f2- | sed 's/^["'"'"']//;s/["'"'"']$//')";; *) REMOTE="$(head -1 "$src")";; esac
    [ -n "$REMOTE" ] && break
  done
  if [ -n "$REMOTE" ]; then git -C "$BRAIN_DIR" remote add origin "$REMOTE" 2>/dev/null; fi
fi
if ! git -C "$BRAIN_DIR" remote get-url origin >/dev/null 2>&1; then
  echo "brain-sync: ⚠ NO ORIGIN on the brain — this session's memory will NOT reach other machines. Set MYAI_BRAIN_REMOTE in AI/.env."; exit 3
fi

# 2. push brain main
git -C "$BRAIN_DIR" push --quiet origin main 2>/dev/null
PUSH_RC=$?

# 3. verify local main is on origin/main
git -C "$BRAIN_DIR" fetch --quiet origin main 2>/dev/null
LOCAL="$(git -C "$BRAIN_DIR" rev-parse HEAD 2>/dev/null)"
if git -C "$BRAIN_DIR" merge-base --is-ancestor "$LOCAL" origin/main 2>/dev/null; then
  echo "Brain: $SHA"
  echo "brain-sync: ✓ atom verified on origin/main ($SHA) — reachable from any machine"
  exit 0
else
  echo "Brain: $SHA"
  echo "brain-sync: ⚠ LOCAL BRAIN NOT ON origin/main (push rc=$PUSH_RC) — this close did NOT sync. Likely offline or a rejected push; retry: git -C \"$BRAIN_DIR\" push origin main"
  exit 4
fi
