#!/usr/bin/env bash
# lane_worktree.sh — every swarm worker builds in its OWN git worktree, outside
# Dropbox, in its own visible iTerm tab (plan/SWARM_COORDINATOR_PLAN.md row 3,
# spec §3). Incident 2026-10-03: tech and agy shared the one Dropbox checkout
# and agy's `ship it` nearly committed tech's half-built files.
#
# Usage:
#   lane_worktree.sh open  <repo-path> <task-slug> [--lane L] [--tab|--no-tab]
#       → worktree ~/.myai/worktrees/<repo-id>/<lane>-<task> on a NEW branch
#         lane/<lane>/<task> from origin/test (fetched first; no upstream is set,
#         so a bare `git push` can never land on test). Idempotent: an existing
#         worktree (or branch) is reused. Prints the worktree path + launcher
#         command by default (--no-tab default; never spawns a duplicate session
#         when the caller IS that lane or that lane already has a live session).
#   lane_worktree.sh list
#   lane_worktree.sh close <repo-path> <task-slug> [--lane L] [--force]
#       → refuses with uncommitted changes or commits not on any remote unless
#         --force; removes the worktree, KEEPS the branch.
#
# --lane defaults to this session's lane (session_profile). Worktrees live
# outside Dropbox, so they do not sync between Macs: push the branch at every
# checkpoint. Env: LANE_WT_ROOT (default ~/.myai/worktrees), LANE_WT_BASE
# (default origin/test).
#
# bash 3.2-safe; safe under `set -euo pipefail`. Source with
# LANE_WORKTREE_LIB_ONLY=1; tests stub _lw_open_tab (scripts/lib/iterm_tab.sh).
set -u

LW_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$LW_HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$LW_HERE/lib/runner_worktree.sh"
# shellcheck source=/dev/null
. "$LW_HERE/lib/repo_id.sh"
# shellcheck source=/dev/null
. "$LW_HERE/lib/iterm_tab.sh"

LANE_WT_ROOT="${LANE_WT_ROOT:-$HOME/.myai/worktrees}"
LANE_WT_BASE="${LANE_WT_BASE:-origin/test}"

# _lw_open_tab <dir> <cmd> → tty on stdout; 3 = iTerm unscriptable. Stubbed in tests.
_lw_open_tab() { iterm_open_tab "$1" "$2" 8; }

_lw_lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# _lw_toplevel <path> → the repo's MAIN checkout (not a worktree of it).
_lw_toplevel() {
  local common
  common="$(git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  (cd "$common/.." 2>/dev/null && pwd -P)
}

_lw_repo_id() { wt_sanitize "$(_lw_lower "$(canonical_repo_id "$1")")"; }

# _lw_resolve <repo-path> <task> <lane> → sets LW_REPO LW_DIR LW_BRANCH LW_LANE LW_TASK
_lw_resolve() {
  LW_REPO="$(_lw_toplevel "$1")" || { echo "lane_worktree: not a git repo: $1" >&2; return 1; }
  LW_TASK="$(wt_sanitize "$(_lw_lower "$2")")"
  LW_LANE="$(wt_sanitize "$(_lw_lower "$3")")"
  [ -n "$LW_TASK" ] && [ -n "$LW_LANE" ] || { echo "lane_worktree: task and lane must be non-empty" >&2; return 1; }
  LW_BRANCH="lane/$LW_LANE/$LW_TASK"
  LW_DIR="$LANE_WT_ROOT/$(_lw_repo_id "$LW_REPO")/$LW_LANE-$LW_TASK"
}

# _lw_is_worktree <repo> <dir> → 0 when <dir> is a registered worktree of <repo>.
_lw_is_worktree() {
  local real list
  [ -d "$2" ] || return 1
  real="$(cd "$2" && pwd -P)"
  list="$(git -C "$1" worktree list --porcelain 2>/dev/null || true)"
  # git may record the path as given or resolved (macOS /var → /private/var).
  [ "$(printf '%s\n' "$list" | grep -cxF -e "worktree $real" -e "worktree $2" || true)" -gt 0 ]
}

# _lw_launcher <lane> <dir> → the command that starts the lane's agent.
_lw_launcher() {
  case "$1" in
    agy) printf 'bash %q start %q' "$LW_HERE/agy_session.sh" "$2" ;;
    default) printf '%s' "${LANE_WT_CLAUDE_BIN:-claude}" ;;
    *) printf 'CLAUDE_CONFIG_DIR=%q %s' "$HOME/.claude-$1" "${LANE_WT_CLAUDE_BIN:-claude}" ;;
  esac
}

# _lw_caller_lane → caller's lane profile (falls back to inspecting _sr_session_pid
# comm when MYAI_SESSION_PROFILE/CLAUDE_CONFIG_DIR are unset inside an agy subshell).
_lw_caller_lane() {
  local p pid comm
  p="$(_lw_lower "$(session_profile)")"
  if [ "$p" = "default" ] && [ -z "${MYAI_SESSION_PROFILE:-}" ] && [ -z "${CLAUDE_CONFIG_DIR:-}" ]; then
    pid="$(_sr_session_pid 2>/dev/null || true)"
    if [ -n "$pid" ]; then
      comm="$(ps -o comm= -p "$pid" 2>/dev/null || true)"
      case "${comm##*/}" in agy) p="agy" ;; esac
    fi
  fi
  printf '%s' "$p"
}

# _lw_lane_has_live_session <lane> → 0 when live-sessions.tsv already has a live pid for <lane>.
_lw_lane_has_live_session() {
  local target="$1" file line prof rpid
  file="$(session_registry_file)"
  [ -f "$file" ] || return 1
  while IFS= read -r line; do
    [ -n "$line" ] || continue
    prof="$(printf '%s' "$line" | awk -F'\t' '{print tolower($2)}')"
    rpid="$(printf '%s' "$line" | awk -F'\t' '{print $6}')"
    [ "$prof" = "$target" ] || continue
    case "$rpid" in ''|*[!0-9]*) continue ;; esac
    if kill -0 "$rpid" 2>/dev/null; then
      return 0
    fi
  done < "$file"
  return 1
}

lw_open() {
  local repo="" task="" lane="" tab=0 cmd tty rc caller_lane
  while [ $# -gt 0 ]; do
    case "$1" in
      --lane) [ $# -ge 2 ] || { echo "lane_worktree: --lane needs a value" >&2; return 2; }; lane="$2"; shift 2 ;;
      --tab) tab=1; shift ;;
      --no-tab) tab=0; shift ;;
      -*) echo "lane_worktree: unknown flag $1" >&2; return 2 ;;
      *) if [ -z "$repo" ]; then repo="$1"; else task="$1"; fi; shift ;;
    esac
  done
  [ -n "$repo" ] && [ -n "$task" ] || { echo "usage: lane_worktree.sh open <repo-path> <task-slug> [--lane L] [--tab|--no-tab]" >&2; return 2; }
  caller_lane="$(_lw_caller_lane)"
  [ -n "$lane" ] || lane="$caller_lane"
  _lw_resolve "$repo" "$task" "$lane" || return 1
  case "$LW_DIR" in */Dropbox/*) echo "lane_worktree: WARNING — $LW_DIR is inside Dropbox (set LANE_WT_ROOT outside it)" >&2 ;; esac

  if _lw_is_worktree "$LW_REPO" "$LW_DIR"; then
    echo "lane_worktree: reusing $LW_DIR ($(git -C "$LW_DIR" rev-parse --abbrev-ref HEAD 2>/dev/null))"
  else
    if [ -e "$LW_DIR" ]; then
      echo "lane_worktree: $LW_DIR exists but is not a worktree of $LW_REPO — refusing to touch it" >&2
      return 1
    fi
    if ! git -C "$LW_REPO" fetch -q origin "${LANE_WT_BASE#origin/}" 2>/dev/null; then
      echo "lane_worktree: WARNING — git fetch origin ${LANE_WT_BASE#origin/} failed; using the local $LANE_WT_BASE" >&2
    fi
    mkdir -p "$(dirname "$LW_DIR")" || return 1
    if git -C "$LW_REPO" show-ref --verify --quiet "refs/heads/$LW_BRANCH"; then
      git -C "$LW_REPO" worktree add -q "$LW_DIR" "$LW_BRANCH" || { echo "lane_worktree: git worktree add failed" >&2; return 1; }
    else
      git -C "$LW_REPO" rev-parse --verify --quiet "$LANE_WT_BASE^{commit}" >/dev/null || {
        echo "lane_worktree: base $LANE_WT_BASE not found in $LW_REPO" >&2; return 1; }
      git -C "$LW_REPO" worktree add -q --no-track -b "$LW_BRANCH" "$LW_DIR" "$LANE_WT_BASE" || {
        echo "lane_worktree: git worktree add failed" >&2; return 1; }
    fi
    echo "lane_worktree: created $LW_DIR on $LW_BRANCH (from $LANE_WT_BASE)"
  fi

  cmd="$(_lw_launcher "$LW_LANE" "$LW_DIR")"
  if [ "$tab" = 1 ]; then
    if [ "$LW_LANE" = "$caller_lane" ]; then
      echo "lane_worktree: caller is already lane '$LW_LANE' — not spawning a duplicate session tab"
      tab=0
    elif _lw_lane_has_live_session "$LW_LANE"; then
      echo "lane_worktree: lane '$LW_LANE' already has a live session — not spawning a duplicate session tab"
      tab=0
    fi
  fi
  if [ "$tab" = 0 ]; then
    echo "  start the worker: cd $(printf '%q' "$LW_DIR") && $cmd"
    return 0
  fi
  tty="$(_lw_open_tab "$LW_DIR" "$cmd")"; rc=$?
  if [ "$rc" = 0 ]; then
    echo "lane_worktree: opened iTerm tab ${tty#/dev/} → $cmd"
    return 0
  fi
  if [ "$rc" = 3 ]; then
    echo "lane_worktree: iTerm is not scriptable — open a terminal and run:"
  else
    echo "lane_worktree: could not open an iTerm tab (rc $rc) — open a terminal and run:" >&2
  fi
  echo "  cd $(printf '%q' "$LW_DIR") && $cmd"
  [ "$rc" = 3 ] && return 0
  return 1
}

lw_list() {
  local d branch dirty ahead main any=0
  printf '%-28s %-34s %-6s %-9s %s\n' REPO/WORKTREE BRANCH DIRTY UNPUSHED PATH
  for d in "$LANE_WT_ROOT"/*/*; do
    [ -d "$d" ] || continue
    git -C "$d" rev-parse --is-inside-work-tree >/dev/null 2>&1 || continue
    any=1
    branch="$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
    dirty="$(git -C "$d" status --porcelain 2>/dev/null | grep -c . || true)"
    ahead="$(git -C "$d" rev-list --count HEAD --not --remotes 2>/dev/null || echo '?')"
    main="$(basename "$(dirname "$d")")/$(basename "$d")"
    printf '%-28s %-34s %-6s %-9s %s\n' "$main" "$branch" "$dirty" "$ahead" "$d"
  done
  [ "$any" = 1 ] || echo "  (no lane worktrees under $LANE_WT_ROOT)"
  return 0
}

lw_close() {
  local repo="" task="" lane="" force=0 dirty ahead
  while [ $# -gt 0 ]; do
    case "$1" in
      --lane) [ $# -ge 2 ] || { echo "lane_worktree: --lane needs a value" >&2; return 2; }; lane="$2"; shift 2 ;;
      --force) force=1; shift ;;
      -*) echo "lane_worktree: unknown flag $1" >&2; return 2 ;;
      *) if [ -z "$repo" ]; then repo="$1"; else task="$1"; fi; shift ;;
    esac
  done
  [ -n "$repo" ] && [ -n "$task" ] || { echo "usage: lane_worktree.sh close <repo-path> <task-slug> [--lane L] [--force]" >&2; return 2; }
  [ -n "$lane" ] || lane="$(session_profile)"
  _lw_resolve "$repo" "$task" "$lane" || return 1
  if ! _lw_is_worktree "$LW_REPO" "$LW_DIR"; then
    echo "lane_worktree: no worktree at $LW_DIR"
    return 0
  fi
  dirty="$(git -C "$LW_DIR" status --porcelain 2>/dev/null | grep -c . || true)"
  ahead="$(git -C "$LW_DIR" rev-list --count HEAD --not --remotes 2>/dev/null || echo 0)"
  if [ "$force" = 0 ]; then
    if [ "$dirty" -gt 0 ]; then
      echo "lane_worktree: $LW_DIR has $dirty uncommitted change(s) — commit + push, or close --force" >&2
      return 1
    fi
    if [ "$ahead" -gt 0 ]; then
      echo "lane_worktree: $LW_BRANCH has $ahead commit(s) on no remote — git -C $(printf '%q' "$LW_DIR") push -u origin $LW_BRANCH, or close --force" >&2
      return 1
    fi
  fi
  if [ "$force" = 1 ]; then
    git -C "$LW_REPO" worktree remove --force "$LW_DIR" || return 1
  else
    git -C "$LW_REPO" worktree remove "$LW_DIR" || return 1
  fi
  git -C "$LW_REPO" worktree prune 2>/dev/null || true
  echo "lane_worktree: removed $LW_DIR (branch $LW_BRANCH kept)"
  return 0
}

lw_main() {
  local verb="${1:-list}"
  shift || true
  case "$verb" in
    open) lw_open "$@" ;;
    list) lw_list ;;
    close) lw_close "$@" ;;
    -h|--help|help) sed -n '2,28p' "$LW_HERE/lane_worktree.sh" | sed 's/^# \{0,1\}//' ;;
    *) echo "lane_worktree: unknown verb '$verb' (open | list | close)" >&2; return 2 ;;
  esac
}

[ -n "${LANE_WORKTREE_LIB_ONLY:-}" ] && return 0
lw_main "$@"
