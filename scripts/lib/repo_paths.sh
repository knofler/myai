#!/usr/bin/env bash
# repo_paths.sh — ADR-021 Phase 3: THE shared fleet-roster resolver for shell
# consumers. Source this instead of parsing config/managed_repos.txt directly.
#
#   . "$REPO_ROOT/scripts/lib/repo_paths.sh"
#   repo_paths            # one absolute repo path per line (~ expanded, deduped)
#   repo_names            # one repo name (basename) per line
#
# Resolution order:
#   1. MANAGED_REPOS_FILE=<file>   → parse THAT file only (hermetic tests /
#      explicit override; never touches the network).
#   2. Gateway DB roster           → GET /api/repos/paths (tenant `repos`
#      collection ∪ txt seed, resolved server-side; the authority per ADR-021).
#      Skipped when MYAI_REPOS_NO_GATEWAY=1 or curl/python3 are unavailable.
#   3. config/managed_repos.txt    → bootstrap-seed fallback (gateway down /
#      empty response) — same result as the pre-Phase-3 behavior.
#
# The gateway returns RAW registered paths (seed rows may start with `~`) so
# that path semantics stay host-side; `~` is expanded HERE against $HOME.
# Consumers keep their own existence/.git filters — this lib only enumerates.

_rp_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
_rp_root="$(cd "$_rp_lib_dir/../.." 2>/dev/null && pwd)"

# repo_paths_seed_file → the managed_repos.txt this checkout would use.
repo_paths_seed_file() {
  echo "${MANAGED_REPOS_FILE:-$_rp_root/config/managed_repos.txt}"
}

# _rp_from_file <file> → expand + clean one seed file (comments, blanks, ~).
_rp_from_file() {
  [ -f "$1" ] || return 0
  local line
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%%#*}"
    line="$(echo "$line" | xargs 2>/dev/null)"
    [ -n "$line" ] || continue
    printf '%s\n' "${line/#\~/$HOME}"
  done < "$1"
}

# _rp_from_gateway → raw paths from GET /api/repos/paths ("" on any failure).
_rp_from_gateway() {
  [ "${MYAI_REPOS_NO_GATEWAY:-0}" = "1" ] && return 1
  command -v curl >/dev/null 2>&1 || return 1
  command -v python3 >/dev/null 2>&1 || return 1
  # shellcheck source=gateway.sh
  . "$_rp_lib_dir/gateway.sh" 2>/dev/null || true
  local base="${GATEWAY_BASE:-http://localhost:3100}" out
  out="$(curl -sf -m "${MYAI_REPOS_TIMEOUT:-4}" "$base/api/repos/paths" \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" 2>/dev/null)" || return 1
  [ -n "$out" ] || return 1
  printf '%s' "$out" | python3 -c '
import sys, json
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
repos = d.get("repos", [])
if not repos:
    sys.exit(1)
for r in repos:
    p = (r.get("path") or "").strip()
    if p:
        print(p)
' 2>/dev/null
}

# repo_paths → the fleet roster, one absolute path per line, deduped.
repo_paths() {
  # 1. explicit file override — hermetic mode, no network
  if [ -n "${MANAGED_REPOS_FILE:-}" ]; then
    _rp_from_file "$MANAGED_REPOS_FILE" | awk '!seen[$0]++'
    return 0
  fi
  # 2. gateway DB roster (authority)
  local gw
  gw="$(_rp_from_gateway)"
  if [ -n "$gw" ]; then
    local line
    printf '%s\n' "$gw" | while IFS= read -r line; do
      [ -n "$line" ] || continue
      printf '%s\n' "${line/#\~/$HOME}"
    done | awk '!seen[$0]++'
    return 0
  fi
  # 3. bootstrap-seed fallback
  _rp_from_file "$(repo_paths_seed_file)" | awk '!seen[$0]++'
}

# repo_names → roster names (basename of each path), deduped.
repo_names() {
  local p
  repo_paths | while IFS= read -r p; do
    [ -n "$p" ] && basename "$p"
  done | awk '!seen[$0]++'
}
