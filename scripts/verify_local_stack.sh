#!/usr/bin/env bash
# verify_local_stack.sh — prove the RUNNING containers match HEAD, BY CONTENT.
#
# WHY THIS EXISTS (2026-09-14): the local dashboard has served stale code
# while looking perfectly healthy TWICE — an Aug-20 build still running on
# 2026-09-12, and a build missing commit 297e8ffe on 2026-09-14. The second
# case was PARTIAL: the operator auth route was present but the routing
# change was not, so a spot-check of one fix would have passed while the
# other was silently absent. Two traps this script is built to survive:
#
#   (a) FILE MTIME LIES. The gateway's user-auth.js was stamped 04:23, BEFORE
#       the 04:46 merge that changed it, while its content was correct (and
#       the reverse also happens: this repo's OWN myai-gateway container was
#       found, live, with an image `Created` several days after the compiled
#       file's mtime yet still running pre-fix code). mtime proves nothing
#       either direction — never compare it. Compare content.
#
#   (b) MINIFIED IDENTIFIERS DO NOT SURVIVE A BUILD. `isMeteredModel` greps
#       empty in a CORRECT dashboard bundle — Next's minifier renames
#       function/variable names. DATA — object literal keys, string/boolean
#       literals — survives: `P3:"local-cli"`, `metered:!0`. A gateway build
#       (plain `tsc`, no minifier) does not have this problem; its identifiers
#       ARE the marker. Pick markers accordingly, per service.
#
# This was proven live while writing this script: myai-gateway's running
# image (Created 2026-09-07) predates runtime/src/core/user-auth.ts's last
# commit (2026-09-12) and its compiled dist/core/user-auth.js still has the
# OLD `const BCRYPT_ROUNDS = 12` instead of the new `AUTH_BCRYPT_ROUNDS` env
# knob. myai-dashboard's bundle still serializes
# `priorityOverrides:{P0:"claude-opus-4-7",P3:"deepseek-v3"}` — the exact
# PRE-297e8ffe value — instead of current HEAD's `P3:"local-cli"`. Both
# containers in this workspace are STALE right now; this script says so.
#
# WHAT IT DOES NOT DO: rebuild anything. Verification only — `docker inspect`
# and `docker exec grep`, both read-only. Rebuilding the shared myai stack
# from a workspace clone is a DEPLOY GUARD violation (gateway/dashboard here
# may not have a real .env and would split-brain the fleet) — that stays
# gateway_ensure.sh's job, run from the owning checkout.
#
# PROBE FORMAT (pipe-delimited, 5 fields):
#   service|container|in-container-path|marker|label
#
# Usage:
#   scripts/verify_local_stack.sh                     # built-in probes
#   scripts/verify_local_stack.sh --service gateway    # one service only
#   scripts/verify_local_stack.sh --probe 'svc|container|/app/dist|MARKER|label'
#   scripts/verify_local_stack.sh --probes-file extra.conf
#   scripts/verify_local_stack.sh --quiet              # only the summary lines
#
# A probe missing its container (down/not running) counts that service DOWN.
# A service is FRESH only when every one of its configured markers is found.
#
# Exit codes: 0 all checked services FRESH · 1 at least one STALE/DOWN ·
#             2 usage error · 4 Docker daemon unreachable (nothing checked).

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$ROOT" || exit 2

# Built-in probes — kept in sync with the two real incidents above. Update
# the marker (never the identifier it was compiled from) whenever the source
# literal these point at changes.
DEFAULT_PROBES=(
  'gateway|myai-gateway|/app/dist|AUTH_BCRYPT_ROUNDS|bcrypt cost env knob (runtime/src/core/user-auth.ts)'
  'gateway|myai-gateway|/app/dist|tenantPlan|tenant plan field on session payload (runtime/src/core/user-auth.ts)'
  'dashboard|myai-dashboard|/app/.next|P3:"local-cli"|routing default P3->local-cli, post-297e8ffe (dashboard/src/lib/routing-policy.ts)'
  'dashboard|myai-dashboard|/app/.next|metered:!0|metered-model data flag, survives minification unlike isMeteredModel() (dashboard/src/lib/routing-policy.ts)'
)

PROBES_FILE="$ROOT/scripts/verify_local_stack.d/probes.conf"
EXTRA_PROBES=()
ONLY_SERVICE=""
QUIET=0

usage() {
  sed -n '2,45p' "${BASH_SOURCE[0]:-$0}" | sed 's/^# \{0,1\}//'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --probe)
      [ $# -ge 2 ] || { echo "verify_local_stack: --probe needs an argument" >&2; exit 2; }
      EXTRA_PROBES+=("$2"); shift 2 ;;
    --probes-file)
      [ $# -ge 2 ] || { echo "verify_local_stack: --probes-file needs an argument" >&2; exit 2; }
      PROBES_FILE="$2"; shift 2 ;;
    --service)
      [ $# -ge 2 ] || { echo "verify_local_stack: --service needs an argument" >&2; exit 2; }
      ONLY_SERVICE="$2"; shift 2 ;;
    --quiet) QUIET=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "verify_local_stack: unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if ! docker info >/dev/null 2>&1; then
  echo "🔴 verify_local_stack: Docker daemon is unreachable — cannot verify anything." >&2
  exit 4
fi

ALL_PROBES=("${DEFAULT_PROBES[@]}")

if [ -f "$PROBES_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
      ''|'#'*) continue ;;
    esac
    ALL_PROBES+=("$line")
  done < "$PROBES_FILE"
fi

if [ "${#EXTRA_PROBES[@]}" -gt 0 ]; then
  for p in "${EXTRA_PROBES[@]}"; do
    ALL_PROBES+=("$p")
  done
fi

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = "true" ]
}

marker_present() {
  # $1 container  $2 in-container path  $3 marker (literal, may hold quotes/!)
  docker exec -e VLS_MARKER="$3" -e VLS_TARGET="$2" "$1" \
    sh -c 'grep -rqF -- "$VLS_MARKER" "$VLS_TARGET" 2>/dev/null'
}

# Unique service names, first-seen order, bash-3.2 safe (no assoc arrays).
SERVICES=()
for probe in "${ALL_PROBES[@]}"; do
  svc="${probe%%|*}"
  [ -n "$ONLY_SERVICE" ] && [ "$svc" != "$ONLY_SERVICE" ] && continue
  already=0
  for s in ${SERVICES[@]+"${SERVICES[@]}"}; do
    [ "$s" = "$svc" ] && { already=1; break; }
  done
  [ "$already" -eq 1 ] || SERVICES+=("$svc")
done

if [ "${#SERVICES[@]}" -eq 0 ]; then
  echo "verify_local_stack: no probes match${ONLY_SERVICE:+ --service $ONLY_SERVICE}" >&2
  exit 2
fi

OVERALL_RC=0
for svc in "${SERVICES[@]}"; do
  total=0
  pass=0
  down=0
  fail_msgs=""
  for probe in "${ALL_PROBES[@]}"; do
    IFS='|' read -r p_svc p_container p_path p_marker p_label <<< "$probe"
    [ "$p_svc" = "$svc" ] || continue
    total=$((total + 1))
    if ! container_running "$p_container"; then
      down=1
      fail_msgs="${fail_msgs}${fail_msgs:+; }container '$p_container' not running"
      continue
    fi
    if marker_present "$p_container" "$p_path" "$p_marker"; then
      pass=$((pass + 1))
    else
      fail_msgs="${fail_msgs}${fail_msgs:+; }missing [$p_label] '$p_marker' in $p_container:$p_path"
    fi
  done

  if [ "$down" -eq 1 ]; then
    status="DOWN "
    OVERALL_RC=1
  elif [ "$pass" -eq "$total" ]; then
    status="FRESH"
  else
    status="STALE"
    OVERALL_RC=1
  fi

  printf '%s %-10s (%d/%d markers present)\n' "$status" "$svc" "$pass" "$total"
  if [ "$QUIET" -eq 0 ] && [ -n "$fail_msgs" ]; then
    printf '      %s\n' "$fail_msgs"
  fi
done

exit "$OVERALL_RC"
