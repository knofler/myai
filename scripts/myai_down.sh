#!/usr/bin/env bash
# myai_down.sh — the `myai down` Day-3 wrapper: stop the self-contained stack cleanly.
#
# Wraps scripts/betac_up.sh's `down` action so `myai down` tears the whole myAI
# surface (gateway + dashboard + mongo, and any optional agentFlow/connect
# profiles) down in one call. The host launchd CLI runner is left alone — it is a
# subscription-window worker, not part of the Docker stack.
#
# Usage:
#   myai down                 # stop the stack (data volume preserved)
#   myai down --volumes       # stop AND drop the mongo data volume (DATA LOSS)
#
# All flags pass straight through to scripts/betac_up.sh down.
#
# Colours follow AI_RULES §13 — never green. bash 3.2-safe.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BETAC="$SCRIPT_DIR/betac_up.sh"
CALLER_PWD="$PWD"

ORANGE=$'\033[1;38;5;208m'; RED=$'\033[38;5;196m'; RESET=$'\033[0m'
c_ok()  { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_err() { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }

# Mirror myai_up's deployment detection: a downloader's init'd project (CWD with
# docker-compose.yml + AI/) tears down via the portable compose right there; the
# master framework repo uses betac_up's full down.
for _envf in "$CALLER_PWD/.env" "$CALLER_PWD/AI/.env"; do
    [ -f "$_envf" ] && { set -a; . "$_envf" 2>/dev/null || true; set +a; }
done
[ -n "${MYAI_HOME:-}" ] || MYAI_HOME="$REPO_ROOT"
export MYAI_HOME
STANDALONE_DIR="${MYAI_STANDALONE_DIR:-$HOME/.myai/standalone}"
IS_MASTER_REPO=0
[ -f "$REPO_ROOT/scripts/update_all.sh" ] && [ -f "$REPO_ROOT/config/managed_repos.txt" ] && IS_MASTER_REPO=1

if [ -f "$CALLER_PWD/docker-compose.yml" ] && [ -d "$CALLER_PWD/AI" ]; then
    PROJECT_DIR="$CALLER_PWD"
elif [ "$IS_MASTER_REPO" = 0 ] && [ -f "$STANDALONE_DIR/docker-compose.yml" ]; then
    PROJECT_DIR="$STANDALONE_DIR"
else
    PROJECT_DIR=""
fi

if [ -n "$PROJECT_DIR" ]; then
    # Mirror myai_up: default the compose project name to the project FOLDER (never
    # the literal "myai") so `myai down` in a fresh shell can NEVER target an
    # unrelated "myai" stack on the host. Docker project names: lowercase [a-z0-9_-].
    if [ -z "${MYAI_PROJECT_NAME:-}" ]; then
        if [ "$PROJECT_DIR" = "$STANDALONE_DIR" ]; then
            _pn="myai-standalone"
        else
            _pn=$(printf '%s' "$(basename "$PROJECT_DIR")" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/^-*//;s/-*$//')
            [ -n "$_pn" ] || _pn="myai-app"
        fi
        MYAI_PROJECT_NAME="$_pn"
    fi
    export MYAI_PROJECT_NAME
    ( cd "$PROJECT_DIR" && docker compose down "$@" ) || { c_err "docker compose down failed"; exit 1; }
else
    [ -x "$BETAC" ] || { c_err "scripts/betac_up.sh not found or not executable"; exit 1; }
    "$BETAC" down "$@"
fi

c_ok "myAI stack stopped."
