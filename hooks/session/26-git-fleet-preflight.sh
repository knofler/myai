#!/bin/bash
set +e
# 26-git-fleet-preflight.sh — MACHINE ARRIVAL boot preflight
# (plan/MYTHOS_IMPROVEMENT_PLAN.md Track 2 #5 / plan/schedule.json).
#
# PAST INCIDENT this guards against: a Mac returned after 7 weeks with every
# repo's .git missing, and nothing at boot said so — it was discovered hours
# into the session. scripts/restore_git_metadata.sh --fleet (dry-run, its
# default) already has everything needed to catch this: it walks the whole
# fleet roster and reports any repo missing .git plus any that cannot resolve
# a remote. This hook is just the wiring: run that dry-run at session start
# and surface findings before any other work happens.
#
# Contract:
#   - all repos attached  -> ZERO output (this hook, and the whole session
#     boot, stays quiet — nothing to act on)
#   - a repo missing .git -> names the repo and the exact fix command
#   - never writes anything (the underlying script defaults to dry-run; this
#     hook never passes --apply)
#
# Host-only, like the sibling machine-switch hooks: a container guest has no
# Dropbox-synced fleet of sibling repos to check.
#
# MYAI_FORCE_HOST=1 overrides the guard. This exists because the self-hosted
# CI runner (`runs-on: [self-hosted, myai-local]`) IS a container, so
# /.dockerenv is always present there and the host-only path could never be
# exercised — scripts/tests/test_git_fleet_preflight.sh's 7 host-mode
# assertions failed on every CI run while passing locally. The override is
# opt-in and set only by that test; nothing on the real boot path sets it, so
# a genuine container guest still exits here exactly as before.
if [ -z "${MYAI_FORCE_HOST:-}" ] && { [ -f /.dockerenv ] || [ -n "$MYAI_IN_CONTAINER" ]; }; then
  exit 0
fi

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
if [ -z "$ROOT" ]; then
    # Real precondition failure (both git rev-parse and the $0-relative
    # fallback failed to resolve a root), not "all repos attached" — same
    # incident class as hooks/session/17-schedule-status.sh. Warn instead of
    # vanishing silently.
    echo "26-git-fleet-preflight: cannot resolve repo (not a git repository) — fleet preflight skipped" >&2
    exit 0
fi

SCRIPT="$ROOT/scripts/restore_git_metadata.sh"
[ -f "$SCRIPT" ] || exit 0

# Dry-run is the script's default — never pass --apply from a boot hook.
OUTPUT="$(bash "$SCRIPT" --fleet 2>/dev/null)"
[ -z "$OUTPUT" ] && exit 0

FINDINGS=()
NAME="" DIR=""

while IFS= read -r line; do
  case "$line" in
    "── "*)
      rest="${line#── }"
      NAME="$(printf '%s' "$rest" | sed -E 's/^(.*)  \(.*\)$/\1/')"
      DIR="$(printf '%s' "$rest" | sed -E 's/^.*  \((.*)\)$/\1/')"
      ;;
    *".git already present"*)
      NAME="" DIR=""
      ;;
    *"container of "*)
      # Not a repo and never will be — a container folder that holds child
      # repos (e.g. a `services/` dir holding `svc-api` + `svc-web`). Nothing to fix, so it must not
      # reach FINDINGS or the hook cries wolf at every boot.
      NAME="" DIR=""
      ;;
    *"DRY-RUN — would:"*)
      if [ -n "$NAME" ]; then
        FINDINGS+=("  · $NAME — no .git")
        FINDINGS+=("      → fix: $SCRIPT --apply \"$DIR\"")
      fi
      NAME="" DIR=""
      ;;
    *"cannot resolve remote"*)
      if [ -n "$NAME" ]; then
        FINDINGS+=("  · $NAME — no .git, remote unresolved")
        FINDINGS+=("      → fix: add \"$NAME  knofler/<repo>\" to config/repo_remotes.txt, then: $SCRIPT --apply \"$DIR\"")
      fi
      NAME="" DIR=""
      ;;
    *"AMBIGUOUS"*)
      if [ -n "$NAME" ]; then
        FINDINGS+=("  · $NAME — no .git, ambiguous remote (name exists in multiple owners)")
        FINDINGS+=("      → fix: add an explicit \"$NAME  <owner>/<repo>\" line to config/repo_remotes.txt, then: $SCRIPT --apply \"$DIR\"")
      fi
      NAME="" DIR=""
      ;;
  esac
done <<< "$OUTPUT"

[ "${#FINDINGS[@]}" -eq 0 ] && exit 0

echo "GIT FLEET PREFLIGHT: $((${#FINDINGS[@]} / 2)) repo(s) need attention (not discovered mid-session):"
for f in "${FINDINGS[@]}"; do
  echo "$f"
done

exit 0
