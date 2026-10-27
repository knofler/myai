#!/usr/bin/env bash
# operator_defaults.sh — who this install belongs to, for setup scripts that
# must reach the user's OWN GitHub repos (v1 G1: no operator data in shipped
# defaults). Sourced by scripts/new_mac_setup.sh; bash 3.2-safe.
#
#   MYAI_BRAIN_REMOTE  the user's existing brain repo (git URL). No default:
#                      a stranger is asked, or the step is skipped.
#   MYAI_SWARM_LEGACY_ORDER  lane order for the one-time swarm-master migration
#                      of hosts that ran a swarm before per-device config
#                      (scripts/swarm_master_set.sh). Default: derived on disk.
#   MYAI_PROFILES      the named Claude profiles (~/.claude-<name>) this
#                      user's Macs carry, space-separated; setup scripts
#                      create/manage exactly these (swarm_roles.sh
#                      role_profile_names). Default: the dirs on disk.
#   MYAI_GIT_OWNER     the GitHub account their repos live under. Default:
#                      the signed-in gh user (same rule as
#                      scripts/restore_git_metadata.sh).
#
# An exported value always wins. Otherwise they come from the first operator
# defaults file found: $MYAI_OPERATOR_DEFAULTS (=none → no file), else
# <repo>/config/operator_defaults.conf, else ~/.myai/operator_defaults.conf.
# That file is NOT shipped (not in package.json `files`, listed in
# .npmignore), so the operator's Macs keep their values and nobody else gets
# them. Format: KEY=value lines; # comments; only the keys above are read —
# the file is parsed, never sourced.

OPERATOR_DEFAULT_KEYS="MYAI_BRAIN_REMOTE MYAI_GIT_OWNER MYAI_SWARM_LEGACY_ORDER MYAI_PROFILES"

# operator_defaults_file <repo root> → the file to read, or nothing.
operator_defaults_file() {
  local root="${1:-.}" f
  case "${MYAI_OPERATOR_DEFAULTS:-}" in
    none) return 0 ;;
    '') ;;
    *) [ -f "$MYAI_OPERATOR_DEFAULTS" ] && printf '%s\n' "$MYAI_OPERATOR_DEFAULTS"; return 0 ;;
  esac
  for f in "$root/config/operator_defaults.conf" "${MYAI_HOME:-$HOME/.myai}/operator_defaults.conf"; do
    if [ -f "$f" ]; then printf '%s\n' "$f"; return 0; fi
  done
}

# operator_defaults_load <repo root> — export each known key the environment
# does not already set, from the operator defaults file (if any).
operator_defaults_load() {
  local f line key val
  f="$(operator_defaults_file "${1:-.}")"
  [ -n "$f" ] || return 0
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    key="${line%%=*}"; val="${line#*=}"
    [ "$key" != "$line" ] || continue
    case " $OPERATOR_DEFAULT_KEYS " in *" $key "*) ;; *) continue ;; esac
    val="${val%\"}"; val="${val#\"}"
    if [ -z "${!key:-}" ] && [ -n "$val" ]; then export "$key=$val"; fi
  done < "$f"
}

# resolve_git_owner → MYAI_GIT_OWNER, else the signed-in gh user, else nothing.
resolve_git_owner() {
  if [ -n "${MYAI_GIT_OWNER:-}" ]; then printf '%s\n' "$MYAI_GIT_OWNER"; return 0; fi
  command -v gh >/dev/null 2>&1 && gh api user --jq .login 2>/dev/null || true
}

# brain_remote_candidates <url> → the URL, then its https twin when it is a
# GitHub ssh URL (tried in order: a Mac without ssh keys yet still clones).
brain_remote_candidates() {
  local url="${1:-}"
  [ -n "$url" ] || return 0
  printf '%s\n' "$url"
  case "$url" in
    git@github.com:*) printf 'https://github.com/%s\n' "${url#git@github.com:}" ;;
  esac
}
