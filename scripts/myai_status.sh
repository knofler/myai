#!/usr/bin/env bash
# myai_status.sh — the `myai status` post-up observability surface.
#
# ONE command answers "is my stack alive and what is it working on?" after
# `myai up` (whose health-wait timeout points here):
#   1. HTTP health   — gateway /health + dashboard /api/health on localhost
#   2. Containers    — docker compose ps for the stack's services
#   3. Task queue    — pending/working/review/blocked/done counts via the
#                      gateway MCP `tasks_list` tool. Host→gateway calls hit the
#                      published Docker port and are NOT loopback-trusted, so the
#                      x-gateway-local-token header is mandatory (scripts/lib/gateway.sh).
#   4. Continuity    — cold-start tokens saved this month via the gateway MCP
#                      `continuity_stats` tool (every context_boot/memory_context
#                      block served = re-teaching cost the operator avoided).
#   5. Runner        — is the local off-hours CLI runner (`myai runner`)
#                      installed + active, and how long since its last activity.
#                      Read-only mirror of `myai runner status` folded in here so
#                      one command answers gateway + runner + queue at a glance.
#
# Usage:
#   myai status                # human-readable status report
#   myai status --json         # machine-readable JSON (health + services + queue)
#   myai status --repo NAME    # scope task-queue counts to one repo
#
# Exit code: 0 when gateway + dashboard are both healthy, 1 otherwise — so it
# works as a poll target:  until myai status >/dev/null; do sleep 3; done
#
# Colours follow AI_RULES §13 — orange = good (never green), yellow = warn,
# red = bad, cyan = info. bash 3.2-safe (macOS default bash).
#
# NOTE: no `set -e` — a status probe must REPORT a dead service, not die on it.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CALLER_PWD="$PWD"

# JSON parsing runs on node, not python: myai ships as an npm CLI, so node ≥20
# is by definition present wherever `myai status` runs — python3 is NOT (clean
# Ubuntu/Debian hosts ship without it, which used to break --json output).
NODE="$(command -v node || echo node)"

# ── colours (AI_RULES §13: never green) ───────────────────────────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1"; }
hr()     { printf '%s\n' "────────────────────────────────────────────────────────────"; }

# ── args ──────────────────────────────────────────────────────────────────────
JSON=0
REPO_FILTER=""
while [ $# -gt 0 ]; do
    case "$1" in
        --json)     JSON=1 ;;
        --repo)     shift; REPO_FILTER="${1:-}" ;;
        --repo=*)   REPO_FILTER="${1#*=}" ;;
        -h|--help)  grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)          c_err "unknown flag: $1 (see: myai status --help)"; exit 2 ;;
    esac
    shift
done

# ── deployment mode (mirror myai_up/myai_down) ────────────────────────────────
#   PORTABLE=1 → an init'd project (caller's dir has docker-compose.yml + AI/)
#             → OR a greenfield/standalone stack bootstrapped at $STANDALONE_DIR
#   PORTABLE=0 → the master/fleet framework repo (compose at the package root)
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
# Mirror myai_up/down: portable stacks default the compose project name to the
# project FOLDER (never the literal "myai") so ps can never read an unrelated stack.
if [ -z "${MYAI_PROJECT_NAME:-}" ] && [ "$PORTABLE" = 1 ]; then
    if [ "$PROJECT_DIR" = "$STANDALONE_DIR" ]; then
        _pn="myai-standalone"
    else
        _pn=$(printf '%s' "$(basename "$PROJECT_DIR")" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/^-*//;s/-*$//')
        [ -n "$_pn" ] || _pn="myai-app"
    fi
    MYAI_PROJECT_NAME="$_pn"
fi
export MYAI_PROJECT_NAME="${MYAI_PROJECT_NAME:-}"

MCP_PORT="${MYAI_MCP_PORT:-3100}"
GW_PORT="${MYAI_GATEWAY_HTTP_PORT:-3200}"
DASH_PORT="${MYAI_DASHBOARD_PORT:-3210}"
GW_URL="http://localhost:${GW_PORT}/health"
DASH_URL="http://localhost:${DASH_PORT}/api/health"
MCP_URL="http://localhost:${MCP_PORT}/mcp"

# x-gateway-local-token — see header comment + scripts/lib/gateway.sh
[ -f "$SCRIPT_DIR/lib/gateway.sh" ] && . "$SCRIPT_DIR/lib/gateway.sh"
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"

# ── 1. HTTP health ────────────────────────────────────────────────────────────
GW_OK=0; DASH_OK=0; GW_BODY=""; MONGO_STATE=""
if command -v curl >/dev/null 2>&1; then
    GW_BODY="$(curl -fsS --max-time 4 "$GW_URL" 2>/dev/null)" && GW_OK=1
    curl -fsS -o /dev/null --max-time 4 "$DASH_URL" 2>/dev/null && DASH_OK=1
    # The gateway health body carries its mongo view: {"status":"ok","mongodb":"connected"}
    MONGO_STATE="$(printf '%s' "$GW_BODY" | "$NODE" -e '
try { console.log(JSON.parse(require("fs").readFileSync(0, "utf8")).mongodb ?? ""); } catch {}' 2>/dev/null)"
else
    c_warn "curl not found — cannot probe HTTP health"
fi
HEALTHY=0; [ "$GW_OK" = 1 ] && [ "$DASH_OK" = 1 ] && HEALTHY=1

# ── 2. containers ─────────────────────────────────────────────────────────────
PS_OUT=""; PS_OK=0
if command -v docker >/dev/null 2>&1; then
    PS_OUT="$(cd "$PROJECT_DIR" && docker compose ps 2>/dev/null)" && PS_OK=1
fi

# ── 3. task-queue counts (gateway MCP tasks_list, local-token header) ─────────
QUEUE_JSON="null"; QUEUE_LINE=""
if command -v curl >/dev/null 2>&1; then
    _repo_arg=""
    [ -n "$REPO_FILTER" ] && _repo_arg="\"repo\":\"$REPO_FILTER\","
    _resp="$(curl -sf -m 4 -X POST "$MCP_URL" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"tasks_list\",\"arguments\":{${_repo_arg}\"limit\":1000}}}" 2>/dev/null)"
    if [ -n "$_resp" ]; then
        _counts="$(printf '%s' "$_resp" | "$NODE" -e '
let ts;
try {
  const resp = JSON.parse(require("fs").readFileSync(0, "utf8"));
  ts = JSON.parse(resp.result.content[0].text).tasks ?? [];
} catch { process.exit(1); }
const c = { pending: 0, working: 0, review: 0, blocked: 0, done: 0 };
for (const t of ts) if (t.status in c) c[t.status]++;
c.total = ts.length;
console.log(JSON.stringify(c));' 2>/dev/null)" && QUEUE_JSON="$_counts"
    fi
fi
if [ "$QUEUE_JSON" != "null" ]; then
    QUEUE_LINE="$(printf '%s' "$QUEUE_JSON" | "$NODE" -e '
const c = JSON.parse(require("fs").readFileSync(0, "utf8"));
console.log(`pending ${c.pending} · working ${c.working} · review ${c.review} · blocked ${c.blocked} · done ${c.done}  (total ${c.total})`);' 2>/dev/null)"
fi

# ── 4. continuity meter (gateway MCP continuity_stats, local-token header) ────
CONT_JSON="null"; CONT_LINE=""
if command -v curl >/dev/null 2>&1; then
    _cont_args="{}"
    [ -n "$REPO_FILTER" ] && _cont_args="{\"repo\":\"$REPO_FILTER\"}"
    _cresp="$(curl -sf -m 4 -X POST "$MCP_URL" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
        -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"continuity_stats\",\"arguments\":${_cont_args}}}" 2>/dev/null)"
    if [ -n "$_cresp" ]; then
        _cstats="$(printf '%s' "$_cresp" | "$NODE" -e '
let s;
try {
  const resp = JSON.parse(require("fs").readFileSync(0, "utf8"));
  s = JSON.parse(resp.result.content[0].text);
} catch { process.exit(1); }
if (!s || typeof s !== "object" || !s.month) process.exit(1);
console.log(JSON.stringify({ month: s.month, total: s.total, avgTokensPerBoot: s.avgTokensPerBoot ?? 0 }));' 2>/dev/null)" && CONT_JSON="$_cstats"
    fi
fi
if [ "$CONT_JSON" != "null" ]; then
    CONT_LINE="$(printf '%s' "$CONT_JSON" | "$NODE" -e '
const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
const fmt = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
console.log(`${fmt(s.month.tokens)} tokens saved this month · ${s.month.boots} boots · ~${fmt(s.avgTokensPerBoot)}/boot  (all-time ${fmt(s.total.tokens)})`);' 2>/dev/null)"
fi

# ── 5. runner health (local off-hours CLI runner — mirrors `myai runner status`,
#      read-only, no delegation needed since it only inspects, never mutates) ──
RUNNER_INSTALLED=0; RUNNER_ACTIVE=0; RUNNER_LAST_EPOCH=0
RUNNER_LOG_DIR="$HOME/.ai-cli-runner"
RUNNER_LABEL="com.myai.cli-task-runner"
RUNNER_PLIST="$HOME/Library/LaunchAgents/$RUNNER_LABEL.plist"
RUNNER_UNIT="myai-cli-runner"
case "$(uname -s)" in
Darwin)
    if [ -f "$RUNNER_PLIST" ]; then
        RUNNER_INSTALLED=1
        command -v launchctl >/dev/null 2>&1 && launchctl list "$RUNNER_LABEL" >/dev/null 2>&1 && RUNNER_ACTIVE=1
    fi
    ;;
Linux)
    if command -v systemctl >/dev/null 2>&1 && systemctl --user list-unit-files "$RUNNER_UNIT.timer" 2>/dev/null | grep -q "$RUNNER_UNIT.timer"; then
        RUNNER_INSTALLED=1
        systemctl --user is-active --quiet "$RUNNER_UNIT.timer" 2>/dev/null && RUNNER_ACTIVE=1
    elif command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "myai-cli-runner"; then
        # cron-backed runner has no enable/disable state — installed == active.
        RUNNER_INSTALLED=1; RUNNER_ACTIVE=1
    fi
    ;;
esac
if [ -d "$RUNNER_LOG_DIR/logs" ]; then
    _runner_last="$(ls -t "$RUNNER_LOG_DIR/logs" 2>/dev/null | head -1 || true)"
    if [ -n "$_runner_last" ]; then
        RUNNER_LAST_EPOCH="$(stat -c %Y "$RUNNER_LOG_DIR/logs/$_runner_last" 2>/dev/null || stat -f %m "$RUNNER_LOG_DIR/logs/$_runner_last" 2>/dev/null || echo 0)"
    fi
fi
if [ "${RUNNER_LAST_EPOCH:-0}" = 0 ] && [ -f "$RUNNER_LOG_DIR/runner.out" ]; then
    RUNNER_LAST_EPOCH="$(stat -c %Y "$RUNNER_LOG_DIR/runner.out" 2>/dev/null || stat -f %m "$RUNNER_LOG_DIR/runner.out" 2>/dev/null || echo 0)"
fi
RUNNER_AGO_LINE=""
if [ "${RUNNER_LAST_EPOCH:-0}" -gt 0 ] 2>/dev/null; then
    RUNNER_AGO_LINE="$("$NODE" -e '
const secs = Math.max(0, Math.floor(Date.now()/1000) - '"$RUNNER_LAST_EPOCH"');
const m = Math.floor(secs/60), h = Math.floor(m/60), d = Math.floor(h/24);
console.log(d>0?`${d}d ago`:h>0?`${h}h ago`:m>0?`${m}m ago`:`${secs}s ago`);' 2>/dev/null)"
fi

# ── output: --json ────────────────────────────────────────────────────────────
if [ "$JSON" = 1 ]; then
    # Normalize `compose ps --format json` (NDJSON on recent v2, array on older)
    # to a stable [{name,service,state,health}] list; null when docker is absent.
    SERVICES_JSON="null"
    if [ "$PS_OK" = 1 ]; then
        SERVICES_JSON="$( (cd "$PROJECT_DIR" && docker compose ps --format json 2>/dev/null) | "$NODE" -e '
const raw = require("fs").readFileSync(0, "utf8").trim();
let rows = [];
if (raw) {
  try {
    const parsed = JSON.parse(raw);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    for (let line of raw.split("\n")) {
      line = line.trim();
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch {}
    }
  }
}
console.log(JSON.stringify(rows.map((r) => ({
  name: r.Name ?? null, service: r.Service ?? null,
  state: r.State ?? null, health: r.Health || null,
}))));' 2>/dev/null)"
        [ -n "$SERVICES_JSON" ] || SERVICES_JSON="null"
    fi
    _b() { [ "$1" = 1 ] && echo true || echo false; }
    RUNNER_AGO_JSON="null"
    [ -n "$RUNNER_AGO_LINE" ] && RUNNER_AGO_JSON="\"$RUNNER_AGO_LINE\""
    printf '{"healthy":%s,"gateway":{"ok":%s,"url":"%s","mongodb":"%s"},"dashboard":{"ok":%s,"url":"%s"},"services":%s,"queue":%s,"continuity":%s,"runner":{"installed":%s,"active":%s,"lastActivityAgo":%s}}\n' \
        "$(_b "$HEALTHY")" "$(_b "$GW_OK")" "$GW_URL" "${MONGO_STATE:-}" \
        "$(_b "$DASH_OK")" "$DASH_URL" "$SERVICES_JSON" "$QUEUE_JSON" "$CONT_JSON" \
        "$(_b "$RUNNER_INSTALLED")" "$(_b "$RUNNER_ACTIVE")" "$RUNNER_AGO_JSON"
    exit $((1 - HEALTHY))
fi

# ── output: human ─────────────────────────────────────────────────────────────
if [ "$PORTABLE" = 1 ]; then MODE="portable project"; else MODE="master framework repo"; fi
printf '%smyai status%s — %s (%s)\n' "$BOLD" "$RESET" "$(basename "$PROJECT_DIR")" "$MODE"
hr
if [ "$GW_OK" = 1 ]; then
    c_ok "gateway    $GW_URL — ok${MONGO_STATE:+ (mongodb: $MONGO_STATE)}"
else
    c_err "gateway    $GW_URL — no response (is the stack up? try: myai up)"
fi
if [ "$DASH_OK" = 1 ]; then
    c_ok "dashboard  $DASH_URL — ok"
else
    c_err "dashboard  $DASH_URL — no response"
fi

echo
c_info "containers (docker compose ps)"
if [ "$PS_OK" = 1 ] && [ -n "$PS_OUT" ]; then
    printf '%s\n' "$PS_OUT" | sed 's/^/    /'
elif [ "$PS_OK" = 1 ]; then
    c_warn "no containers running for this project"
else
    c_warn "docker not reachable — cannot list containers"
fi

echo
c_info "task queue${REPO_FILTER:+ (repo: $REPO_FILTER)}"
if [ -n "$QUEUE_LINE" ]; then
    printf '    %s\n' "$QUEUE_LINE"
    c_info "dashboard: http://localhost:${DASH_PORT}/schedule"
else
    c_warn "queue counts unavailable — gateway MCP not responding on :${MCP_PORT} (or token mismatch; check GATEWAY_LOCAL_TOKEN in .env)"
fi

echo
c_info "continuity${REPO_FILTER:+ (repo: $REPO_FILTER)}"
if [ -n "$CONT_LINE" ]; then
    printf '    %s\n' "$CONT_LINE"
    c_info "dashboard: http://localhost:${DASH_PORT}/analytics"
else
    c_warn "continuity meter unavailable — gateway MCP not responding on :${MCP_PORT} (or gateway predates continuity_stats; rebuild it)"
fi

echo
c_info "runner (local off-hours CLI runner)"
if [ "$RUNNER_INSTALLED" = 1 ]; then
    if [ "$RUNNER_ACTIVE" = 1 ]; then
        c_ok "installed + active${RUNNER_AGO_LINE:+ — last activity $RUNNER_AGO_LINE}"
    else
        c_warn "installed but NOT active — myai runner start"
    fi
else
    c_warn "not installed — myai runner install"
fi

hr
if [ "$HEALTHY" = 1 ]; then
    c_ok "stack healthy"
else
    c_err "stack NOT healthy — inspect with: myai logs   (or: myai up to restart)"
fi
exit $((1 - HEALTHY))
