#!/usr/bin/env bash
# betac_up.sh — single-command betaC fused-stack launcher.
#
# Phase 1 "unify the surface" (plan/BETAC_VISION.md §3): ONE command brings up
# the whole betaC surface that today takes three repos + a launchd worker —
#   gateway + dashboard + mongo   (this repo's docker-compose.yml)
#   + runner                       (host launchd CLI task runner — subscription off-hours)
#   + agentFlow + connect          (sibling repos, via the betaC compose overlay)
# all on ONE network, ONE shared Mongo, and ONE .env.
#
# Usage:
#   ./scripts/betac_up.sh                    # core: gateway + dashboard + mongo + ensure runner
#   ./scripts/betac_up.sh --full             # core + agentFlow + connect (the full fused stack)
#   ./scripts/betac_up.sh --with-agentflow   # core + agentFlow
#   ./scripts/betac_up.sh --with-connect     # core + connect
#   ./scripts/betac_up.sh --build            # force-rebuild images on up
#   ./scripts/betac_up.sh --no-runner        # skip the host runner (this Mac isn't a worker)
#   ./scripts/betac_up.sh --runner           # also INSTALL the launchd runner if missing
#   ./scripts/betac_up.sh status             # show stack + runner status and URLs
#   ./scripts/betac_up.sh down [--volumes]   # stop the fused stack (‑‑volumes also drops data)
#   ./scripts/betac_up.sh logs [service]     # tail compose logs
#
# Per-machine overrides (.env): BETAC_AGENTFLOW_PATH, BETAC_CONNECT_PATH,
#   BETAC_AGENTFLOW_PORT (3400), BETAC_CONNECT_PORT (3300).
#
# The runner stays HOST-side (launchd) by design: it drives the Claude CLI on
# your subscription window and needs host auth — it cannot live in a container.
# This launcher ensures it's loaded; it never auto-INSTALLS without --runner
# (matches machine_selfheal policy), and respects ~/.ai-cli-runner/.no-runner.
#
# bash 3.2-safe (macOS default bash).
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

BASE_COMPOSE="docker-compose.yml"
BETAC_COMPOSE="docker-compose.betac.yml"
RUNNER_LABEL="com.myai.cli-task-runner"
NO_RUNNER_MARKER="$HOME/.ai-cli-runner/.no-runner"

# ── arg parse ───────────────────────────────────────────────────────────────
ACTION="up"
WITH_AGENTFLOW=0
WITH_CONNECT=0
DO_BUILD=0
RUNNER_MODE="ensure"   # ensure | install | skip
DOWN_VOLUMES=0
LOGS_SVC=""

while [ $# -gt 0 ]; do
    case "$1" in
        up|down|status|logs|restart) ACTION="$1" ;;
        --full)            WITH_AGENTFLOW=1; WITH_CONNECT=1 ;;
        --with-agentflow|--agentflow) WITH_AGENTFLOW=1 ;;
        --with-connect|--connect)     WITH_CONNECT=1 ;;
        --build)           DO_BUILD=1 ;;
        --runner)          RUNNER_MODE="install" ;;
        --no-runner)       RUNNER_MODE="skip" ;;
        --volumes)         DOWN_VOLUMES=1 ;;
        -h|--help)         grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)
            if [ "$ACTION" = "logs" ] && [ -z "$LOGS_SVC" ]; then
                LOGS_SVC="$1"
            else
                echo "ERROR: unknown argument: $1" >&2; exit 2
            fi
            ;;
    esac
    shift
done

c_ok()   { printf '  \033[38;5;208m✓\033[0m %s\n' "$1"; }
c_warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
c_info() { printf '  \033[36m·\033[0m %s\n' "$1"; }
hr()     { printf '%s\n' "────────────────────────────────────────────────────────────"; }

# ── load .env so path/port overrides resolve here too ────────────────────────
load_env() {
    [ -f "$REPO_ROOT/.env" ] || return 0
    # shellcheck disable=SC1091
    set -a; . "$REPO_ROOT/.env" 2>/dev/null || true; set +a
}

# ── compose -f / --profile arg builder ───────────────────────────────────────
# Echoes the compose args (files + profiles) for the requested surface.
compose_args() {
    local args="-f $BASE_COMPOSE"
    if [ "$WITH_AGENTFLOW" = 1 ] || [ "$WITH_CONNECT" = 1 ]; then
        args="$args -f $BETAC_COMPOSE"
        [ "$WITH_AGENTFLOW" = 1 ] && args="$args --profile agentflow"
        [ "$WITH_CONNECT" = 1 ]   && args="$args --profile connect"
    fi
    printf '%s' "$args"
}

# ── ensure one .env exists (the single config) ───────────────────────────────
ensure_env() {
    if [ ! -f "$REPO_ROOT/.env" ]; then
        if [ -f "$REPO_ROOT/.env.example" ]; then
            # Sanitize inline comments while copying: this compose version does NOT
            # strip a trailing "# ..." from an env value, so `KEY=   # note` would be
            # read as the literal comment (breaking mem_limit/port interpolation).
            # Strip comments from empty values (KEY=  # x → KEY=) and simple
            # single-token values (KEY=val # x → KEY=val); leave full-line comments.
            sed -E \
                -e 's/^([A-Za-z_][A-Za-z0-9_]*=)[[:space:]]*#.*$/\1/' \
                -e 's/^([A-Za-z_][A-Za-z0-9_]*=[^#[:space:]]+)[[:space:]]+#.*$/\1/' \
                "$REPO_ROOT/.env.example" > "$REPO_ROOT/.env"
            c_warn ".env created from .env.example (comments stripped) — fill in ANTHROPIC_API_KEY etc. for full function"
        else
            c_warn "no .env and no .env.example — services use built-in defaults"
        fi
    else
        c_ok ".env present (single fused config)"
    fi
}

# ── guard: sibling-repo build context must exist before enabling a profile ───
guard_sibling() {
    # $1=label  $2=env-var-name  $3=default-path
    local label="$1" var="$2" def="$3" path
    eval "path=\${$var:-$def}"
    case "$path" in /*) : ;; *) path="$REPO_ROOT/$path" ;; esac
    if [ -d "$path" ]; then
        c_ok "$label source found → $path"
        return 0
    fi
    c_warn "$label source NOT found at $path — skipping (set $var in .env to enable)"
    return 1
}

# ── warn if a fused host port is already bound by a standalone stack ──────────
warn_port() {
    # $1=label $2=port
    local label="$1" port="$2" owner
    owner=$(docker ps --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep ":${port}->" | awk '{print $1}' | head -1 || true)
    if [ -n "$owner" ] && [ "$owner" != "myai-${label}" ]; then
        c_warn "port ${port} ($label) already bound by '${owner}' — stop it first or set BETAC_${label}_PORT (uppercase) in .env"
    fi
}

# ── runner (host launchd) ────────────────────────────────────────────────────
runner_loaded() { launchctl list "$RUNNER_LABEL" >/dev/null 2>&1; }
runner_plist()  { ls "$HOME/Library/LaunchAgents/$RUNNER_LABEL.plist" 2>/dev/null; }

ensure_runner() {
    if [ "$RUNNER_MODE" = "skip" ]; then
        c_info "runner: skipped (--no-runner)"
        return 0
    fi
    if [ -f "$NO_RUNNER_MARKER" ]; then
        c_info "runner: disabled on this Mac (~/.ai-cli-runner/.no-runner) — not a worker host"
        return 0
    fi
    if [ "$(uname -s)" != "Darwin" ]; then
        c_info "runner: launchd is macOS-only — skipped on $(uname -s)"
        return 0
    fi
    if runner_loaded; then
        c_ok "runner: loaded ($RUNNER_LABEL)"
        return 0
    fi
    if [ -n "$(runner_plist 2>/dev/null)" ]; then
        launchctl load "$HOME/Library/LaunchAgents/$RUNNER_LABEL.plist" 2>/dev/null \
            && c_ok "runner: loaded existing LaunchAgent" \
            || c_warn "runner: plist present but failed to load — run scripts/setup_cli_runner_schedule.sh --status"
        return 0
    fi
    if [ "$RUNNER_MODE" = "install" ]; then
        c_info "runner: installing launchd schedule (every 10m)…"
        "$SCRIPT_DIR/setup_cli_runner_schedule.sh" --every-minutes 10 \
            && c_ok "runner: installed + loaded" \
            || c_warn "runner: install failed"
    else
        c_warn "runner: not installed on this Mac — enable with: ./scripts/betac_up.sh --runner"
        c_info "       (or: ./scripts/setup_cli_runner_schedule.sh --every-minutes 10 && sudo pmset -c sleep 0)"
    fi
}

# ── status table ─────────────────────────────────────────────────────────────
show_status() {
    hr
    printf '  betaC fused stack — status\n'
    hr
    local rows
    rows=$(docker ps --format '{{.Names}}\t{{.Status}}' 2>/dev/null | grep -E '^myai-' || true)
    if [ -n "$rows" ]; then
        printf '%s\n' "$rows" | while IFS="$(printf '\t')" read -r name st; do
            c_ok "$(printf '%-18s %s' "$name" "$st")"
        done
    else
        c_warn "no myai-* containers running"
    fi
    if runner_loaded; then c_ok "$(printf '%-18s %s' 'runner' 'launchd loaded')"; else c_info "$(printf '%-18s %s' 'runner' 'not loaded')"; fi
    hr
    printf '  URLs\n'
    c_info "Gateway MCP    http://localhost:3100/mcp"
    c_info "Gateway REST   http://localhost:3200/health"
    c_info "Dashboard      http://localhost:3210"
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^myai-agentflow$' && c_info "agentFlow      http://localhost:${BETAC_AGENTFLOW_PORT:-3400}"
    docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^myai-connect$'   && c_info "connect        http://localhost:${BETAC_CONNECT_PORT:-3300}"
    hr
}

# ── actions ──────────────────────────────────────────────────────────────────
load_env

case "$ACTION" in
status)
    show_status
    exit 0
    ;;
logs)
    # shellcheck disable=SC2046
    exec docker compose $(compose_args) logs -f --tail=100 $LOGS_SVC
    ;;
down)
    hr; printf '  betaC fused stack — DOWN\n'; hr
    DOWN_ARGS="-f $BASE_COMPOSE -f $BETAC_COMPOSE --profile agentflow --profile connect"
    if [ "$DOWN_VOLUMES" = 1 ]; then
        c_warn "stopping AND removing volumes (data loss)…"
        # shellcheck disable=SC2086
        docker compose $DOWN_ARGS down --volumes
    else
        # shellcheck disable=SC2086
        docker compose $DOWN_ARGS down
    fi
    c_ok "fused stack stopped"
    exit 0
    ;;
restart)
    # down tears the whole fused stack (all profiles); we re-up with the
    # surface requested on this invocation (WITH_AGENTFLOW/WITH_CONNECT preserved).
    "$0" down
    ACTION="up"
    ;;
esac

# ── up ───────────────────────────────────────────────────────────────────────
hr
printf '  betaC up — fusing the surface\n'
hr

ensure_env

# Resolve which optional surfaces actually have a buildable source tree.
if [ "$WITH_AGENTFLOW" = 1 ]; then
    guard_sibling agentflow BETAC_AGENTFLOW_PATH "../agentFlow" || WITH_AGENTFLOW=0
fi
if [ "$WITH_CONNECT" = 1 ]; then
    guard_sibling connect BETAC_CONNECT_PATH "../connect" || WITH_CONNECT=0
fi
[ "$WITH_AGENTFLOW" = 1 ] && warn_port agentflow "${BETAC_AGENTFLOW_PORT:-3400}"
[ "$WITH_CONNECT" = 1 ]   && warn_port connect "${BETAC_CONNECT_PORT:-3300}"

ARGS=$(compose_args)
UP_FLAGS="-d"
[ "$DO_BUILD" = 1 ] && UP_FLAGS="$UP_FLAGS --build"

c_info "compose: docker compose $ARGS up $UP_FLAGS"
# shellcheck disable=SC2086
if docker compose $ARGS up $UP_FLAGS; then
    c_ok "compose stack up"
else
    c_warn "compose up reported an error — check 'docker compose $ARGS ps'"
fi

ensure_runner

echo
show_status
echo
c_ok "betaC is up. Point any MCP agent at http://localhost:3100/mcp to bootstrap your context."
