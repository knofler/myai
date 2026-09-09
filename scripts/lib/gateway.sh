#!/usr/bin/env bash
# gateway.sh — resolve the GATEWAY_LOCAL_TOKEN escape hatch for host→gateway calls.
#
# WHY THIS EXISTS (root cause, 2026-06-18): since ADR-010 M1 made `tenancy.enforce`
# default ON (PR #238), the gateway 401s any request that is neither loopback nor
# carrying a matching `x-gateway-local-token`. Host shell scripts hit the *published*
# Docker port (localhost:3100), which the gateway sees as the bridge gateway IP
# (e.g. 172.17.0.1) — NOT 127.0.0.1 — so the loopback trust path fails. The scripts
# never sent the token, so EVERY host→gateway call (schedule_task, reprioritize,
# the CLI runner's default pickup, push_schedule, repo_card, fleet_resume) silently
# 401'd. `curl -sf` swallowed it, so it looked like "the queue is empty / nothing
# scheduled" when really the autonomous pipeline was dead. This lib fixes it: source
# it, then send the header.
#
#   bash:    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN"
#   python:  pass GW_TOKEN="$GATEWAY_LOCAL_TOKEN" into the env, then
#            headers["x-gateway-local-token"] = os.environ["GW_TOKEN"]
#
# The token must MATCH the gateway's GATEWAY_LOCAL_TOKEN (docker-compose.yml /.env).
# Resolution order: existing env → $MYAI_ENV_FILE → repo .env (GATEWAY_LOCAL_TOKEN=)
#                 → ~/.myai/.env (kernel-only repos) → compose default.
# For a hosted deployment, set a strong GATEWAY_LOCAL_TOKEN in .env on BOTH the
# gateway and wherever these scripts run.

_gw_lib_dir="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if [ -z "${GATEWAY_LOCAL_TOKEN:-}" ]; then
  # Candidate .env files, most specific first:
  #   $MYAI_ENV_FILE     explicit override (CI, tests, unusual layouts).
  #   <lib>/../../.env   the repo/AI .env - lib lives at <root>/scripts/lib/
  #                      (master) or <root>/AI/scripts/lib/ (managed).
  #   ~/.myai/.env       machine-local store. REQUIRED for a KERNEL-ONLY repo (no
  #                      per-repo AI/ copy), whose lib resolves inside the
  #                      globally-installed module: there ../../.env is
  #                      <npm root>/ai-management/.env, which never exists. Without
  #                      this candidate, resolution fell through to the dev
  #                      placeholder below, the gateway 401'd the MCP handshake, and
  #                      every myai tool silently vanished from the session - the
  #                      exact failure seen in the DXP repo on 2026-08-31.
  for _gw_envf in "${MYAI_ENV_FILE:-}" "$_gw_lib_dir/../../.env" "$HOME/.myai/.env"; do
    [ -n "$_gw_envf" ] && [ -f "$_gw_envf" ] || continue
    _gw_t="$(grep -E '^GATEWAY_LOCAL_TOKEN=' "$_gw_envf" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"'\''' | xargs 2>/dev/null)"
    if [ -n "$_gw_t" ]; then GATEWAY_LOCAL_TOKEN="$_gw_t"; break; fi
  done
fi
GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
export GATEWAY_LOCAL_TOKEN

# ─────────────────────────────────────────────────────────────────────────
# 401-vs-empty helpers (task-07010faf, 2026-08-06): reconcile_review_tasks.sh,
# archive_runner_backlog.sh, and queue_topup.sh all wrap their gateway reads in
# a `curl -sf ... || echo {}` pattern. `-f` makes curl discard the body AND
# exit non-zero on ANY non-2xx response, so a 401/403 (e.g. a machine still
# holding this file's own default GATEWAY_LOCAL_TOKEN — the exact fleet-wide
# incident from the 2026-08-02 handoff note) collapses to the same empty
# string as a genuinely-empty queue/backlog or a plain unreachable gateway.
# The caller then silently no-ops with zero signal that auth, not data, was
# the reason. These helpers are called ONLY on that already-failed path (the
# primary `curl -sf` call is untouched, so its shape/behavior — and every
# existing test stub for the success path — stays exactly as before) to tell
# the three cases apart:
#   - auth-fail    (HTTP 401/403)         → loud, distinct warning
#   - unreachable  (HTTP "000" / no code) → the existing quiet log line
#   - a real empty 200 body is never routed through here at all — it never
#     hit the `-z "$raw"` branch in the first place.
# ─────────────────────────────────────────────────────────────────────────

# gw_probe_status <url> [timeout-seconds] → echoes the HTTP status code for a
# throwaway POST to <url> ("000" if the connection itself failed: DNS/refused/
# timeout). Never used on the hot path — only to diagnose a `curl -sf` call
# to the same URL that has already come back empty.
gw_probe_status() {
  curl -s -o /dev/null -w '%{http_code}' -m "${2:-8}" -X POST "$1" \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"ping","arguments":{}},"id":0}' \
    2>/dev/null
}

# gw_classify_failure <url> [timeout-seconds] → "auth-fail" | "unreachable"
gw_classify_failure() {
  case "$(gw_probe_status "$1" "${2:-8}")" in
    401|403) echo "auth-fail" ;;
    *)       echo "unreachable" ;;
  esac
}

# gw_warn_auth_fail <context-label> → loud, distinct warning on stderr for a
# confirmed 401/403 — never call this for a plain-unreachable or genuinely-
# empty result.
gw_warn_auth_fail() {
  {
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo "  GATEWAY AUTH FAILURE (401/403) — ${1:-gateway call}"
    echo "  GATEWAY_LOCAL_TOKEN looks wrong/stale on this machine (still the"
    echo "  default vs. the gateway's real token?). This is NOT a genuinely"
    echo "  empty result — do not trust any 'nothing to do' from this run"
    echo "  until the token is fixed. See scripts/lib/gateway.sh."
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  } >&2
}

# ─────────────────────────────────────────────────────────────────────────
# Runner-backlog cursor helpers (task-e9163eb9): the cross-machine "how many
# config/runner_backlog.jsonl lines are consumed" counter, backed by the
# gateway's backlog_cursor_get/backlog_cursor_set MCP tools (one Mongo doc
# per tenant, tasks/runner-backlog-cursor-store.ts). Replaces reading/writing
# a gitignored, machine-local config/.runner_backlog.cursor file, which read
# CONSUMED=0 on any fresh checkout/worktree regardless of the real consumption
# state on whichever machine actually drives the runner — the false
# "985 remaining" a diagnostic run from an isolated worktree would otherwise
# see. Callers (queue_topup.sh, hooks/session/17-schedule-status.sh) must
# treat an empty/failing get as "could not determine" and skip whatever
# decision depends on it, never silently substitute 0.
# ─────────────────────────────────────────────────────────────────────────

# gw_backlog_cursor_get [timeout-seconds] → echoes the consumed count
# (integer) on success; prints nothing and returns 1 on any failure
# (gateway down, auth fail, malformed response).
gw_backlog_cursor_get() {
  local raw
  raw=$(curl -sf -m "${1:-8}" -X POST http://localhost:3100/mcp \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"backlog_cursor_get","arguments":{}},"id":1}' 2>/dev/null)
  [ -z "$raw" ] && return 1
  printf '%s' "$raw" | /usr/bin/python3 -c 'import sys, json
try:
    t = json.load(sys.stdin)["result"]["content"][0]["text"]
    d = json.loads(t)
    if "consumed" not in d:
        raise KeyError("consumed")
    print(int(d["consumed"]))
except Exception:
    sys.exit(1)
' 2>/dev/null
}

# gw_backlog_cursor_set <consumed> [timeout-seconds] → best-effort set;
# returns 0 iff the gateway confirmed the write, 1 on any failure.
gw_backlog_cursor_set() {
  local consumed="$1" raw
  raw=$(curl -sf -m "${2:-8}" -X POST http://localhost:3100/mcp \
    -H 'content-type: application/json' \
    -H "x-gateway-local-token: ${GATEWAY_LOCAL_TOKEN:-}" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"backlog_cursor_set\",\"arguments\":{\"consumed\":${consumed}}},\"id\":1}" 2>/dev/null)
  [ -z "$raw" ] && return 1
  printf '%s' "$raw" | /usr/bin/python3 -c 'import sys, json
try:
    t = json.load(sys.stdin)["result"]["content"][0]["text"]
    d = json.loads(t)
    sys.exit(0 if "consumed" in d else 1)
except Exception:
    sys.exit(1)
' 2>/dev/null
}
