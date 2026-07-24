#!/usr/bin/env bash
# myai_logs.sh — the `myai logs` post-up observability surface.
#
# Thin wrapper over `docker compose logs -f` that resolves WHICH compose project
# to read (the same detection as myai_up/myai_down) so `myai logs` works from an
# init'd project or the master framework repo without cd-ing anywhere.
#
# Usage:
#   myai logs                     # follow ALL stack services (tail 100)
#   myai logs gateway             # follow one service: gateway | dashboard | mongo
#   myai logs --no-follow         # print current logs and exit (no -f)
#   myai logs --tail 500 gateway  # deeper backlog for one service
#   myai logs --runner            # ALSO tail the local off-hours CLI runner's
#                                  # latest job log alongside the stack, lines
#                                  # prefixed "[runner]" (falls back to
#                                  # runner.out; no-op with a warning if the
#                                  # runner has never fired — see `myai runner`)
#
# Any other flag passes straight through to `docker compose logs`.
#
# Colours follow AI_RULES §13 — never green. bash 3.2-safe.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CALLER_PWD="$PWD"

RED=$'\033[38;5;196m'; YELLOW=$'\033[38;5;220m'; CYAN=$'\033[38;5;45m'; RESET=$'\033[0m'
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1"; }

# ── args: peel off myai-only flags, pass the rest through ─────────────────────
FOLLOW=1
TAIL=100
WITH_RUNNER=0
PASS_ARGS=""          # bash 3.2-safe: space-joined (service names + flags are token-safe)
while [ $# -gt 0 ]; do
    case "$1" in
        --no-follow)  FOLLOW=0 ;;
        --tail)       shift; TAIL="${1:-100}" ;;
        --tail=*)     TAIL="${1#*=}" ;;
        --runner)     WITH_RUNNER=1 ;;
        -h|--help)    grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)            PASS_ARGS="$PASS_ARGS $1" ;;
    esac
    shift
done

# ── deployment mode (mirror myai_up/myai_down) ────────────────────────────────
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
    c_err "no docker-compose.yml here. Run 'myai init <path>' first, then 'cd <path>' and 'myai logs'."
    exit 1
fi
for _envf in "$PROJECT_DIR/.env" "$PROJECT_DIR/AI/.env"; do
    [ -f "$_envf" ] && { set -a; . "$_envf" 2>/dev/null || true; set +a; }
done
# Mirror myai_up/down: portable stacks default the compose project name to the
# project FOLDER (never the literal "myai") so logs can never read an unrelated stack.
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

command -v docker >/dev/null 2>&1 || { c_err "docker not found on PATH."; exit 127; }

FOLLOW_FLAG="--follow"
[ "$FOLLOW" = 0 ] && FOLLOW_FLAG=""
[ "$FOLLOW" = 1 ] && c_info "following logs — Ctrl-C to stop (services: gateway | dashboard | mongo)"

# ── --runner: also tail the local off-hours CLI runner's log, prefixed, in the
#    background — killed via trap whenever this script exits (Ctrl-C, the stack
#    log stream ending, or a test's stubbed docker returning immediately). Never
#    uses `exec` for the stack tail below so the trap always gets to run.
#
#    `tail -f | sed` backgrounded as one pipeline only hands back the PID of the
#    LAST stage (sed) via $!; killing that alone leaves `tail` itself orphaned
#    (it blocks on read, never notices its pipe reader died). A FIFO gives each
#    stage its own PID so cleanup can kill both explicitly.
RUNNER_TAIL_PID=""; RUNNER_SED_PID=""; RUNNER_FIFO=""
# The EXIT trap's own exit status becomes the script's — always return 0 so a
# clean run's exit code is never clobbered by "nothing to kill".
cleanup_runner_tail() {
    [ -n "$RUNNER_TAIL_PID" ] && kill "$RUNNER_TAIL_PID" 2>/dev/null
    [ -n "$RUNNER_SED_PID" ] && kill "$RUNNER_SED_PID" 2>/dev/null
    [ -n "$RUNNER_FIFO" ] && rm -f "$RUNNER_FIFO"
    return 0
}
trap cleanup_runner_tail EXIT INT TERM

if [ "$WITH_RUNNER" = 1 ]; then
    RUNNER_LOG_DIR="$HOME/.ai-cli-runner"
    RUNNER_LATEST="$(ls -t "$RUNNER_LOG_DIR/logs" 2>/dev/null | head -1 || true)"
    if [ -n "$RUNNER_LATEST" ]; then
        RUNNER_TARGET="$RUNNER_LOG_DIR/logs/$RUNNER_LATEST"
    elif [ -f "$RUNNER_LOG_DIR/runner.out" ]; then
        RUNNER_TARGET="$RUNNER_LOG_DIR/runner.out"
    else
        RUNNER_TARGET=""
    fi
    if [ -n "$RUNNER_TARGET" ]; then
        c_info "also tailing runner log: $RUNNER_TARGET (prefixed [runner])"
        if [ "$FOLLOW" = 1 ]; then
            RUNNER_FIFO="$(mktemp -u -t myai-runner-tail)"
            mkfifo "$RUNNER_FIFO"
            sed 's/^/[runner] /' < "$RUNNER_FIFO" &
            RUNNER_SED_PID=$!
            tail -n "$TAIL" -f "$RUNNER_TARGET" 2>/dev/null > "$RUNNER_FIFO" &
            RUNNER_TAIL_PID=$!
        else
            tail -n "$TAIL" "$RUNNER_TARGET" 2>/dev/null | sed 's/^/[runner] /'
        fi
    else
        c_warn "no runner logs yet at $RUNNER_LOG_DIR — skipping (install with: myai runner install)"
    fi
fi

# shellcheck disable=SC2086
( cd "$PROJECT_DIR" && exec docker compose logs $FOLLOW_FLAG --tail "$TAIL" $PASS_ARGS )
