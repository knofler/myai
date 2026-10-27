#!/usr/bin/env bash
# fleet_mcp_repos.sh — the ONE list of repos whose .mcp.json the framework owns.
# Sourced by rollout_mcp_bridge.sh and verify_fleet_mcp.sh so "converge" and
# "verify" can never disagree about which repos are in scope.
#
#   fleet_mcp_repos <root>   → one line per existing repo dir:  <abs path>|<flags>
#       flags: comma list of  noai   (managed_repos.txt says "NEVER write outside AI/")
#                             nopush (says "NEVER push" / "fetch-only")
#   Sources: config/managed_repos.txt + config/mcp_repos_extra.txt
#            (FLEET_MCP_REPOS_FILES=a:b overrides — tests only)
#            + DISCOVERY (2026-09-21, operator: "why isn't that part of boot?"):
#            every dir under the CODE tree (master's grandparent) holding a
#            .mcp.json or .myai-local, depth ≤5, node_modules/.git pruned,
#            minus config/mcp_repos_ignore.txt fragments. A brand-new repo is in
#            scope the next morning with no list to edit.
#            FLEET_MCP_SCAN_ROOT overrides the scan root ("" disables). When
#            FLEET_MCP_REPOS_FILES is set (tests) discovery is OFF unless
#            FLEET_MCP_SCAN_ROOT is given too — a unit test must never reach
#            the operator's real repos.
#   The master repo itself is excluded (its .mcp.json is git-tracked here).
#   Linked git worktrees are NEVER fleet repos (2026-10-21): a lane worktree
#   under ~/.myai/worktrees (LANE_WT_ROOT) — or any dir whose nearest .git is a
#   `gitdir: …/worktrees/<name>` file — is skipped, listed or discovered. Run
#   from a worktree, the master (scan root + self-exclusion) is the MAIN
#   checkout, not the worktree: before this, a rollout started in a lane
#   worktree scanned ~/.myai/worktrees and rewrote every other lane's tracked
#   .mcp.json.
#
# bash 3.2-safe.

# _fmr_linked_worktree <dir> → 0 when <dir> sits inside a linked git worktree
# (nearest .git upward is a file pointing into …/worktrees/<name>) or under the
# lane-worktree root. No git spawn: discovery checks dozens of dirs per boot.
_fmr_linked_worktree() {
  local p="$1" wt
  wt="${LANE_WT_ROOT:-$HOME/.myai/worktrees}"
  case "$p/" in "$wt"/*) return 0 ;; esac
  while [ -n "$p" ] && [ "$p" != "/" ]; do
    if [ -e "$p/.git" ]; then
      [ -f "$p/.git" ] && grep -qE '^gitdir: .*/worktrees/[^/]+/?$' "$p/.git" 2>/dev/null && return 0
      return 1
    fi
    p="$(dirname "$p")"
  done
  return 1
}

# _fmr_main_checkout <dir> → <dir> itself, or — when it is a linked worktree —
# the main checkout it belongs to (the parent of the shared .git dir).
_fmr_main_checkout() {
  local d="$1" common
  if [ -f "$d/.git" ] && common="$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" \
     && [ -n "$common" ] && [ "${common##*/}" = ".git" ]; then
    (cd "${common%/.git}" 2>/dev/null && pwd -P) && return 0
  fi
  printf '%s\n' "$d"
}

# fleet_code_root <root> → the CODE tree that discovery scans and that the
# rollout/verify scripts shorten paths against: FLEET_MCP_SCAN_ROOT when set,
# else the main checkout's grandparent. Empty when it can't be resolved.
fleet_code_root() {
  local self master
  self="$(cd "$1" 2>/dev/null && pwd -P)" || return 0
  master="$(_fmr_main_checkout "$self")"
  printf '%s' "${FLEET_MCP_SCAN_ROOT-$(cd "$master/../.." 2>/dev/null && pwd -P)}"
}

fleet_mcp_repos() {
  local root="$1" f line path comment flags seen=" " files scan ignore_file master self d
  # FLEET_MCP_REPOS_FILES (colon-separated) is a TEST-ONLY override of the two
  # config files, so the rollout/verify suites can run over fixture repos.
  files="${FLEET_MCP_REPOS_FILES:-$root/config/managed_repos.txt:$root/config/mcp_repos_extra.txt}"
  IFS=':' read -r -a _files <<<"$files"
  for f in "${_files[@]}"; do
    [ -f "$f" ] || continue
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      path="${line%%#*}"; comment=""
      case "$line" in *'#'*) comment="${line#*#}" ;; esac
      path="$(printf '%s' "$path" | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//')"
      [ -n "$path" ] || continue
      # shellcheck disable=SC2088  # literal "~/" prefix match is intended (config file syntax)
      case "$path" in "~/"*) path="$HOME/${path#\~/}" ;; esac
      [ -d "$path" ] || continue
      path="$(cd "$path" && pwd -P)"
      [ "$path" = "$(cd "$root" && pwd -P)" ] && continue
      _fmr_linked_worktree "$path" && continue
      case "$seen" in *" $path "*) continue ;; esac
      seen="$seen$path "
      flags=""
      case "$comment" in *"NEVER write outside AI/"*|*"AI folder only"*) flags="noai" ;; esac
      case "$comment" in *"NEVER push"*|*"fetch-only"*) flags="${flags:+$flags,}nopush" ;; esac
      printf '%s|%s\n' "$path" "$flags"
    done < "$f"
  done

  # ── discovery ──────────────────────────────────────────────────────────────
  self="$(cd "$root" && pwd -P)"
  master="$(_fmr_main_checkout "$self")"
  if [ -n "${FLEET_MCP_REPOS_FILES:-}" ] && [ -z "${FLEET_MCP_SCAN_ROOT+x}" ]; then
    scan=""                                   # test mode, no explicit scan root
  else
    scan="$(fleet_code_root "$root")"
  fi
  [ -n "$scan" ] && [ -d "$scan" ] || return 0
  ignore_file="${FLEET_MCP_IGNORE_FILE:-$root/config/mcp_repos_ignore.txt}"
  find "$scan" -maxdepth 5 \( -name node_modules -o -name .git \) -prune -o \( -name .mcp.json -o -name .myai-local \) -print 2>/dev/null \
  | while IFS= read -r f; do dirname "$f"; done | sort -u \
  | while IFS= read -r d; do
      d="$(cd "$d" 2>/dev/null && pwd -P)" || continue
      if [ "$d" = "$master" ] || [ "$d" = "$self" ]; then continue; fi
      _fmr_linked_worktree "$d" && continue
      case "$seen" in *" $d "*) continue ;; esac
      if [ -f "$ignore_file" ]; then
        _skip=0
        while IFS= read -r line || [ -n "$line" ]; do
          line="${line%%#*}"; line="$(printf '%s' "$line" | tr -d '[:space:]')"
          [ -n "$line" ] || continue
          case "$d/" in *"$line"*) _skip=1; break ;; esac
        done < "$ignore_file"
        [ "$_skip" = 1 ] && continue
      fi
      printf '%s|discovered\n' "$d"
    done
}
