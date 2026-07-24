#!/usr/bin/env bash
# sync_mcp_to_org.sh — Multi-Org-Auth Phase 3: sync MCP server configs to per-org config dirs.
#
# Copies the appropriate .mcp.json into each org's CLAUDE_CONFIG_DIR so that
# MCP servers are available when launching Claude under any org alias.
#
# Per-org filtering: config/mcp_org_sets.txt maps each org to a policy —
#   all | allow:<name,...> | deny:<name,...>
# The base .mcp.json's "mcpServers" block is filtered accordingly (jq) before
# landing in the org dir, so Enterprise (museum) gets the scoped set while
# Team/personal keep the looser one. Orgs without a policy default to 'all'.
# Filtering requires jq; if jq is missing a non-'all' org is SKIPPED (fail
# closed — never hand a scoped org the unfiltered config).
#
# Usage:
#   ./scripts/sync_mcp_to_org.sh museum          # sync to museum only
#   ./scripts/sync_mcp_to_org.sh tech             # sync to tech only
#   ./scripts/sync_mcp_to_org.sh personal         # sync to personal only
#   ./scripts/sync_mcp_to_org.sh all              # sync to all three
#   ./scripts/sync_mcp_to_org.sh all --dry-run    # preview without changes
#   ./scripts/sync_mcp_to_org.sh --dry-run all    # flag order doesn't matter
#
# Idempotent and safe to re-run — overwrites the target .mcp.json each time
# with the current master config.
#
# A repo's org is resolved from config/repo_org_map.txt (the same map hook 16 and
# setup_org_envrc.sh use): org_for_repo() + connectors_for_repo() let any caller
# ask "which MCP connectors should THIS repo's org expose?" without duplicating
# the map-parsing logic. The sync itself is keyed by org (MCP is per config dir),
# but the repo→org→allow-list chain is the machinery that ties the two configs
# together.
#
# Test / library mode (mirrors setup_org_envrc.sh):
#   SYNC_MCP_LIB_ONLY=1        source the pure helpers only; run nothing (tests)
#   SYNC_MCP_SOURCE=<path>     override the base .mcp.json path
#   SYNC_MCP_ORG_SETS=<path>   override the mcp_org_sets.txt path
#   SYNC_MCP_REPO_ORG_MAP=<p>  override the repo_org_map.txt path
#
# bash 3.2-safe (no associative arrays).
# See plan/MULTI_ORG_AUTH.md Phase 3 and documentation/MULTI_ORG_WORKFLOW.md.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MCP_SOURCE="${SYNC_MCP_SOURCE:-$REPO_ROOT/.mcp.json}"
ORG_SETS_FILE="${SYNC_MCP_ORG_SETS:-$REPO_ROOT/config/mcp_org_sets.txt}"
REPO_ORG_MAP="${SYNC_MCP_REPO_ORG_MAP:-$REPO_ROOT/config/repo_org_map.txt}"

# Per-org config dirs (must match setup_org_dirs.sh)
MUSEUM_DIR="$HOME/.claude-museum"
TECH_DIR="$HOME/.claude-tech"
PERSONAL_DIR="$HOME/.claude-personal"

# Org keys and their config dirs — parallel arrays (bash 3.2-safe)
ORG_KEYS="museum tech personal"
# Resolved per key in resolve_dir()

DRY_RUN=0
TARGET=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
say()  { printf '%s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die()  { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# Run a command, or print it under --dry-run.
do_it() {
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] $*"
  else
    "$@"
  fi
}

resolve_dir() {
  case "$1" in
    museum)   echo "$MUSEUM_DIR"   ;;
    tech)     echo "$TECH_DIR"     ;;
    personal) echo "$PERSONAL_DIR" ;;
    *)        die "unknown org key: $1" ;;
  esac
}

# Resolve an org's filter policy from config/mcp_org_sets.txt.
# Policies: all | allow:<csv> | deny:<csv>. Unlisted orgs default to 'all'.
# Last matching line wins. bash 3.2-safe (while-read, no assoc arrays).
policy_for() {
  _org="$1"
  _policy="all"
  if [ -f "$ORG_SETS_FILE" ]; then
    while read -r _k _v _rest; do
      case "$_k" in ''|\#*) continue ;; esac
      if [ "$_k" = "$_org" ] && [ -n "${_v:-}" ]; then
        _policy="$_v"
      fi
    done < "$ORG_SETS_FILE"
  fi
  printf '%s' "$_policy"
}

# Warn about allow/deny entries that don't exist in the base .mcp.json
# (typo guard — non-fatal, the filter just won't match them).
check_names() {
  _org="$1"
  _csv="$2"
  _base_names=$(jq -r '.mcpServers | keys[]' "$MCP_SOURCE" 2>/dev/null) || return 0
  for _n in $(printf '%s' "$_csv" | tr ',' ' '); do
    [ -z "$_n" ] && continue
    if ! printf '%s\n' "$_base_names" | grep -qx "$_n"; then
      warn "org '$_org': server '$_n' is not in the base .mcp.json (typo in $ORG_SETS_FILE?)"
    fi
  done
}

# Emit the base config filtered by a policy, on stdout. Requires jq for
# allow:/deny: policies (callers must check jq availability first).
filtered_config() {
  _policy="$1"
  case "$_policy" in
    all)
      cat "$MCP_SOURCE"
      ;;
    allow:*)
      jq --arg names "${_policy#allow:}" \
        '.mcpServers |= with_entries(select(.key as $k | ($names | split(",")) | index($k)))' \
        "$MCP_SOURCE"
      ;;
    deny:*)
      jq --arg names "${_policy#deny:}" \
        '.mcpServers |= with_entries(select(.key as $k | ($names | split(",")) | index($k) | not))' \
        "$MCP_SOURCE"
      ;;
    *)
      return 1
      ;;
  esac
}

# List the server names in a JSON config file, comma-separated (best effort).
server_list() {
  jq -r '.mcpServers | keys | join(", ")' "$1" 2>/dev/null || printf 'unreadable'
}

# Resolve a repo (absolute git-toplevel path OR repo basename) to its org key
# from config/repo_org_map.txt. Mirrors hooks/session/16-org-context.sh: match by
# full path first, then basename; comments/blank lines skipped; unmapped repos
# default to 'personal'. bash 3.2-safe (while-read + awk, no assoc arrays).
org_for_repo() {
  _repo="$1"
  _base=$(basename "$_repo")
  _org="personal"
  if [ -f "$REPO_ORG_MAP" ]; then
    while IFS= read -r _line; do
      _trimmed=${_line#"${_line%%[![:space:]]*}"}
      case "$_trimmed" in ''|\#*) continue ;; esac
      _key=$(printf '%s\n' "$_line" | awk '{print $1}')
      _val=$(printf '%s\n' "$_line" | awk '{print $2}')
      [ -z "$_val" ] && continue
      if [ "$_key" = "$_repo" ] || [ "$_key" = "$_base" ]; then
        _org="$_val"
        break
      fi
    done < "$REPO_ORG_MAP"
  fi
  printf '%s' "$_org"
}

# Given a repo, return the comma-separated list of MCP connectors its org is
# allowed to expose — the full repo→org→allow-list chain. Resolves the org from
# repo_org_map, its policy from mcp_org_sets, then the filtered server names from
# the base .mcp.json. Requires jq for scoped (allow:/deny:) policies; without jq
# a scoped org yields empty (fail-closed, consistent with the sync). Best-effort;
# prints nothing on error.
connectors_for_repo() {
  _repo="$1"
  _org=$(org_for_repo "$_repo")
  _policy=$(policy_for "$_org")
  case "$_policy" in
    all|allow:?*|deny:?*) ;;
    *) return 0 ;;   # invalid policy -> empty (fail closed)
  esac
  if [ "$_policy" != "all" ] && ! command -v jq >/dev/null 2>&1; then
    return 0   # scoped policy needs jq -> fail closed
  fi
  filtered_config "$_policy" 2>/dev/null | jq -r '.mcpServers | keys | join(",")' 2>/dev/null || return 0
}

# ---------------------------------------------------------------------------
# Library mode: stop here when sourced by the test suite (helpers only).
# ---------------------------------------------------------------------------
if [ "${SYNC_MCP_LIB_ONLY:-}" = "1" ]; then
  return 0 2>/dev/null || exit 0
fi

usage() {
  say "Usage: $0 <museum|tech|personal|all> [--dry-run]"
  say "       $0 --dry-run <museum|tech|personal|all>"
  say ""
  say "Per-org connector sets are defined in config/mcp_org_sets.txt."
  exit 1
}

main() {
# ---------------------------------------------------------------------------
# Parse args (order-independent: flag and target can appear in either position)
# ---------------------------------------------------------------------------
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    museum|tech|personal|all) TARGET="$arg" ;;
    -h|--help) usage ;;
    *) die "unknown argument: $arg" ;;
  esac
done

[ -z "$TARGET" ] && usage

# ---------------------------------------------------------------------------
# Validate source
# ---------------------------------------------------------------------------
[ -f "$MCP_SOURCE" ] || die "MCP source not found: $MCP_SOURCE"

# ---------------------------------------------------------------------------
# Build list of orgs to process
# ---------------------------------------------------------------------------
if [ "$TARGET" = "all" ]; then
  TARGETS="$ORG_KEYS"
else
  TARGETS="$TARGET"
fi

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
say "== Multi-Org-Auth Phase 3: sync MCP configs =="
[ "$DRY_RUN" = "1" ] && say "(dry-run — no changes will be made)"
say ""
say "Source:   $MCP_SOURCE"
if [ -f "$ORG_SETS_FILE" ]; then
  say "Org sets: $ORG_SETS_FILE"
else
  say "Org sets: (none — $ORG_SETS_FILE missing, every org gets the full config)"
fi
say ""

HAVE_JQ=0
command -v jq >/dev/null 2>&1 && HAVE_JQ=1

SYNCED=0
SKIPPED=0

for org in $TARGETS; do
  cfg_dir=$(resolve_dir "$org")
  dest="$cfg_dir/.mcp.json"

  say "--- $org ($cfg_dir) ---"

  # Check that the config dir exists (created by setup_org_dirs.sh Phase 1)
  if [ ! -d "$cfg_dir" ]; then
    warn "config dir does not exist: $cfg_dir (run setup_org_dirs.sh first) — skipping"
    SKIPPED=$((SKIPPED + 1))
    say ""
    continue
  fi

  # Resolve + validate this org's filter policy
  policy=$(policy_for "$org")
  case "$policy" in
    all|allow:?*|deny:?*) ;;
    *)
      warn "org '$org': invalid policy '$policy' in $ORG_SETS_FILE (expected all | allow:<csv> | deny:<csv>) — skipping"
      SKIPPED=$((SKIPPED + 1))
      say ""
      continue
      ;;
  esac
  say "  policy: $policy"

  if [ "$policy" != "all" ] && [ "$HAVE_JQ" = "0" ]; then
    # Fail closed: a scoped org must never receive the unfiltered config.
    warn "org '$org': jq is required to filter (policy '$policy') but jq is not installed — skipping"
    SKIPPED=$((SKIPPED + 1))
    say ""
    continue
  fi

  if [ "$policy" != "all" ] && [ "$HAVE_JQ" = "1" ]; then
    csv="$policy"; csv="${csv#allow:}"; csv="${csv#deny:}"
    check_names "$org" "$csv"
  fi

  # Write the (filtered) config atomically: tmp file in the target dir, then mv.
  if [ "$DRY_RUN" = "1" ]; then
    say "  [dry-run] would write $dest"
    if [ "$HAVE_JQ" = "1" ]; then
      say "  [dry-run] servers: $(filtered_config "$policy" | jq -r '.mcpServers | keys | join(", ")')"
    fi
  else
    tmp="$cfg_dir/.mcp.json.tmp.$$"
    if ! filtered_config "$policy" > "$tmp"; then
      rm -f "$tmp"
      warn "org '$org': filtering failed (policy '$policy') — existing config left untouched"
      SKIPPED=$((SKIPPED + 1))
      say ""
      continue
    fi
    mv "$tmp" "$dest"
    say "  wrote: $dest"
    [ "$HAVE_JQ" = "1" ] && say "  servers: $(server_list "$dest")"
  fi
  SYNCED=$((SYNCED + 1))
  say ""
done

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
say "== Summary =="
say "   synced:  $SYNCED"
say "   skipped: $SKIPPED"
if [ "$SYNCED" -gt 0 ] && [ "$DRY_RUN" = "0" ]; then
  say ""
  say "MCP configs are now in place. Next session launched via claude-museum,"
  say "claude-tech, or claude-personal will pick up these servers."
fi
if [ "$SKIPPED" -gt 0 ]; then
  say ""
  say "Skipped orgs need their config dirs created first:"
  say "   ./scripts/setup_org_dirs.sh"
fi
}

main "$@"
