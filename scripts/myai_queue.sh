#!/usr/bin/env bash
# myai_queue.sh — the `myai queue` operator control surface for the runner task
# queue. `myai status` is read-only (health + counts); this is the terminal
# mirror of the dashboard's /work orchestration view — list what's queued,
# cancel a task you no longer want run, or bump/drop its priority — without
# opening a browser.
#
# All three verbs go through the gateway MCP tools (tasks_list / tasks_update)
# over the published Docker port, so every call carries the x-gateway-local-token
# header (scripts/lib/gateway.sh) — see myai_status.sh's header comment for why.
#
# Usage:
#   myai queue                                   # same as `list` with no filters
#   myai queue list [--repo NAME] [--status S] [--priority P0|P1|P2|P3]
#                   [--all] [--limit N] [--json]
#       Lists queued tasks sorted by priority then creation time. By default
#       `done` tasks are hidden (pass --all or --status done to see them).
#   myai queue cancel <taskId> [--reason "..."] [--force] [--json]
#       Marks a task `blocked` (notes record why) so the runner stops
#       considering it — the same reversible state a stuck/no-longer-wanted
#       task already lands in; requeue later with `tasks_update {status:pending}`
#       (dashboard /work → dead-letter panel, or the gateway MCP tool directly).
#       Refuses a task already `done` unless --force.
#   myai queue reprioritize <taskId> <P0|P1|P2|P3> [--json]
#       Changes a task's priority (e.g. escalate a P2 to P0, or demote a
#       runaway P0 to P3). Prints the old → new priority.
#
# Exit codes: 0 success, 1 gateway/task error, 2 usage error.
#
# Colours follow AI_RULES §13 — orange = good (never green), yellow = warn,
# red = bad, cyan = info. bash 3.2-safe (macOS default bash). No `set -e` in
# the shared setup (mirrors myai_status.sh) — a control command should REPORT
# a gateway/task error, not die with a raw trap.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CALLER_PWD="$PWD"

# JSON parsing runs on node, not python — myai ships as an npm CLI, so node ≥20
# is by definition present wherever `myai queue` runs; python3 is not (see
# myai_status.sh's fix for the same clean-Ubuntu-host gap).
NODE="$(command -v node || echo node)"

# ── colours ───────────────────────────────────────────────────────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1" >&2; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1"; }

print_help() { grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; }

# ── deployment mode (mirror myai_status.sh / myai_up / myai_down) ────────────
STANDALONE_DIR="${MYAI_STANDALONE_DIR:-$HOME/.myai/standalone}"
IS_MASTER_REPO=0
[ -f "$REPO_ROOT/scripts/update_all.sh" ] && [ -f "$REPO_ROOT/config/managed_repos.txt" ] && IS_MASTER_REPO=1

if [ -f "$CALLER_PWD/docker-compose.yml" ] && [ -d "$CALLER_PWD/AI" ]; then
    PROJECT_DIR="$CALLER_PWD"; PORTABLE=1
elif [ "$IS_MASTER_REPO" = 1 ] && [ -f "$REPO_ROOT/docker-compose.yml" ]; then
    PROJECT_DIR="$REPO_ROOT"; PORTABLE=0
elif [ -f "$STANDALONE_DIR/docker-compose.yml" ]; then
    PROJECT_DIR="$STANDALONE_DIR"; PORTABLE=1
else
    c_err "no docker-compose.yml here. Run 'myai init <path>' first, then 'cd <path>' and 'myai up'."
    exit 1
fi
for _envf in "$PROJECT_DIR/.env" "$PROJECT_DIR/AI/.env"; do
    [ -f "$_envf" ] && { set -a; . "$_envf" 2>/dev/null || true; set +a; }
done

MCP_PORT="${MYAI_MCP_PORT:-3100}"
DASH_PORT="${MYAI_DASHBOARD_PORT:-3210}"
MCP_URL="http://localhost:${MCP_PORT}/mcp"

# x-gateway-local-token — see scripts/lib/gateway.sh
[ -f "$SCRIPT_DIR/lib/gateway.sh" ] && . "$SCRIPT_DIR/lib/gateway.sh"
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

# ── gateway MCP call helpers ──────────────────────────────────────────────────
# mcp_call: $1 tool name, $2 JSON args → prints the raw JSON-RPC response on
# stdout; propagates curl's exit code (network/HTTP failure) to the caller.
mcp_call() {
    curl -sf -m 8 -X POST "$MCP_URL" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
}

# unwrap: reads a raw JSON-RPC response on stdin, prints ONE line — either the
# tool's result JSON, or {"__error":"..."} on any transport/tool-level failure.
# Never throws past this function, so callers can always treat stdout as valid JSON.
unwrap() {
    "$NODE" -e '
let out;
try {
  const resp = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (resp.error) {
    out = { __error: resp.error.message || JSON.stringify(resp.error) };
  } else {
    const parsed = JSON.parse(resp.result.content[0].text);
    out = (parsed && typeof parsed === "object" && parsed.error) ? { __error: parsed.error } : parsed;
  }
} catch { out = { __error: "malformed gateway response" }; }
console.log(JSON.stringify(out));'
}

# err_of: $1 JSON (from unwrap) → prints the __error message, or "" when absent.
err_of() {
    printf '%s' "$1" | "$NODE" -e '
try { const o = JSON.parse(require("fs").readFileSync(0, "utf8")); console.log(o && o.__error ? o.__error : ""); }
catch { console.log(""); }'
}

# find_task: $1 taskId → prints the matching task JSON, or {"__error":"..."}.
# tasks_list has no by-ID filter, so this scans the full queue client-side.
find_task() {
    local _raw _all
    _raw="$(mcp_call tasks_list '{"limit":1000}')" || { printf '{"__error":"gateway not reachable at %s — is '"'"'myai up'"'"' running?"}' "$MCP_URL"; return; }
    _all="$(printf '%s' "$_raw" | unwrap)"
    printf '%s' "$_all" | "$NODE" -e '
try {
  const parsed = JSON.parse(require("fs").readFileSync(0, "utf8"));
  if (parsed.__error) { console.log(JSON.stringify(parsed)); process.exit(0); }
  const tid = process.argv[1];
  const t = (parsed.tasks ?? []).find((x) => x.taskId === tid);
  console.log(t ? JSON.stringify(t) : JSON.stringify({ __error: `task not found: ${tid}` }));
} catch { console.log(JSON.stringify({ __error: "malformed gateway response" })); }' "$1"
}

# ── dispatch: list (default) | cancel | reprioritize ─────────────────────────
SUB="list"
case "${1:-}" in
    list|cancel|reprioritize) SUB="$1"; shift ;;
    -h|--help)                print_help; exit 0 ;;
    ""|--*)                   : ;;  # no args, or a flag meant for `list` — fall through
    *) c_err "unknown queue subcommand: $1 (expected: list | cancel | reprioritize)"; exit 2 ;;
esac

# ═══════════════════════════════════════════════════════════════════════════
# list
# ═══════════════════════════════════════════════════════════════════════════
if [ "$SUB" = "list" ]; then
    REPO_FILTER=""; STATUS_FILTER=""; PRIORITY_FILTER=""; LIMIT=200; ALL=0; JSON=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --repo)       shift; REPO_FILTER="${1:-}" ;;
            --repo=*)     REPO_FILTER="${1#*=}" ;;
            --status)     shift; STATUS_FILTER="${1:-}" ;;
            --status=*)   STATUS_FILTER="${1#*=}" ;;
            --priority)   shift; PRIORITY_FILTER="${1:-}" ;;
            --priority=*) PRIORITY_FILTER="${1#*=}" ;;
            --limit)      shift; LIMIT="${1:-200}" ;;
            --limit=*)    LIMIT="${1#*=}" ;;
            --all)        ALL=1 ;;
            --json)       JSON=1 ;;
            -h|--help)    print_help; exit 0 ;;
            *) c_err "unknown flag: $1 (see: myai queue --help)"; exit 2 ;;
        esac
        shift
    done

    _filters=""
    [ -n "$REPO_FILTER" ] && _filters="${_filters}\"repo\":\"$REPO_FILTER\","
    [ -n "$STATUS_FILTER" ] && _filters="${_filters}\"status\":\"$STATUS_FILTER\","
    [ -n "$PRIORITY_FILTER" ] && _filters="${_filters}\"priority\":\"$PRIORITY_FILTER\","
    _args="{${_filters}\"limit\":${LIMIT}}"

    _raw="$(mcp_call tasks_list "$_args")" || { c_err "gateway not reachable at $MCP_URL — is 'myai up' running? (myai status to check)"; exit 1; }
    RESULT="$(printf '%s' "$_raw" | unwrap)"
    ERR="$(err_of "$RESULT")"
    if [ -n "$ERR" ]; then c_err "$ERR"; exit 1; fi

    printf '%s' "$RESULT" | ALL="$ALL" STATUS_FILTER="$STATUS_FILTER" JSON="$JSON" DASH_PORT="$DASH_PORT" "$NODE" -e '
const parsed = JSON.parse(require("fs").readFileSync(0, "utf8"));
let tasks = parsed.tasks ?? [];
const all = process.env.ALL === "1";
const statusFilter = process.env.STATUS_FILTER || "";
const asJson = process.env.JSON === "1";
if (!statusFilter && !all) tasks = tasks.filter((t) => t.status !== "done");
const rank = { P0: 0, P1: 1, P2: 2, P3: 3 };
tasks.sort((a, b) =>
  (rank[a.priority] ?? 9) - (rank[b.priority] ?? 9)
  || new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

if (asJson) {
  console.log(JSON.stringify({ count: tasks.length, tasks }));
  process.exit(0);
}
const pad = (s, n) => String(s ?? "").slice(0, n).padEnd(n);
console.log(`  ${pad("TASK ID", 10)} ${pad("PRI", 3)} ${pad("STATUS", 11)} ${pad("REPO", 16)} ${pad("AGENT", 16)} TITLE`);
for (const t of tasks) {
  console.log(`  ${pad(t.taskId, 10)} ${pad(t.priority, 3)} ${pad(t.status, 11)} ${pad(t.repo, 16)} ${pad(t.assignedAgent || "-", 16)} ${String(t.title ?? "").slice(0, 60)}`);
}
console.log(`\n  ${tasks.length} task(s)${all || statusFilter ? "" : " — done hidden (--all to include)"}`);
console.log(`  dashboard: http://localhost:${process.env.DASH_PORT || "3210"}/work`);
'
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
# cancel <taskId>
# ═══════════════════════════════════════════════════════════════════════════
if [ "$SUB" = "cancel" ]; then
    TASK_ID="${1:-}"
    case "$TASK_ID" in
        ""|-*) c_err "myai queue cancel <taskId> — task ID is required"; exit 2 ;;
        *) shift ;;
    esac

    REASON=""; FORCE=0; JSON=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --reason)   shift; REASON="${1:-}" ;;
            --reason=*) REASON="${1#*=}" ;;
            --force)    FORCE=1 ;;
            --json)     JSON=1 ;;
            -h|--help)  print_help; exit 0 ;;
            *) c_err "unknown flag: $1 (see: myai queue --help)"; exit 2 ;;
        esac
        shift
    done

    CURRENT="$(find_task "$TASK_ID")"
    ERR="$(err_of "$CURRENT")"
    if [ -n "$ERR" ]; then c_err "$ERR"; exit 1; fi

    CUR_STATUS="$(printf '%s' "$CURRENT" | "$NODE" -e 'try{console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).status||"")}catch{console.log("")}')"
    if [ "$CUR_STATUS" = "done" ] && [ "$FORCE" != 1 ]; then
        c_err "task $TASK_ID is already done — pass --force to cancel it anyway"
        exit 1
    fi

    NOTE="${REASON:-cancelled via myai queue cancel}"
    _args="$("$NODE" -e 'console.log(JSON.stringify({taskId:process.argv[1],status:"blocked",notes:process.argv[2]}))' "$TASK_ID" "$NOTE")"
    _raw="$(mcp_call tasks_update "$_args")" || { c_err "gateway not reachable at $MCP_URL — is 'myai up' running?"; exit 1; }
    RESULT="$(printf '%s' "$_raw" | unwrap)"
    ERR="$(err_of "$RESULT")"
    if [ -n "$ERR" ]; then c_err "$ERR"; exit 1; fi

    if [ "$JSON" = 1 ]; then
        printf '%s\n' "$RESULT"
    else
        TITLE="$(printf '%s' "$CURRENT" | "$NODE" -e 'try{console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).title||"")}catch{console.log("")}')"
        c_ok "cancelled: $TASK_ID  ($CUR_STATUS → blocked)  $TITLE"
        c_info "requeue later with: tasks_update {taskId:\"$TASK_ID\", status:\"pending\"}  (dashboard: http://localhost:${DASH_PORT}/work)"
    fi
    exit 0
fi

# ═══════════════════════════════════════════════════════════════════════════
# reprioritize <taskId> <P0|P1|P2|P3>
# ═══════════════════════════════════════════════════════════════════════════
if [ "$SUB" = "reprioritize" ]; then
    TASK_ID="${1:-}"
    case "$TASK_ID" in
        ""|-*) c_err "myai queue reprioritize <taskId> <P0|P1|P2|P3> — task ID is required"; exit 2 ;;
        *) shift ;;
    esac
    NEW_PRIORITY="${1:-}"
    case "$NEW_PRIORITY" in
        P0|P1|P2|P3) shift ;;
        *) c_err "myai queue reprioritize <taskId> <P0|P1|P2|P3> — got '${NEW_PRIORITY:-<none>}'"; exit 2 ;;
    esac

    JSON=0
    while [ $# -gt 0 ]; do
        case "$1" in
            --json)    JSON=1 ;;
            -h|--help) print_help; exit 0 ;;
            *) c_err "unknown flag: $1 (see: myai queue --help)"; exit 2 ;;
        esac
        shift
    done

    CURRENT="$(find_task "$TASK_ID")"
    ERR="$(err_of "$CURRENT")"
    if [ -n "$ERR" ]; then c_err "$ERR"; exit 1; fi
    OLD_PRIORITY="$(printf '%s' "$CURRENT" | "$NODE" -e 'try{console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).priority||"")}catch{console.log("")}')"

    _args="$("$NODE" -e 'console.log(JSON.stringify({taskId:process.argv[1],priority:process.argv[2]}))' "$TASK_ID" "$NEW_PRIORITY")"
    _raw="$(mcp_call tasks_update "$_args")" || { c_err "gateway not reachable at $MCP_URL — is 'myai up' running?"; exit 1; }
    RESULT="$(printf '%s' "$_raw" | unwrap)"
    ERR="$(err_of "$RESULT")"
    if [ -n "$ERR" ]; then c_err "$ERR"; exit 1; fi

    if [ "$JSON" = 1 ]; then
        printf '%s\n' "$RESULT"
    else
        TITLE="$(printf '%s' "$CURRENT" | "$NODE" -e 'try{console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).title||"")}catch{console.log("")}')"
        if [ "$OLD_PRIORITY" = "$NEW_PRIORITY" ]; then
            c_warn "task $TASK_ID already $NEW_PRIORITY — no change  $TITLE"
        else
            c_ok "reprioritized: $TASK_ID  (${OLD_PRIORITY:-?} → $NEW_PRIORITY)  $TITLE"
        fi
    fi
    exit 0
fi
