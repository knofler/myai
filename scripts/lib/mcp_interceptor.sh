#!/usr/bin/env bash
# mcp_interceptor.sh — Docker MCP gateway `before:exec` interceptor: audit every
# tool call to the myAI gateway, and refuse gateway-management write tools for
# unattended lanes. Docker MCP plan phase 3 (guard).
#
# Wire it into `docker mcp gateway run` with an ABSOLUTE path:
#
#   --interceptor before:exec:<ABS_ROOT>/scripts/lib/mcp_interceptor.sh
#
# Contract (measured live, Docker MCP CLI v0.43.3 — plan/DOCKER_MCP_INTERCEPTOR_SPIKE.md):
#   - exec'd once per `tools/call` (never for tools/list), on the HOST, with NO
#     argv and the gateway's own environment — so lane identity and every knob
#     below arrive via env, never flags;
#   - stdin is one frame: {"Session":{},"Params":{"name":…,"arguments":{…}},"Extra":null}
#     (tool name only — no server name);
#   - exit 0 + empty stdout → the call proceeds;
#   - exit 0 + a CallToolResult JSON on stdout → that result replaces the call
#     (how we deny: isError:true with a readable reason);
#   - non-zero exit → the call fails with "executing interceptor: exit status N".
#
# Two rules, each one deliberate:
#   (a) AUDIT FAILS OPEN. A down/slow/401ing gateway must never take the tools
#       down with it: curl is capped at MCP_INTERCEPTOR_TIMEOUT and its outcome
#       is ignored. A frame we cannot parse is allowed (audited as tool
#       "unknown") for the same reason.
#   (b) STDOUT IS THE RESULT CHANNEL. Anything printed to stdout becomes the
#       tool's result, so nothing here writes stdout except mcpi_deny_result.
#
# Env knobs (all optional):
#   MYAI_SESSION_PROFILE        lane (agy/qwen/<master>/…); see mcpi_lane for fallbacks
#   MCP_INTERCEPTOR_DENY_LANES  lanes that get the deny list   (default: runner + the
#                               master's lane, role_master_lane — v1 G6)
#   MCP_INTERCEPTOR_DENY_TOOLS  tools refused for those lanes  (default below)
#   MCP_INTERCEPTOR_AUDIT       0 disables the traces_record call (default 1)
#   MCP_INTERCEPTOR_URL         gateway MCP endpoint (default http://localhost:${MCP_PORT:-3100}/mcp)
#   MCP_INTERCEPTOR_TIMEOUT     curl max seconds for the audit call (default 2)
#   MYAI_TASK_ID                trace correlation key when a runner task owns the session

# The Docker MCP gateway's own management tools: they add/remove servers or
# change their config (mcp-add, mcp-remove, mcp-config-set), or run arbitrary
# code against them (code-mode). An unattended lane must not reshape its own
# tool surface.
MCPI_DEFAULT_DENY_TOOLS="mcp-add mcp-remove mcp-config-set code-mode"

_mcpi_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
# gateway.sh resolves GATEWAY_LOCAL_TOKEN (env → .env → ~/.myai/.env). Silenced:
# rule (b).
# shellcheck source=scripts/lib/gateway.sh
. "$_mcpi_dir/gateway.sh" >/dev/null 2>&1 || true
# The master and the runner get the deny list; the master is configured per
# host (~/.myai/swarm/master.<host>), never named here. Silenced: rule (b).
# shellcheck source=scripts/lib/swarm_roles.sh disable=SC1091
. "$_mcpi_dir/swarm_roles.sh" >/dev/null 2>&1 || true
MCPI_DEFAULT_DENY_LANES="runner $(role_master_lane 2>/dev/null || echo default)"

# mcpi_lane → the lane this gateway serves. Same order as
# session_profile() in session_registry.sh, plus the runner: an unattended
# runner fire sets MYAI_RUNNER_FIRE=1 but runs on a regular Claude profile.
mcpi_lane() {
  local p="default"
  if [ -n "${MYAI_SESSION_PROFILE:-}" ]; then
    p="$MYAI_SESSION_PROFILE"
  elif [ "${MYAI_RUNNER_FIRE:-0}" = "1" ]; then
    p="runner"
  else
    case "${CLAUDE_CONFIG_DIR:-}" in
      */.claude-*) p="${CLAUDE_CONFIG_DIR##*/.claude-}" ;;
    esac
  fi
  # lowercased and reduced to [a-z0-9._-]: the lane is spliced into JSON
  printf '%s' "$p" | tr '[:upper:]' '[:lower:]' | tr -cd 'a-z0-9._-'
}

# mcpi_parse <frame> → "<tool>\t<arg-keys-json>". Tool names are reduced to
# [A-Za-z0-9._:-] so they are safe to splice into JSON and logs; argument
# VALUES are never kept (they can carry secrets) — only their keys. Prints
# "unknown\t[]" for anything unparseable.
mcpi_parse() {
  MCPI_FRAME="$1" "${MCP_INTERCEPTOR_PYTHON:-python3}" -I -c '
import json, os, re
try:
    p = json.loads(os.environ["MCPI_FRAME"])["Params"]
    tool = re.sub(r"[^A-Za-z0-9._:-]", "_", str(p.get("name") or "")) or "unknown"
    args = p.get("arguments")
    keys = sorted(str(k) for k in args) if isinstance(args, dict) else []
except Exception:
    tool, keys = "unknown", []
print(tool + "\t" + json.dumps(keys))
' 2>/dev/null || printf 'unknown\t[]\n'
}

# _mcpi_in_list <word> <space-separated list> → 0 when word is in the list.
_mcpi_in_list() {
  case " $2 " in *" $1 "*) return 0 ;; esac
  return 1
}

# mcpi_denied <lane> <tool> → 0 when this lane may not call this tool.
mcpi_denied() {
  _mcpi_in_list "$1" "${MCP_INTERCEPTOR_DENY_LANES-$MCPI_DEFAULT_DENY_LANES}" &&
    _mcpi_in_list "$2" "${MCP_INTERCEPTOR_DENY_TOOLS-$MCPI_DEFAULT_DENY_TOOLS}"
}

# mcpi_deny_result <lane> <tool> → the CallToolResult that replaces a refused
# call. Both inputs are already reduced to JSON-safe characters.
mcpi_deny_result() {
  printf '{"content":[{"type":"text","text":"myAI interceptor: tool %s is not allowed for lane %s (gateway-management write tools are operator-only; scripts/lib/mcp_interceptor.sh)"}],"isError":true}\n' "$2" "$1"
}

# mcpi_audit <lane> <tool> <arg-keys-json> <allow|deny> → one traces_record
# span, best effort (rule a). Never writes stdout; always returns 0.
mcpi_audit() {
  [ "${MCP_INTERCEPTOR_AUDIT:-1}" = "0" ] && return 0
  local body
  body="$(MCPI_LANE="$1" MCPI_TOOL="$2" MCPI_KEYS="$3" MCPI_DECISION="$4" \
    "${MCP_INTERCEPTOR_PYTHON:-python3}" -I -c '
import json, os, socket, time
e = os.environ
now = int(time.time() * 1000)
lane, decision = e["MCPI_LANE"], e["MCPI_DECISION"]
try:
    keys = json.loads(e["MCPI_KEYS"])
except Exception:
    keys = []
args = {
    # one trace per lane per day unless a runner task owns the session
    "taskId": e.get("MYAI_TASK_ID") or "mcp-docker:%s:%s" % (lane, time.strftime("%Y-%m-%d")),
    "name": "mcp.tool_call",
    "service": "agent",
    "startMs": now,
    "endMs": now,
    "status": "error" if decision == "deny" else "ok",
    "attributes": {"tool": e["MCPI_TOOL"], "lane": lane, "decision": decision,
                   "argKeys": keys, "host": socket.gethostname().split(".")[0],
                   "via": "docker-mcp-gateway"},
}
if decision == "deny":
    args["error"] = "denied by lane policy"
print(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": "traces_record", "arguments": args}}))
' 2>/dev/null)" || return 0
  [ -n "$body" ] || return 0
  curl -s -o /dev/null -m "${MCP_INTERCEPTOR_TIMEOUT:-2}" -X POST \
    "${MCP_INTERCEPTOR_URL:-http://localhost:${MCP_PORT:-3100}/mcp}" \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d "$body" >/dev/null 2>&1 || true
  return 0
}

# mcpi_main → read one frame from stdin, audit it, deny or allow. Exit 0 in
# every path: a deny is a stdout result, never a non-zero exit.
mcpi_main() {
  local frame parsed tool keys lane decision="allow"
  frame="$(cat)"
  parsed="$(mcpi_parse "$frame")"
  tool="${parsed%%$'\t'*}"
  keys="${parsed#*$'\t'}"
  lane="$(mcpi_lane)"
  mcpi_denied "$lane" "$tool" && decision="deny"
  mcpi_audit "$lane" "$tool" "$keys" "$decision"
  [ "$decision" = "deny" ] && mcpi_deny_result "$lane" "$tool"
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  mcpi_main
fi
