#!/bin/bash
set +e
# 34-collaborator-activity.sh — "Since last session" collaborator-activity boot step.
# Event: SessionStart.
#
# WHY (operator request 2026-10-02, from foh): boot must check for NEW CODE from
# OTHER PEOPLE on any repo with a remote — not just fast-forward our own branch.
# Boot used to run `git fetch origin` + pull + the mobile-branch check and NEVER
# reported what teammates pushed; the operator had to ask by hand ("check new
# from rajeeva") and a reply on a "changes requested" PR thread went unseen for
# days. This wires scripts/collaborator_activity.sh so the report is automatic.
#
# Contract (the script owns it): warn-only, never mutates/prunes, always exit 0;
# silent when the repo has no remote; a bounded `git fetch --all --prune` then a
# short per-author "Since last session" block (or "No new activity").
#
# Host-only, like its sibling status hooks (03-docker-health, 26-git-fleet-
# preflight): a container guest is not where an operator reviews teammate work.
if [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; then
  exit 0
fi

# Opt-out for a machine/session that does not want the per-boot remote scan.
[ "${MYAI_COLLAB:-1}" = "0" ] && exit 0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
[ -z "$ROOT" ] && exit 0

# Skip per-task runner workspace clones (ci-workspaces / git worktrees): those
# are short-lived headless sessions working ONE queued task — a teammate-activity
# report there is noise, and a fetch per task is wasted latency. The operator
# reviews collaborator work from a real checkout, not a throwaway worktree.
WS_ROOT="${CI_WORKSPACES:-$HOME/ci-workspaces}"
case "$ROOT" in
  "$WS_ROOT"/*) exit 0 ;;
esac
case "$ROOT" in
  *"/.worktrees/"*) exit 0 ;;
esac

SCRIPT="$ROOT/scripts/collaborator_activity.sh"
[ -f "$SCRIPT" ] || exit 0

# The code remote is NOT fetched by any earlier session hook (boot_sync.sh syncs
# the brain + gateway, not the code remote — that is resync.sh, run only by the
# boot keywords), so let the script do its own bounded `git fetch --all --prune`.
bash "$SCRIPT"

exit 0
