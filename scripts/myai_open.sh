#!/usr/bin/env bash
# myai_open.sh — the `myai open` jump command: resolve the right dashboard URL
# (localhost or hosted) for a named view and launch the operator's browser,
# so terminal → the relevant dashboard view is one keystroke.
#
# Usage:
#   myai open                          # dashboard root (same as `open dashboard`)
#   myai open dashboard                # dashboard root
#   myai open board [--repo NAME]      # THIS repo's board: /work?repo=<name>
#                                      #   repo auto-detected from the git checkout
#                                      #   (toplevel folder name), --repo overrides
#   myai open task <taskId>            # deep-link a queue task on /work — resolves
#                                      #   the task's tab (queue|review|orchestration|
#                                      #   deadletter|blockers) + repo via the gateway
#                                      #   when reachable; graceful /work?task=<id>
#                                      #   fallback when it is not
#   myai open repo                     # App Directory (/apps — per-repo cards)
#   myai open <page>                   # any known dashboard page by name:
#                                      #   work | fleet | apps | brain | memory |
#                                      #   system | status | projects | logs |
#                                      #   registry | search | velocity | analytics
#   myai open ... --print              # print the resolved URL instead of launching
#
# URL resolution (localhost vs hosted):
#   1. DASHBOARD_URL env (explicit env always wins over .env files)
#   2. DASHBOARD_URL / MYAI_DASHBOARD_PORT from .env (cwd, cwd/AI, module root,
#      $MYAI_STANDALONE_DIR — same lookup order as myai_queue.sh)
#   3. http://localhost:${MYAI_DASHBOARD_PORT:-3210}
#   MYAI_OPEN_SKIP_ENV_FILES=1 skips step 2 entirely (hermetic tests).
#
# Cross-platform launcher, in order:
#   MYAI_OPEN_CMD (explicit override, may carry args: e.g. "firefox --new-tab")
#   → macOS `open` → WSL `wslview`/`powershell.exe` → Linux `xdg-open`
#   → Windows Git-Bash/MSYS/Cygwin `cmd.exe /c start` → $BROWSER
#   → no opener found: print the URL (exit 0) so a headless session still
#     delivers something clickable.
#
# Exit codes: 0 success (URL opened or printed), 1 launcher failure, 2 usage.
#
# Library mode (unit tests): MYAI_OPEN_LIB_ONLY=1 sources the pure helpers
# (resolve_base_url / resolve_repo_name / tab_for_status / resolve_url /
# launch_url) without running main.
#
# Colours follow AI_RULES §13 — orange = good (never green), yellow = warn,
# red = bad, cyan = info. bash 3.2-safe (macOS default bash).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CALLER_PWD="$PWD"

# JSON parsing runs on node, not python — myai ships as an npm CLI, so node ≥20
# is by definition present wherever `myai open` runs (see myai_queue.sh).
NODE="$(command -v node || echo node)"

# ── colours ───────────────────────────────────────────────────────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; RESET=$'\033[0m'
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1" >&2; }
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1" >&2; }
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1" >&2; }

print_help() { grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; }

# ── env resolution ────────────────────────────────────────────────────────────
# Explicit env must win over .env files, so capture it BEFORE sourcing any.
_env_dashboard_url="${DASHBOARD_URL:-}"
_env_dashboard_port="${MYAI_DASHBOARD_PORT:-}"
_env_mcp_port="${MYAI_MCP_PORT:-}"

if [ "${MYAI_OPEN_SKIP_ENV_FILES:-0}" != "1" ]; then
    STANDALONE_DIR="${MYAI_STANDALONE_DIR:-$HOME/.myai/standalone}"
    for _envf in "$CALLER_PWD/.env" "$CALLER_PWD/AI/.env" "$REPO_ROOT/.env" "$STANDALONE_DIR/.env"; do
        # shellcheck disable=SC1090
        [ -f "$_envf" ] && { set -a; . "$_envf" 2>/dev/null || true; set +a; }
    done
fi
[ -n "$_env_dashboard_url" ] && DASHBOARD_URL="$_env_dashboard_url"
[ -n "$_env_dashboard_port" ] && MYAI_DASHBOARD_PORT="$_env_dashboard_port"
[ -n "$_env_mcp_port" ] && MYAI_MCP_PORT="$_env_mcp_port"

MCP_PORT="${MYAI_MCP_PORT:-3100}"
MCP_URL="${MYAI_MCP_URL:-http://localhost:${MCP_PORT}/mcp}"

# x-gateway-local-token — see scripts/lib/gateway.sh
# shellcheck disable=SC1091
[ -f "$SCRIPT_DIR/lib/gateway.sh" ] && . "$SCRIPT_DIR/lib/gateway.sh"
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

# resolve_base_url → hosted DASHBOARD_URL when set, else localhost:<port>.
# Trailing slashes are stripped so path concatenation is uniform.
resolve_base_url() {
    local base="${DASHBOARD_URL:-http://localhost:${MYAI_DASHBOARD_PORT:-3210}}"
    while [ "${base%/}" != "$base" ]; do base="${base%/}"; done
    printf '%s' "$base"
}

# resolve_repo_name → the fleet-standard repo identity: the checkout's folder
# name (git toplevel basename), falling back to the cwd basename outside git.
resolve_repo_name() {
    local top
    top="$(git -C "$CALLER_PWD" rev-parse --show-toplevel 2>/dev/null)" || top=""
    [ -n "$top" ] && { basename "$top"; return; }
    basename "$CALLER_PWD"
}

# tab_for_status <status> → which /work tab actually shows a task in that
# status (mirrors dashboard/src/app/work/page.tsx's per-tab Task.find filters).
tab_for_status() {
    case "${1:-}" in
        pending|paused)  printf 'queue' ;;
        review)          printf 'review' ;;
        working|done)    printf 'orchestration' ;;
        dead_letter)     printf 'deadletter' ;;
        blocked)         printf 'blockers' ;;
        *)               printf '' ;;
    esac
}

# ── gateway task lookup (best-effort; same MCP plumbing as myai_queue.sh) ────
# find_task <taskId> → prints the matching task JSON, or {"__error":"..."}.
# tasks_list has no by-ID filter, so this scans the queue client-side. Never
# fatal: any transport/auth failure resolves to __error and the caller falls
# back to an un-annotated /work?task=<id> URL.
find_task() {
    local raw
    raw="$(curl -sf -m 5 -X POST "$MCP_URL" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
        -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"tasks_list","arguments":{"limit":1000}}}' 2>/dev/null)" \
        || { printf '{"__error":"gateway not reachable"}'; return; }
    printf '%s' "$raw" | "$NODE" -e '
let out;
try {
  const resp = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (resp.error) throw new Error("gateway error");
  const parsed = JSON.parse(resp.result.content[0].text);
  if (parsed && parsed.error) throw new Error("tool error");
  const tid = process.argv[1];
  const t = (parsed.tasks ?? []).find((x) => x.taskId === tid);
  out = t ? { taskId: t.taskId, repo: t.repo || "", status: t.status || "" }
          : { __error: `task not found: ${tid}` };
} catch { out = { __error: "malformed gateway response" }; }
console.log(JSON.stringify(out));' "$1" 2>/dev/null \
        || printf '{"__error":"malformed gateway response"}'
}

# json_field <json> <key> → value or "" (node-based; no jq dependency).
json_field() {
    printf '%s' "$1" | "$NODE" -e '
try { const o = JSON.parse(require("fs").readFileSync(0, "utf8")); const v = o[process.argv[1]]; console.log(v == null ? "" : String(v)); }
catch { console.log(""); }' "$2" 2>/dev/null || true
}

# Named dashboard pages `myai open <page>` passes straight through to <base>/<page>.
# One name per line; kept to REAL routes in dashboard/src/app/ (+ stable redirects).
KNOWN_PAGES="work
fleet
apps
brain
memory
system
status
projects
logs
registry
search
velocity
analytics
swarm
recap
savings
sessions"

is_known_page() {
    local p
    for p in $KNOWN_PAGES; do [ "$p" = "$1" ] && return 0; done
    return 1
}

# resolve_url <target> [taskId] [repoOverride] → prints the resolved URL.
# Returns 2 on a usage error (unknown target / missing task id).
resolve_url() {
    local target="${1:-dashboard}" task_id="${2:-}" repo_override="${3:-}"
    local base repo
    base="$(resolve_base_url)"
    case "$target" in
        dashboard|home|'')
            printf '%s\n' "$base" ;;
        board)
            repo="${repo_override:-$(resolve_repo_name)}"
            printf '%s\n' "$base/work?repo=$repo" ;;
        repo|directory)
            printf '%s\n' "$base/apps" ;;
        task)
            if [ -z "$task_id" ]; then
                c_err "usage: myai open task <taskId>"
                return 2
            fi
            local t err status tab qs
            t="$(find_task "$task_id")"
            err="$(json_field "$t" __error)"
            if [ -n "$err" ]; then
                c_warn "could not resolve task via the gateway ($err) — opening the /work board unannotated"
                printf '%s\n' "$base/work?task=$task_id"
                return 0
            fi
            status="$(json_field "$t" status)"
            repo="$(json_field "$t" repo)"
            tab="$(tab_for_status "$status")"
            qs=""
            [ -n "$tab" ] && qs="tab=$tab&"
            [ -n "$repo" ] && qs="${qs}repo=$repo&"
            printf '%s\n' "$base/work?${qs}task=$task_id" ;;
        *)
            if is_known_page "$target"; then
                printf '%s\n' "$base/$target"
            else
                c_err "unknown open target: '$target' (expected: dashboard | board | task <id> | repo | a dashboard page)"
                return 2
            fi ;;
    esac
}

# ── cross-platform launcher ───────────────────────────────────────────────────
# launch_url <url> → hands the URL to the platform browser opener. Exit 0 when
# an opener ran (or none was found — the URL is printed instead, still useful
# over SSH/headless); 1 only when an opener was found and FAILED.
launch_url() {
    local url="$1" os
    if [ -n "${MYAI_OPEN_CMD:-}" ]; then
        # Deliberate word-split so the override may carry args ("firefox --new-tab").
        # shellcheck disable=SC2086
        if ${MYAI_OPEN_CMD} "$url"; then return 0; fi
        c_err "MYAI_OPEN_CMD failed: ${MYAI_OPEN_CMD} $url"
        return 1
    fi
    os="$(uname -s 2>/dev/null || printf 'unknown')"
    case "$os" in
        Darwin)
            command -v open >/dev/null 2>&1 && { open "$url"; return $?; } ;;
        Linux)
            # WSL: the Linux-side browser usually isn't there — hand off to Windows.
            if [ -n "${WSL_DISTRO_NAME:-}" ] || grep -qi microsoft /proc/version 2>/dev/null; then
                command -v wslview >/dev/null 2>&1 && { wslview "$url"; return $?; }
                command -v powershell.exe >/dev/null 2>&1 \
                    && { powershell.exe -NoProfile -Command "Start-Process '$url'" >/dev/null 2>&1; return $?; }
            fi
            command -v xdg-open >/dev/null 2>&1 && { xdg-open "$url" >/dev/null 2>&1; return $?; } ;;
        MINGW*|MSYS*|CYGWIN*)
            # `start` is a cmd builtin; empty "" is the window title slot.
            MSYS_NO_PATHCONV=1 cmd.exe /c start "" "$url" >/dev/null 2>&1 && return 0 ;;
    esac
    if [ -n "${BROWSER:-}" ] && command -v "${BROWSER%% *}" >/dev/null 2>&1; then
        # shellcheck disable=SC2086
        ${BROWSER} "$url" && return 0
    fi
    c_warn "no browser opener found on this host — open it yourself:"
    printf '%s\n' "$url"
    return 0
}

# ── main ──────────────────────────────────────────────────────────────────────
main() {
    local target="" task_id="" repo_override="" print_only=0
    while [ $# -gt 0 ]; do
        case "$1" in
            -h|--help) print_help; return 0 ;;
            -p|--print) print_only=1 ;;
            --repo)
                [ $# -ge 2 ] || { c_err "--repo needs a value"; return 2; }
                repo_override="$2"; shift ;;
            --repo=*) repo_override="${1#--repo=}" ;;
            -*)
                c_err "unknown flag: $1"; return 2 ;;
            *)
                if [ -z "$target" ]; then target="$1"
                elif [ "$target" = "task" ] && [ -z "$task_id" ]; then task_id="$1"
                else c_err "unexpected argument: $1"; return 2; fi ;;
        esac
        shift
    done

    local url rc
    url="$(resolve_url "${target:-dashboard}" "$task_id" "$repo_override")"; rc=$?
    [ $rc -eq 0 ] || return $rc

    if [ "$print_only" = 1 ]; then
        printf '%s\n' "$url"
        return 0
    fi
    c_info "opening $url"
    launch_url "$url"
}

# Library mode for the unit suite (scripts/tests/test_myai_open.sh): define the
# helpers, run nothing.
if [ "${MYAI_OPEN_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

main "$@"
