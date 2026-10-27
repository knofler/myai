#!/bin/bash
# 35-least-work-guard.sh — the director profile DIRECTS, it does not do the work.
#
# OPERATOR-ONLY, CONFIG-GATED (v1 G1 ruling 2026-10-22): an operator whose
# directing profile is API-billed wants a warning when that profile opens a
# repo that is not one of its billed org's repos — that is almost always an
# accident that burns API credits on work a subscription seat would do. Which
# profile, which repos are exempt and the warning text all live in
# operator_org_policy.conf (`leastwork.*` records), which is NOT shipped.
# Without that file this hook prints nothing. Lookup: $MYAI_OPERATOR_POLICY (a
# file, or "none"), then ~/.myai/operator_org_policy.conf, then config/ next to
# this hook's repo.
#
# A repo is exempt when EITHER:
#   - config/repo_org_map.txt (or AI/config/…) maps it to the `leastwork.org` key, OR
#   - its origin remote matches the `leastwork.remote` shell pattern.
#
# Warn-only, never blocks. bash 3.2-safe. Test overrides: LEAST_WORK_ROOT
# (repo root), CLAUDE_CONFIG_DIR as usual.
set +e

# Host-only — inside the gateway container CLAUDE_CONFIG_DIR is meaningless.
# MYAI_IN_CONTAINER is authoritative when explicitly set (even to empty): the
# hermetic test (scripts/tests/) runs inside the CI
# self-hosted runner container — where /.dockerenv exists — yet must exercise
# host behaviour, so it exports MYAI_IN_CONTAINER="". Only fall back to the
# /.dockerenv probe when the var is unset (a real host/gateway session).
if [ -n "${MYAI_IN_CONTAINER+set}" ]; then
  [ -n "$MYAI_IN_CONTAINER" ] && exit 0
elif [ -f /.dockerenv ]; then
  exit 0
fi

_op_policy_file() {
  local here cand
  case "${MYAI_OPERATOR_POLICY:-}" in
    none) return 1 ;;
    '') ;;
    *) [ -f "$MYAI_OPERATOR_POLICY" ] || return 1; printf '%s' "$MYAI_OPERATOR_POLICY"; return 0 ;;
  esac
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
  for cand in "${MYAI_HOME:-$HOME/.myai}/operator_org_policy.conf" "$here/config/operator_org_policy.conf"; do
    [ -f "$cand" ] && { printf '%s' "$cand"; return 0; }
  done
  return 1
}
POLICY="$(_op_policy_file)" || exit 0
# _op_val <key> → every "<key>|<value>" value, one per line, in file order.
_op_val() { awk -v k="$1|" 'index($0, k) == 1 { print substr($0, length(k) + 1) }' "$POLICY" 2>/dev/null; }

GUARD_PROFILE="$(_op_val leastwork.profile | head -1)"
GUARD_ORG="$(_op_val leastwork.org | head -1)"
GUARD_REMOTE="$(_op_val leastwork.remote | head -1)"
[ -n "$GUARD_PROFILE" ] || exit 0

CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
[ "$(basename "$CFG_DIR")" = "$GUARD_PROFILE" ] || exit 0   # the only profile this guard is about

ROOT="${LEAST_WORK_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
REPO_BASE=$(basename "$ROOT")

# ── exempt test 1: repo_org_map.txt maps it to the guarded org ─────────────────
MAPPED=""
for CANDIDATE in "$ROOT/config/repo_org_map.txt" "$ROOT/AI/config/repo_org_map.txt"; do
  [ -f "$CANDIDATE" ] || continue
  while IFS= read -r line; do
    trimmed=${line#"${line%%[![:space:]]*}"}
    case "$trimmed" in ''|\#*) continue ;; esac
    key=$(printf '%s\n' "$line" | awk '{print $1}')
    val=$(printf '%s\n' "$line" | awk '{print $2}')
    [ -z "$val" ] && continue
    if [ "$key" = "$ROOT" ] || [ "$key" = "$REPO_BASE" ]; then
      MAPPED="$val"
      break
    fi
  done < "$CANDIDATE"
  [ -n "$MAPPED" ] && break
done
[ -n "$GUARD_ORG" ] && [ "$MAPPED" = "$GUARD_ORG" ] && exit 0

# ── exempt test 2: origin remote matches the guarded org's pattern ─────────────
ORIGIN=$(git -C "$ROOT" remote get-url origin 2>/dev/null)
if [ -n "$GUARD_REMOTE" ]; then
  # shellcheck disable=SC2254  # the pattern is meant to glob
  case "$ORIGIN" in
    $GUARD_REMOTE) exit 0 ;;
  esac
fi

_op_val leastwork.line | while IFS= read -r line; do
  printf '%s\n' "${line//\{repo\}/$REPO_BASE}"
done

exit 0
