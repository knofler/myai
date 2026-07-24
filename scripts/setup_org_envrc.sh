#!/usr/bin/env bash
# setup_org_envrc.sh — Multi-Org-Auth Phase 2: per-repo direnv auto-switch.
#
# Reads config/repo_org_map.txt and drops a machine-local, gitignored `.envrc`
# into each mapped Powerhouse/Team repo so that `cd`-ing into it auto-selects the
# right Claude org via CLAUDE_CONFIG_DIR (no thinking required). Personal repos
# need no .envrc — the bare `~/.claude` default already covers them.
#
#   museum   -> export CLAUDE_CONFIG_DIR=$HOME/.claude-museum
#   tech     -> export CLAUDE_CONFIG_DIR=$HOME/.claude-tech
#   personal -> (skipped: bare default ~/.claude)
#
# The .envrc is kept out of git via each repo's .git/info/exclude (machine-local,
# never committed) — repos are Dropbox-synced, so a tracked .envrc would leak one
# machine's absolute paths to another. Re-run safely any time: .envrc is only
# (re)written when missing or changed; `direnv allow` re-runs after a change.
#
# ACTIVATION: once you fill config/repo_org_map.txt with real museum/tech repos,
# the auto-switch activates two ways —
#   1. automatically: the 18-machine-selfheal session hook runs this script on
#      the next `agent mode` / session start (when direnv is present + the map has
#      active entries), so no manual step is needed after filling the map; or
#   2. manually, any time: scripts/setup_org_envrc.sh
#
# Usage:
#   scripts/setup_org_envrc.sh [--dry-run]
#
# Testability / callers (env overrides, all optional):
#   SETUP_ORG_ENVRC_LIB_ONLY=1   source the pure helpers only; run nothing (tests)
#   SETUP_ORG_ENVRC_MAP=<path>       override the org map path
#   SETUP_ORG_ENVRC_MANAGED=<path>   override the managed_repos.txt path
#   SETUP_ORG_ENVRC_REPO_ROOT=<dir>  override the resolved repo root
#
# bash 3.2-safe (while-read + awk lookup, no mapfile/assoc-arrays).
# See documentation/MULTI_ORG_WORKFLOW.md + plan/MULTI_ORG_AUTH.md (Phase 2).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="${SETUP_ORG_ENVRC_REPO_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
MAP="${SETUP_ORG_ENVRC_MAP:-$REPO_ROOT/config/repo_org_map.txt}"
MANAGED="${SETUP_ORG_ENVRC_MANAGED:-$REPO_ROOT/config/managed_repos.txt}"

say() { printf '%s\n' "$*"; }

# Resolve a map entry (absolute path OR repo basename) to an existing directory.
# Prints the resolved dir on stdout, or nothing if it can't be found.
resolve_dir() {
  target="$1"
  # Expand a leading ~ to $HOME.
  case "$target" in "~"*) target="$HOME${target#\~}" ;; esac
  # 1. Already an existing absolute/relative dir.
  if [ -d "$target" ]; then ( cd "$target" && pwd ); return; fi
  # 2. Basename match against managed_repos.txt.
  if [ -f "$MANAGED" ]; then
    while IFS= read -r line; do
      case "$line" in ''|\#*) continue ;; esac
      # Strip a trailing inline "# comment" (managed_repos.txt has annotated rows).
      cand="${line%%#*}"
      cand="$(printf '%s' "$cand" | awk '{print $1}')"
      [ -z "$cand" ] && continue
      case "$cand" in "~"*) cand="$HOME${cand#\~}" ;; esac
      if [ "$(basename "$cand")" = "$target" ] && [ -d "$cand" ]; then
        ( cd "$cand" && pwd ); return
      fi
    done < "$MANAGED"
  fi
  # Not found — print nothing.
}

org_dir_for() {
  case "$1" in
    museum)   printf '%s' "$HOME/.claude-museum" ;;
    tech)     printf '%s' "$HOME/.claude-tech" ;;
    personal) printf '%s' "" ;;   # bare default — no .envrc
    *)        printf '%s' "" ;;
  esac
}

# Count of active (uncommented, non-blank) map entries. Callers (machine_selfheal)
# use this to decide whether there is anything to activate at all.
active_map_entries() {
  [ -f "$MAP" ] || { printf '0'; return; }
  awk 'NF && $1 !~ /^#/' "$MAP" 2>/dev/null | wc -l | tr -d ' '
}

# Lib-only mode: expose the pure helpers for unit tests / callers, run nothing.
if [ "${SETUP_ORG_ENVRC_LIB_ONLY:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

main() {
  DRY_RUN=0
  [ "${1:-}" = "--dry-run" ] && DRY_RUN=1

  say "== Multi-Org-Auth Phase 2 — per-repo direnv .envrc =="
  [ "$DRY_RUN" = "1" ] && say "(dry-run — no changes will be made)"
  say ""

  if [ ! -f "$MAP" ]; then
    say "No org map at $MAP — nothing to do."
    exit 0
  fi

  # direnv availability — non-fatal. Without it we still write .envrc + exclude,
  # and print the allow command the user can run once direnv is installed.
  HAS_DIRENV=0
  if command -v direnv >/dev/null 2>&1; then
    HAS_DIRENV=1
  else
    say "NOTE: direnv not on PATH — .envrc files will be written but not 'allow'ed."
    say "      Install with 'brew install direnv' + add the zsh hook, then re-run."
    say ""
  fi

  WROTE=0; SKIPPED=0; UNRESOLVED=0; PERSONAL=0

  while IFS= read -r line; do
    case "$line" in ''|\#*) continue ;; esac
    # First whitespace-delimited field = repo, second = org key.
    repo=$(printf '%s' "$line" | awk '{print $1}')
    orgkey=$(printf '%s' "$line" | awk '{print $2}')
    [ -z "$repo" ] && continue
    [ -z "$orgkey" ] && { say "  ! no org-key for '$repo' — skipping"; SKIPPED=$((SKIPPED+1)); continue; }

    if [ "$orgkey" = "personal" ]; then
      say "  · $repo -> personal (bare default, no .envrc needed)"
      PERSONAL=$((PERSONAL+1)); continue
    fi

    cfgdir=$(org_dir_for "$orgkey")
    if [ -z "$cfgdir" ]; then
      say "  ! unknown org-key '$orgkey' for '$repo' — skipping"
      SKIPPED=$((SKIPPED+1)); continue
    fi

    dir=$(resolve_dir "$repo")
    if [ -z "$dir" ]; then
      say "  ! could not resolve repo '$repo' to a directory on this machine — skipping"
      UNRESOLVED=$((UNRESOLVED+1)); continue
    fi

    envrc="$dir/.envrc"
    desired="# Multi-Org-Auth Phase 2 — auto-select Claude org for this repo ($orgkey).
# Machine-local, gitignored (see .git/info/exclude). Managed by setup_org_envrc.sh.
export CLAUDE_CONFIG_DIR=\"$cfgdir\""

    # Write only if missing or content differs (idempotent).
    if [ -f "$envrc" ] && [ "$(cat "$envrc")" = "$desired" ]; then
      say "  = $dir/.envrc up to date ($orgkey)"
    else
      if [ "$DRY_RUN" = "1" ]; then
        say "  [dry-run] would write $envrc ($orgkey -> $cfgdir)"
      else
        printf '%s\n' "$desired" > "$envrc"
        say "  + wrote $envrc ($orgkey -> $cfgdir)"
      fi
      WROTE=$((WROTE+1))
    fi

    # Keep .envrc out of git (machine-local). Use .git/info/exclude so we never
    # touch a tracked .gitignore. Idempotent.
    gitdir="$dir/.git"
    if [ -d "$gitdir" ]; then
      exclude="$gitdir/info/exclude"
      if [ "$DRY_RUN" = "1" ]; then
        grep -qxF ".envrc" "$exclude" 2>/dev/null || say "  [dry-run] would add '.envrc' to $exclude"
      else
        mkdir -p "$gitdir/info"
        grep -qxF ".envrc" "$exclude" 2>/dev/null || printf '.envrc\n' >> "$exclude"
      fi
    fi

    # Allow the .envrc so direnv loads it (only meaningful after a write/change).
    if [ "$HAS_DIRENV" = "1" ]; then
      if [ "$DRY_RUN" = "1" ]; then
        say "  [dry-run] would run: direnv allow $dir"
      else
        ( cd "$dir" && direnv allow ) && say "    direnv allow ✓"
      fi
    else
      say "    (run later) direnv allow $dir"
    fi
  done < "$MAP"

  say ""
  say "== Summary =="
  say "  written/updated : $WROTE"
  say "  personal (skip) : $PERSONAL"
  say "  bad org-key     : $SKIPPED"
  say "  unresolved repo : $UNRESOLVED"
  say ""
  if [ "$WROTE" = "0" ] && [ "$PERSONAL" = "0" ] && [ "$SKIPPED" = "0" ] && [ "$UNRESOLVED" = "0" ]; then
    say "Org map has no active (uncommented) entries yet — fill in config/repo_org_map.txt"
    say "with your museum/tech repos, then re-run this script (or start a new session:"
    say "the machine-selfheal hook activates it automatically once the map is filled)."
  fi
}

main "$@"
