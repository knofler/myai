#!/usr/bin/env bash
# atlas_profile.sh — which MongoDB Atlas CLI profile (and project / cluster) does
# THIS repo provision against? Reads config/atlas_profiles.txt.
#
#   eval "$(./scripts/atlas_profile.sh)"       # sets ATLAS_PROFILE, ATLAS_REPO_RESOLVED
#                                              # (+ ATLAS_PROJECT / ATLAS_CLUSTER when the row has them)
#   ./scripts/atlas_profile.sh --profile       # bare profile name
#   ./scripts/atlas_profile.sh my-repo  # resolve a named repo instead of the current one
#   ./scripts/atlas_profile.sh --list          # the whole table, plus the unlisted default
#
# Exit codes: 0 resolved (possibly to the default) · 2 bad flag OR malformed table.
# A malformed table is FAIL-CLOSED on purpose: a silently shifted column would route a
# work-org repo to its work profile with project/cluster unset, and setup_atlas.sh
# would then create a fresh "myAI" project in the work org — the exact outcome
# this file exists to prevent. Callers must check the exit code BEFORE eval-ing.
#
# Table format (config/atlas_profiles.txt):
#   repo | profile | project | cluster      — pipe-separated, whitespace trimmed
#   • comments are FULL-LINE only (first non-blank char `#`); a `#` inside a value is literal
#   • `|` is the delimiter and cannot appear in a value; >4 columns = malformed (exit 2)
#   • blank lines ignored; profile column empty → `default`
#
# Precedence, highest first: ATLAS_PROFILE / ATLAS_PROJECT / ATLAS_CLUSTER already in
# the environment → the repo's row in the table → profile `default` (the personal
# account) with no project/cluster override.
#
# Repo identity: ATLAS_REPO env → the `origin` remote's basename (ai_management,
# my-repo …) → the checkout's folder name. Remote AND folder names are both
# tried against the table, so a renamed folder still routes correctly.
# ATLAS_REPO_ROOT points the git lookup somewhere else (tests); ATLAS_PROFILES_FILE
# points at another table (tests).
#
# WHY: two Atlas accounts can live on one Mac — personal (`default`) and a work
# org (e.g. `work`). setup_atlas.sh used to run against whichever profile the CLI had
# current, so one `atlas auth logout` on the wrong account and a work-org repo would
# have created a fresh "myAI" project + cluster in the wrong org. The table makes the
# routing explicit and committed; the DECISION is recorded in the config header.
#
# bash 3.2 compatible (macOS /bin/bash): no associative arrays, no mapfile.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TABLE="${ATLAS_PROFILES_FILE:-$ROOT/config/atlas_profiles.txt}"
REPO_ROOT_HINT="${ATLAS_REPO_ROOT:-$ROOT}"
DEFAULT_PROFILE="default"

MODE=assign
WANT_REPO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) MODE=profile ;;
    --list)    MODE=list ;;
    -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "atlas_profile: unknown flag $1" >&2; exit 2 ;;
    *)  WANT_REPO="$1" ;;
  esac
  shift
done

trim() {
  local s="$1"
  s="${s#"${s%%[![:space:]]*}"}"
  s="${s%"${s##*[![:space:]]}"}"
  printf '%s' "$s"
}

# is_data_line <raw line> — false for blank lines and full-line comments.
is_data_line() {
  local t
  t="$(trim "$1")"
  [ -n "$t" ] && [ "${t#\#}" = "$t" ]
}

# split_row <raw line> — sets R_REPO R_PROFILE R_PROJECT R_CLUSTER (trimmed).
# Returns 1 when the row has more than four columns.
split_row() {
  local extra=""
  IFS='|' read -r R_REPO R_PROFILE R_PROJECT R_CLUSTER extra <<< "$1"
  R_REPO="$(trim "$R_REPO")"
  R_PROFILE="$(trim "${R_PROFILE:-}")"
  R_PROJECT="$(trim "${R_PROJECT:-}")"
  R_CLUSTER="$(trim "${R_CLUSTER:-}")"
  [ -n "$R_PROFILE" ] || R_PROFILE="$DEFAULT_PROFILE"
  [ -z "$(trim "${extra:-}")" ]
}

# validate_table — every data row must have ≤4 columns and a repo name; exit 2 otherwise.
validate_table() {
  local line n=0
  [ -f "$TABLE" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n+1))
    is_data_line "$line" || continue
    if ! split_row "$line"; then
      echo "atlas_profile: MALFORMED row $n in $TABLE — more than 4 columns ('|' is the delimiter and cannot appear in a value): $line" >&2
      exit 2
    fi
    if [ -z "$R_REPO" ]; then
      echo "atlas_profile: MALFORMED row $n in $TABLE — empty repo column: $line" >&2
      exit 2
    fi
  done < "$TABLE"
}

# repo_candidates — one name per line, most specific first.
repo_candidates() {
  if [ -n "$WANT_REPO" ]; then printf '%s\n' "$WANT_REPO"; return; fi
  if [ -n "${ATLAS_REPO:-}" ]; then printf '%s\n' "$ATLAS_REPO"; return; fi
  local top remote
  top="$(git -C "$REPO_ROOT_HINT" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$REPO_ROOT_HINT")"
  remote="$(git -C "$top" remote get-url origin 2>/dev/null || true)"
  remote="${remote%/}"; remote="${remote%.git}"; remote="${remote##*/}"; remote="${remote##*:}"
  [ -n "$remote" ] && printf '%s\n' "$remote"
  basename "$top"
}

# lookup <repo> → "profile|project|cluster" for the first matching row; rc 1 if none.
lookup() {
  local want="$1" line
  [ -f "$TABLE" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    is_data_line "$line" || continue
    split_row "$line" || continue
    [ "$R_REPO" = "$want" ] || continue
    printf '%s|%s|%s\n' "$R_PROFILE" "$R_PROJECT" "$R_CLUSTER"
    return 0
  done < "$TABLE"
  return 1
}

# resolve → "repo|profile|project|cluster" (falls through to the default profile).
resolve() {
  local cand row first=""
  while IFS= read -r cand; do
    [ -n "$cand" ] || continue
    [ -n "$first" ] || first="$cand"
    if row="$(lookup "$cand")"; then
      printf '%s|%s\n' "$cand" "$row"
      return 0
    fi
  done <<< "$(repo_candidates)"
  printf '%s|%s||\n' "$first" "$DEFAULT_PROFILE"
}

validate_table

case "$MODE" in
  list)
    printf '%-18s %-12s %-14s %s\n' REPO PROFILE PROJECT CLUSTER
    if [ -f "$TABLE" ]; then
      while IFS= read -r line || [ -n "$line" ]; do
        is_data_line "$line" || continue
        split_row "$line" || continue
        printf '%-18s %-12s %-14s %s\n' "$R_REPO" "$R_PROFILE" "$R_PROJECT" "$R_CLUSTER"
      done < "$TABLE"
    else
      echo "(no table at $TABLE)"
    fi
    printf '%-18s %-12s %-14s %s\n' '(unlisted)' "$DEFAULT_PROFILE" '-' '-'
    ;;
  profile|assign)
    IFS='|' read -r Z_REPO Z_PROFILE Z_PROJECT Z_CLUSTER <<< "$(resolve)"
    P="${ATLAS_PROFILE:-$Z_PROFILE}"
    PJ="${ATLAS_PROJECT:-$Z_PROJECT}"
    CL="${ATLAS_CLUSTER:-$Z_CLUSTER}"
    if [ "$MODE" = profile ]; then
      printf '%s\n' "$P"
    else
      printf 'ATLAS_REPO_RESOLVED=%q\n' "$Z_REPO"
      printf 'ATLAS_PROFILE=%q\n' "$P"
      if [ -n "$PJ" ]; then printf 'ATLAS_PROJECT=%q\n' "$PJ"; fi
      if [ -n "$CL" ]; then printf 'ATLAS_CLUSTER=%q\n' "$CL"; fi
    fi
    ;;
esac
exit 0
