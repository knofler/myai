#!/usr/bin/env bash
# myai_mcp.sh — `myai mcp <subcommand>`: propagate the MCP server config through
# the installed module instead of an update_all file-copy.
#
# WHY THIS EXISTS (ADR-016 follow-up, 2026-07-21):
# .mcp.json was the ONLY reason update_all.sh / sync_mcp_to_org.sh survived the
# myAI-native migration. Every other framework asset (agents/skills/hooks/rule
# bodies) resolves from the installed ai-management module at runtime, but
# Claude Code reads .mcp.json from DISK at startup — so the file itself has to
# exist on disk, per-repo AND in each org config dir. This command makes BOTH
# writes flow through the module's bundled templates/mcp.json, so a framework
# MCP change reaches the fleet via `npm i -g ai-management` + these commands —
# no `AI/` folder copy, no master checkout required.
#
# Subcommands:
#   myai mcp print                      Print the module's bundled base config.
#   myai mcp repo [path]                Write/refresh a repo's ./​.mcp.json by
#                                       deep-merging the module template into it
#                                       (framework servers canonical, any custom
#                                       servers the repo added are preserved).
#                                       Defaults to the current directory.
#   myai mcp vscode [path]              Same deep-merge, but for VS Code's own
#                                       schema: ./.vscode/mcp.json ({"servers":{}}),
#                                       from templates/vscode-mcp.json. Gives
#                                       Copilot/Codex-in-VS-Code agent mode the
#                                       same myai stdio bridge Claude Code gets.
#                                       Defaults to the current directory.
#   myai mcp sync [<name>|all]
#                                       Refresh the per-org Claude config dirs
#                                       (~/.claude-<name>/.mcp.json)
#                                       from the module template. Wraps
#                                       sync_mcp_to_org.sh with the module's
#                                       templates/mcp.json as the source, so the
#                                       org dirs no longer depend on the master
#                                       repo's .mcp.json. Default target: all.
#
# Flags (forwarded where meaningful): --dry-run
#
# Source override (mainly for tests / an operator who wants the master repo's
# fuller .mcp.json instead of the base template):
#   MYAI_MCP_SOURCE=/path/to/mcp.json   use this file as the merge/sync source
#
# Library mode (unit tests): MYAI_MCP_LIB_ONLY=1 sources the pure helpers only.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TEMPLATES_DIR="$REPO_ROOT/templates"

# The module's bundled base MCP config is the propagation source of truth. An
# operator (or a test) can point at a different file via MYAI_MCP_SOURCE.
MCP_SOURCE="${MYAI_MCP_SOURCE:-$TEMPLATES_DIR/mcp.json}"

# ── Colours (no green — AI_RULES §13) ─────────────────────────────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; CYAN=$'\033[38;5;45m'; RESET=$'\033[0m'
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1"; }

usage() {
  cat >&2 <<EOF
Usage: myai mcp <subcommand> [args]

  print                                 Print the module's bundled MCP config.
  repo [path] [--dry-run]               Write/refresh a repo's .mcp.json from the
                                        module template (deep-merge; custom
                                        servers preserved). Default: current dir.
  add <name>... [--repo <dir>] [--dry-run]
                                        Add opt-in servers (templates/mcp-optional.json:
                                        shadcn-ui, playwright, dropbox, github,
                                        vercel — or 'all') to a repo's .mcp.json.
  add --list [--repo <dir>]             List the opt-in servers (* = already in the repo).
  vscode [path] [--dry-run]             Same, for VS Code's .vscode/mcp.json
                                        (Copilot/Codex-in-VS-Code agent mode).
  sync [<name>|all] [--dry-run]
                                        Refresh the per-org Claude config dirs
                                        from the module template. Default: all.

Source: $MCP_SOURCE
  (override with MYAI_MCP_SOURCE=/path/to/mcp.json)
EOF
  exit 1
}

# ── mcp_merge_into TARGET → merge the module template into TARGET in place ─────
# Deep-merge via the shared json_merge.py policy (framework keys canonical,
# repo-local additions preserved, idempotent write, invalid target left alone).
# Echoes the verdict word (created|changed|unchanged) or an error line.
mcp_merge_into() {
  local target="$1" rc=0 out
  out=$(/usr/bin/python3 "$SCRIPT_DIR/lib/json_merge.py" "$target" "$MCP_SOURCE" 2>&1) || rc=$?
  printf '%s:%s' "$rc" "$out"
}

# ── mcp_optional_pick SRC OUT NAME... → write {"mcpServers":{…}} holding the
# named servers from SRC (templates/mcp-optional.json; `all` = every one) to
# OUT. Exit 2 + the available names on stderr when a name is unknown.
mcp_optional_pick() {
  local src="$1" out="$2"; shift 2
  /usr/bin/python3 - "$src" "$out" "$@" <<'PY'
import json, sys
src, out, names = sys.argv[1], sys.argv[2], sys.argv[3:]
avail = json.load(open(src)).get("mcpServers") or {}
if "all" in names:
    names = list(avail)
unknown = [n for n in names if n not in avail]
if unknown:
    sys.stderr.write("unknown server(s): %s — available: %s\n" % (", ".join(unknown), ", ".join(avail)))
    sys.exit(2)
json.dump({"mcpServers": {n: avail[n] for n in names}}, open(out, "w"), indent=2)
PY
}

# Sourced by the test suite — stop before the executable body.
[ "${MYAI_MCP_LIB_ONLY:-0}" = 1 ] && return 0 2>/dev/null

# ── Subcommand dispatch ───────────────────────────────────────────────────────
[ "$#" -ge 1 ] || usage
SUB="$1"; shift

case "$SUB" in
  -h|--help|help) usage ;;

  print)
    [ -f "$MCP_SOURCE" ] || { c_warn "MCP source not found: $MCP_SOURCE"; exit 1; }
    cat "$MCP_SOURCE"
    ;;

  repo)
    DRY_RUN=0
    TARGET_DIR=""
    for arg in "$@"; do
      case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -*)        : ;;   # forward-compat: ignore unknown flags
        *)         [ -z "$TARGET_DIR" ] && TARGET_DIR="$arg" ;;
      esac
    done
    [ -n "$TARGET_DIR" ] || TARGET_DIR="$(pwd)"
    [ -d "$TARGET_DIR" ] || { c_warn "not a directory: $TARGET_DIR"; exit 1; }
    [ -f "$MCP_SOURCE" ] || { c_warn "MCP source not found: $MCP_SOURCE"; exit 1; }
    DST="$(cd "$TARGET_DIR" && pwd)/.mcp.json"

    if [ "$DRY_RUN" = 1 ]; then
      rc=0; out=$(/usr/bin/python3 "$SCRIPT_DIR/lib/json_merge.py" "$DST" "$MCP_SOURCE" --check 2>&1) || rc=$?
      case "${rc}:${out}" in
        0:created)   c_info "[dry-run] would create $DST from module template" ;;
        0:changed)   c_info "[dry-run] would refresh $DST (framework servers canonical, custom preserved)" ;;
        0:unchanged) c_info "[dry-run] $DST already current" ;;
        *)           c_warn "[dry-run] $DST would be left untouched ($out)" ;;
      esac
      exit 0
    fi

    verdict="$(mcp_merge_into "$DST")"
    case "$verdict" in
      0:created)   c_ok "wrote $DST from module template" ;;
      0:changed)   c_ok "refreshed $DST (framework servers canonical, custom preserved)" ;;
      0:unchanged) c_info "$DST already current — left untouched" ;;
      *)           c_warn "$DST left untouched (${verdict#*:})"; exit 1 ;;
    esac
    ;;

  add)
    OPT_SOURCE="${MYAI_MCP_OPTIONAL_SOURCE:-$TEMPLATES_DIR/mcp-optional.json}"
    [ -f "$OPT_SOURCE" ] || { c_warn "opt-in MCP source not found: $OPT_SOURCE"; exit 1; }
    DRY_RUN=0; LIST=0; TARGET_DIR=""; NAMES=()
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --dry-run) DRY_RUN=1 ;;
        --list)    LIST=1 ;;
        --repo)    [ "$#" -ge 2 ] || { c_warn "--repo needs a directory"; exit 1; }
                   TARGET_DIR="$2"; shift ;;
        -*)        : ;;
        *)         NAMES+=("$1") ;;
      esac
      shift
    done
    [ -n "$TARGET_DIR" ] || TARGET_DIR="$(pwd)"
    [ -d "$TARGET_DIR" ] || { c_warn "not a directory: $TARGET_DIR"; exit 1; }
    DST="$(cd "$TARGET_DIR" && pwd)/.mcp.json"

    if [ "$LIST" = 1 ]; then
      /usr/bin/python3 - "$OPT_SOURCE" "$DST" <<'PY'
import json, os, sys
avail = json.load(open(sys.argv[1])).get("mcpServers") or {}
have = {}
if os.path.isfile(sys.argv[2]):
    try: have = json.load(open(sys.argv[2])).get("mcpServers") or {}
    except Exception: pass
for name, cfg in avail.items():
    where = cfg.get("url") or " ".join([cfg.get("command", "")] + [a for a in cfg.get("args", []) if a != "-y"])
    print("  %s %-10s %s" % ("*" if name in have else " ", name, where))
print("\n  * = already in %s · add with: myai mcp add <name>... (or all)" % sys.argv[2])
PY
      exit 0
    fi

    [ "${#NAMES[@]}" -gt 0 ] || { c_warn "name at least one server (or 'all') — see: myai mcp add --list"; exit 1; }
    # Never write a .mcp.json that lacks the myai bridge: the base comes first.
    [ -f "$DST" ] || { c_warn "$DST does not exist — run \`myai init\` (or \`myai mcp repo\`) first"; exit 1; }
    OVERLAY="$(mktemp -t mcp-add.XXXXXX)"
    trap 'rm -f "$OVERLAY"' EXIT
    mcp_optional_pick "$OPT_SOURCE" "$OVERLAY" "${NAMES[@]}" || { c_warn "nothing added"; exit 1; }

    if [ "$DRY_RUN" = 1 ]; then
      rc=0; out=$(/usr/bin/python3 "$SCRIPT_DIR/lib/json_merge.py" "$DST" "$OVERLAY" --check 2>&1) || rc=$?
      case "${rc}:${out}" in
        0:changed)   c_info "[dry-run] would add ${NAMES[*]} to $DST" ;;
        0:unchanged) c_info "[dry-run] $DST already has ${NAMES[*]}" ;;
        *)           c_warn "[dry-run] $DST would be left untouched ($out)" ;;
      esac
      exit 0
    fi

    rc=0; out=$(/usr/bin/python3 "$SCRIPT_DIR/lib/json_merge.py" "$DST" "$OVERLAY" 2>&1) || rc=$?
    case "${rc}:${out}" in
      0:changed)   c_ok "added ${NAMES[*]} to $DST — restart your agent to load them" ;;
      0:unchanged) c_info "$DST already has ${NAMES[*]} — left untouched" ;;
      *)           c_warn "$DST left untouched ($out)"; exit 1 ;;
    esac
    ;;

  vscode)
    DRY_RUN=0
    TARGET_DIR=""
    for arg in "$@"; do
      case "$arg" in
        --dry-run) DRY_RUN=1 ;;
        -*)        : ;;
        *)         [ -z "$TARGET_DIR" ] && TARGET_DIR="$arg" ;;
      esac
    done
    [ -n "$TARGET_DIR" ] || TARGET_DIR="$(pwd)"
    [ -d "$TARGET_DIR" ] || { c_warn "not a directory: $TARGET_DIR"; exit 1; }
    VSCODE_SOURCE="${MYAI_VSCODE_MCP_SOURCE:-$TEMPLATES_DIR/vscode-mcp.json}"
    [ -f "$VSCODE_SOURCE" ] || { c_warn "VS Code MCP source not found: $VSCODE_SOURCE"; exit 1; }
    DST="$(cd "$TARGET_DIR" && pwd)/.vscode/mcp.json"
    mkdir -p "$(dirname "$DST")"

    if [ "$DRY_RUN" = 1 ]; then
      rc=0; out=$(/usr/bin/python3 "$SCRIPT_DIR/lib/json_merge.py" "$DST" "$VSCODE_SOURCE" --check 2>&1) || rc=$?
      case "${rc}:${out}" in
        0:created)   c_info "[dry-run] would create $DST from module template" ;;
        0:changed)   c_info "[dry-run] would refresh $DST (framework servers canonical, custom preserved)" ;;
        0:unchanged) c_info "[dry-run] $DST already current" ;;
        *)           c_warn "[dry-run] $DST would be left untouched ($out)" ;;
      esac
      exit 0
    fi

    rc=0; out=$(/usr/bin/python3 "$SCRIPT_DIR/lib/json_merge.py" "$DST" "$VSCODE_SOURCE" 2>&1) || rc=$?
    case "${rc}:${out}" in
      0:created)   c_ok "wrote $DST from module template" ;;
      0:changed)   c_ok "refreshed $DST (framework servers canonical, custom preserved)" ;;
      0:unchanged) c_info "$DST already current — left untouched" ;;
      *)           c_warn "$DST left untouched ($out)"; exit 1 ;;
    esac
    ;;

  sync)
    # Delegate to the existing org-dir sync, but source the MODULE template
    # (not the master repo's .mcp.json) so the org dirs propagate via the npm
    # module. sync_mcp_to_org.sh honours SYNC_MCP_SOURCE; its per-org filtering
    # (config/mcp_org_sets.txt) still applies if that config is present.
    SYNC="$SCRIPT_DIR/sync_mcp_to_org.sh"
    [ -f "$SYNC" ] || { c_warn "sync_mcp_to_org.sh not found next to this script"; exit 1; }
    [ -f "$MCP_SOURCE" ] || { c_warn "MCP source not found: $MCP_SOURCE"; exit 1; }
    # Default target is 'all' when the caller passes only flags / nothing.
    HAS_TARGET=0
    for arg in "$@"; do
      case "$arg" in -*) ;; *) HAS_TARGET=1 ;; esac
    done
    if [ "$HAS_TARGET" = 0 ]; then set -- "$@" all; fi
    c_info "syncing org config dirs from module template: $MCP_SOURCE"
    SYNC_MCP_SOURCE="$MCP_SOURCE" exec bash "$SYNC" "$@"
    ;;

  *)
    c_warn "unknown subcommand: $SUB"
    usage
    ;;
esac
