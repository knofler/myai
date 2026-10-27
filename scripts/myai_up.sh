#!/usr/bin/env bash
# myai_up.sh — the `myai up` Day-3 wrapper: self-contained myAI stack on localhost.
#
# Wraps scripts/betac_up.sh to give the Independent-Edition `myai up` surface:
# ONE command brings the core stack — gateway + dashboard + mongo — live on
# localhost, waits for it to report healthy, then prints the dashboard URL.
#
#   • Single-tenant, loopback-trusted by default — NO auth friction. localhost
#     callers always resolve to the default tenant (ADR-010 loopback trust) and
#     the dashboard never gates localhost, so a single operator just opens the URL.
#     (Enable a login-wall / per-tenant keys only for a hosted deploy: set
#     REQUIRE_LOGIN=true / TENANT_ENFORCE=true in .env.)
#   • Bring-your-own .env — copy .env.example → .env and fill ANTHROPIC_API_KEY
#     (or use the Claude CLI bridge) for LLM features. The stack runs without it;
#     `myai up` just reminds you when the key is missing.
#   • Guards the runtime/node_modules/.vite-temp tmpfs mountpoint before bringing
#     the gateway up — Docker cannot create it on the read-only ./:/app/AI bind,
#     so the host dir MUST pre-exist or a gateway rebuild fails to START with
#     "make mountpoint .vite-temp: read-only file system" (AI_RULES §13 / hook-21
#     class self-heal; mirrors scripts/machine_selfheal.sh step 4).
#
# Usage:
#   myai up                 # core: gateway + dashboard + mongo, wait for health
#   myai up --build         # force-rebuild images on up
#   myai up --full          # also boot agentFlow + connect (betaC fused stack)
#   myai up --runner        # also INSTALL the host launchd CLI runner
#   myai up --no-wait       # don't block on health (return once compose is up)
#   myai up --timeout 180   # health-wait budget in seconds (default 120)
#   myai up --keep-on-fail  # unrecoverable failure: skip the rollback stop and
#                           # leave the unhealthy stack running for live debugging
#
# Self-heal (bounded): when the health wait times out, `myai up` works out WHICH
# services are unhealthy, captures their docker compose logs to a diagnostic
# file, restarts them ONCE, and waits again. Still unhealthy → diagnostic
# summary + rollback (compose stop of the core services — never leaves a
# half-up stack silently running) + exit 1. Tunables: MYAI_HEAL_RETRIES
# (restart rounds, default 1), MYAI_HEALTH_STEP (poll interval seconds, default 3).
#
# All other flags pass straight through to scripts/betac_up.sh.
#
# Colours follow AI_RULES §13 — orange = good (never green), yellow = warn,
# red = bad, cyan = info. bash 3.2-safe (macOS default bash).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BETAC="$SCRIPT_DIR/betac_up.sh"
CALLER_PWD="$PWD"   # preserve the caller's dir — used to detect an init'd project

# ── colours (AI_RULES §13: never green) ───────────────────────────────────────
ORANGE=$'\033[1;38;5;208m'; YELLOW=$'\033[38;5;220m'; RED=$'\033[38;5;196m'
CYAN=$'\033[38;5;45m'; BOLD=$'\033[1m'; RESET=$'\033[0m'
c_ok()   { printf '  %s✓%s %s\n' "$ORANGE" "$RESET" "$1"; }
c_warn() { printf '  %s!%s %s\n' "$YELLOW" "$RESET" "$1"; }
c_err()  { printf '  %s✗%s %s\n' "$RED" "$RESET" "$1"; }
c_info() { printf '  %s·%s %s\n' "$CYAN" "$RESET" "$1"; }
hr()     { printf '%s\n' "────────────────────────────────────────────────────────────"; }

# ── Docker gate: refuse BEFORE compose, in words a first-time user can act on ──
# Without Docker, `docker compose up` fails with a stack trace that never says
# "install Docker". scripts/lib/docker_gate.sh explains what/why/how per OS.
# First thing after the helpers: nothing (not even a generated .env token) is
# written for a stack that cannot start. -h/--help is never gated.
case " $* " in *" -h "*|*" --help "*) MYAI_SKIP_DOCKER_GATE=1 ;; esac
if [ "${MYAI_SKIP_DOCKER_GATE:-0}" != 1 ]; then
    # shellcheck source=scripts/lib/docker_gate.sh
    . "$SCRIPT_DIR/lib/docker_gate.sh"
    _dg_state="$(docker_gate_state)"
    if [ "$_dg_state" != ok ]; then
        docker_gate_explain "$_dg_state" >&2
        docker_gate_mark_pending
        c_err "myai up needs Docker — $(docker_gate_remedy "$_dg_state")"
        exit 3
    fi
    docker_gate_clear_pending
fi


# ── deployment mode ───────────────────────────────────────────────────────────
# `myai init` scaffolds AI/ + a portable docker-compose.yml into the target repo;
# `myai up` runs from THERE. The installed package ships no root compose, so we
# must run from the user's project, with MYAI_FRAMEWORK_DIR pointing at the framework
# install (REPO_ROOT) for the gateway/dashboard build context.
#   PORTABLE=1 → downloader project (the caller's dir has docker-compose.yml + AI/)
#             → OR a greenfield project / bare global install with no per-project
#               stack yet: bootstrapped at $STANDALONE_DIR (below)
#   PORTABLE=0 → the master/fleet framework repo (operator path → betac_up, full tooling)
STANDALONE_DIR="${MYAI_STANDALONE_DIR:-$HOME/.myai/standalone}"
IS_MASTER_REPO=0
[ -f "$REPO_ROOT/scripts/update_all.sh" ] && [ -f "$REPO_ROOT/config/managed_repos.txt" ] && IS_MASTER_REPO=1

if [ -f "$CALLER_PWD/docker-compose.yml" ] && [ -d "$CALLER_PWD/AI" ]; then
    PROJECT_DIR="$CALLER_PWD"; PORTABLE=1
elif [ "$IS_MASTER_REPO" = 1 ] && [ -f "$REPO_ROOT/docker-compose.yml" ]; then
    PROJECT_DIR="$REPO_ROOT"; PORTABLE=0
elif [ -f "$REPO_ROOT/templates/docker-compose.portable.yml" ]; then
    # Greenfield project (kernel CLAUDE.md only, no AI/, no per-project compose)
    # or a bare global install: bootstrap/refresh the framework's OWN
    # self-contained stack at $STANDALONE_DIR — self-mounts the installed module
    # (MYAI_AI_MOUNT) with safe local-mongo defaults. NEVER the master/fleet's
    # docker-compose.yml, which hard-requires MONGODB_URI with no default (LL
    # 2026-07-04: a workspace clone silently defaulting to local mongo
    # split-brained the fleet queue for 10.5h) — that guard is non-negotiable
    # and only ever applies to the actual master repo, detected above.
    mkdir -p "$STANDALONE_DIR"
    cp "$REPO_ROOT/templates/docker-compose.portable.yml" "$STANDALONE_DIR/docker-compose.yml"
    PROJECT_DIR="$STANDALONE_DIR"; PORTABLE=1
    export MYAI_AI_MOUNT="$REPO_ROOT"
else
    c_err "no docker-compose.yml here. Run 'myai init <path>' first, then 'cd <path>' and 'myai up'."
    exit 1
fi
# Bring-your-own .env (ports, MONGODB_URI, key, MYAI_FRAMEWORK_DIR override) from the project.
for _envf in "$PROJECT_DIR/.env" "$PROJECT_DIR/AI/.env"; do
    [ -f "$_envf" ] && { set -a; . "$_envf" 2>/dev/null || true; set +a; }
done

# ── first-boot credential bootstrap (SECURITY task-7f8b20a3) ─────────────────
# docker-compose.yml/.mcp.json/templates ship NO fallback for GATEWAY_LOCAL_TOKEN
# (the old literal 'myai-local-bridge-dev' default is public knowledge — it's in
# the npm package). Generate a real random one into the project's .env the first
# time `myai up` runs so the stack never boots on a publicly-known bridge token.
# Idempotent: a real token already present (env or .env) is left untouched.
DEFAULT_LOCAL_TOKEN="myai-local-bridge-dev"
ensure_local_token() {
    if [ -n "${GATEWAY_LOCAL_TOKEN:-}" ] && [ "$GATEWAY_LOCAL_TOKEN" != "$DEFAULT_LOCAL_TOKEN" ]; then
        return 0
    fi
    local env_file="$PROJECT_DIR/.env" tmp new_token
    if command -v openssl >/dev/null 2>&1; then
        new_token="$(openssl rand -hex 32)"
    elif command -v python3 >/dev/null 2>&1; then
        new_token="$(python3 -c 'import secrets; print(secrets.token_hex(32))')"
    else
        c_warn "neither openssl nor python3 found — cannot generate GATEWAY_LOCAL_TOKEN, leaving it unset"
        return 0
    fi
    tmp="$(mktemp "${env_file}.XXXXXX")"
    [ -f "$env_file" ] && grep -v '^GATEWAY_LOCAL_TOKEN=' "$env_file" > "$tmp" 2>/dev/null || true
    printf 'GATEWAY_LOCAL_TOKEN=%s\n' "$new_token" >> "$tmp"
    mv "$tmp" "$env_file"
    export GATEWAY_LOCAL_TOKEN="$new_token"
    c_ok "generated a random GATEWAY_LOCAL_TOKEN into $(basename "$PROJECT_DIR")/.env (first boot — was unset/published default)"
}
ensure_local_token

# ── first-boot secrets for a fresh install (v1 gate G5) ──────────────────────
# _gen_secret → 64 hex chars; _env_set KEY VALUE → replace/append one line in
# the env file compose reads, keeping every other line.
_gen_secret() {
    if command -v openssl >/dev/null 2>&1; then openssl rand -hex 32
    elif command -v python3 >/dev/null 2>&1; then python3 -c 'import secrets; print(secrets.token_hex(32))'
    else return 1; fi
}
_env_set() {
    local env_file="$PROJECT_DIR/.env" tmp
    tmp="$(mktemp "${env_file}.XXXXXX")" || return 1
    [ -f "$env_file" ] && grep -v "^$1=" "$env_file" > "$tmp" 2>/dev/null || true
    printf '%s=%s\n' "$1" "$2" >> "$tmp"
    mv "$tmp" "$env_file"
}

# JWT_SECRET signs every dashboard/password session. The compose files used to
# default it to a value printed in the package, so anyone who could reach the
# gateway could forge an owner session. Generate one when it is unset or still
# that published value; a secret you set yourself is never touched (rotating it
# would log out every session).
KNOWN_DEFAULT_JWT_SECRET="myai-dev-jwt-secret-change-me"
ensure_jwt_secret() {
    if [ -n "${JWT_SECRET:-}" ] && [ "$JWT_SECRET" != "$KNOWN_DEFAULT_JWT_SECRET" ]; then
        return 0
    fi
    local was_default=0 new
    [ "${JWT_SECRET:-}" = "$KNOWN_DEFAULT_JWT_SECRET" ] && was_default=1
    new="$(_gen_secret)" || { c_warn "neither openssl nor python3 found — cannot generate JWT_SECRET"; return 0; }
    _env_set JWT_SECRET "$new" || { c_warn "could not write JWT_SECRET to $(basename "$PROJECT_DIR")/.env"; return 0; }
    export JWT_SECRET="$new"
    if [ "$was_default" = 1 ]; then
        c_ok "replaced the published default JWT_SECRET in $(basename "$PROJECT_DIR")/.env (sessions signed with it were forgeable — sign in again)"
    else
        c_ok "generated a random JWT_SECRET into $(basename "$PROJECT_DIR")/.env (first boot)"
    fi
}
ensure_jwt_secret

# The bundled database's root password (portable stack only). A fresh install
# gets a generated one. An existing data volume keeps the password it was
# created with — changing it underneath the volume would lock the data out —
# so for those we only print how to change it. Skipped when MONGODB_URI points
# at your own database.
ensure_mongo_password() {
    # The portable compose file has no password fallback (G5 RV-4), so the env
    # file always carries one: generated for a fresh database (also when an
    # external MONGODB_URI leaves the bundled one unused), or the old default
    # written out explicitly for an existing volume so its data stays readable.
    [ "$PORTABLE" = 1 ] || return 0
    case "${MONGO_ROOT_PASSWORD:-}" in ""|password) ;; *) return 0 ;; esac
    local vol="${MYAI_PROJECT_NAME:-myai}_myai-mongo-data" vols new
    if ! vols="$(docker volume ls --format '{{.Name}}' 2>/dev/null)"; then
        c_warn "cannot list Docker volumes — leaving the database password as it is"
        return 0
    fi
    if [ -z "${MONGODB_URI:-}" ] && grep -qxF "$vol" <<<"$vols"; then
        if [ -z "${MONGO_ROOT_PASSWORD:-}" ]; then
            _env_set MONGO_ROOT_PASSWORD password || c_warn "could not write MONGO_ROOT_PASSWORD to $(basename "$PROJECT_DIR")/.env"
            export MONGO_ROOT_PASSWORD=password
        fi
        c_warn "the bundled database (volume $vol) uses the published default password; it is kept so your data stays readable."
        c_warn "  to change it: docker compose exec mongo mongosh -u admin -p password --authenticationDatabase admin --eval 'db.getSiblingDB(\"admin\").changeUserPassword(\"admin\", \"<new>\")'"
        c_warn "  then set MONGO_ROOT_PASSWORD=<new> in $(basename "$PROJECT_DIR")/.env and run myai up again (the port is bound to 127.0.0.1 either way)"
        return 0
    fi
    new="$(_gen_secret)" || { c_warn "neither openssl nor python3 found — cannot generate MONGO_ROOT_PASSWORD"; return 0; }
    _env_set MONGO_ROOT_PASSWORD "$new" || { c_warn "could not write MONGO_ROOT_PASSWORD to $(basename "$PROJECT_DIR")/.env"; return 0; }
    export MONGO_ROOT_PASSWORD="$new"
    c_ok "generated a random MONGO_ROOT_PASSWORD into $(basename "$PROJECT_DIR")/.env (fresh database)"
}
ensure_mongo_password

# ── the user's brain, mounted into the gateway (v1 G2 B5) ────────────────────
# The portable gateway used to keep a brain INSIDE its container: an agent's
# brain_commit never reached the user's own brain (`myai brain log`), and a
# `myai down` / rebuild dropped it. Resolve the host brain the CLI uses
# (scripts/lib/brain.sh: $MYAI_BRAIN_DIR → brain.path → ~/.myai/brain), create
# it as the USER if missing (so Docker never creates it root-owned), and record
# it as MYAI_BRAIN_HOST in the stack's .env so every compose call in the stack
# dir — up, restart, down — mounts the same path. MYAI_UID/MYAI_GID make the
# gateway write as the USER: as root it left root-owned objects in the brain
# that broke the user's own git on Linux.
ensure_brain_mount() {
    # The greenfield stack only — a managed project's own compose/.env is its own.
    [ "$PORTABLE" = 1 ] && [ "$PROJECT_DIR" = "$STANDALONE_DIR" ] || return 0
    local bd env_file="$PROJECT_DIR/.env" tmp uid gid
    if [ -f "$REPO_ROOT/scripts/lib/brain.sh" ]; then
        # shellcheck source=/dev/null
        bd="$( . "$REPO_ROOT/scripts/lib/brain.sh" >/dev/null 2>&1; brain_dir 2>/dev/null )"
    fi
    [ -n "${bd:-}" ] || bd="${HOME}/.myai/brain"
    mkdir -p "$bd" || { c_warn "cannot create the brain dir $bd — the gateway's brain will not persist"; return 0; }
    tmp="$(mktemp "${env_file}.XXXXXX")"
    [ -f "$env_file" ] && grep -v -E '^(MYAI_BRAIN_HOST|MYAI_UID|MYAI_GID)=' "$env_file" > "$tmp" 2>/dev/null || true
    uid="$(id -u)"; gid="$(id -g)"
    printf 'MYAI_BRAIN_HOST=%s\nMYAI_UID=%s\nMYAI_GID=%s\n' "$bd" "$uid" "$gid" >> "$tmp"
    mv "$tmp" "$env_file"
    export MYAI_BRAIN_HOST="$bd" MYAI_UID="$uid" MYAI_GID="$gid"
    c_info "brain     $bd (mounted into the gateway)"
}
ensure_brain_mount
# Resolved AFTER sourcing — the project's .env may carry an EMPTY placeholder,
# which must not clobber the default.
# Framework install dir (the portable compose's build context) has its OWN
# name. It used to be exported as MYAI_HOME — but MYAI_HOME is the per-user
# STATE dir (~/.myai) to every brain/session/usage writer, so everything this
# script started wrote state into the framework checkout (2026-10-18). A
# legacy .env that still sets MYAI_HOME to a framework checkout is translated.
if [ -z "${MYAI_FRAMEWORK_DIR:-}" ] && [ -n "${MYAI_HOME:-}" ] \
   && [ -f "$MYAI_HOME/scripts/lib/brain.sh" ] && [ -d "$MYAI_HOME/runtime" ]; then
    MYAI_FRAMEWORK_DIR="$MYAI_HOME"; unset MYAI_HOME
fi
[ -n "${MYAI_FRAMEWORK_DIR:-}" ] || MYAI_FRAMEWORK_DIR="$REPO_ROOT"
export MYAI_FRAMEWORK_DIR
# Default the compose project name to the init'd project FOLDER (never the
# literal "myai") so a portable stack can never collide with / tear down an
# unrelated "myai" stack on the same host (e.g. the operator's master stack).
# Docker project names must be lowercase [a-z0-9_-].
if [ -z "${MYAI_PROJECT_NAME:-}" ] && [ "$PORTABLE" = 1 ]; then
    if [ "$PROJECT_DIR" = "$STANDALONE_DIR" ]; then
        _pn="myai-standalone"
    else
        _pn=$(printf '%s' "$(basename "$PROJECT_DIR")" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-' | sed 's/^-*//;s/-*$//')
        [ -n "$_pn" ] || _pn="myai-app"
    fi
    MYAI_PROJECT_NAME="$_pn"
fi
export MYAI_PROJECT_NAME
MCP_PORT="${MYAI_MCP_PORT:-3100}"
GW_PORT="${MYAI_GATEWAY_HTTP_PORT:-3200}"
DASH_PORT="${MYAI_DASHBOARD_PORT:-3210}"
DASHBOARD_URL="http://localhost:${DASH_PORT}"

# ── arg parse: peel off myai-only flags, pass the rest to betac_up ────────────
NO_WAIT=0
HEALTH_TIMEOUT=120
KEEP_ON_FAIL=0
HEAL_RETRIES="${MYAI_HEAL_RETRIES:-1}"
case "$HEAL_RETRIES" in ''|*[!0-9]*) HEAL_RETRIES=1 ;; esac
HAS_RUNNER_FLAG=0
BETAC_ARGS=""           # bash 3.2-safe: space-joined, expanded unquoted (flags are token-safe)
while [ $# -gt 0 ]; do
    case "$1" in
        --no-wait)        NO_WAIT=1 ;;
        --keep-on-fail)   KEEP_ON_FAIL=1 ;;
        --timeout)        shift; HEALTH_TIMEOUT="${1:-120}" ;;
        --timeout=*)      HEALTH_TIMEOUT="${1#*=}" ;;
        --runner|--no-runner) HAS_RUNNER_FLAG=1; BETAC_ARGS="$BETAC_ARGS $1" ;;
        -h|--help)        grep '^#' "$0" | grep -v '^#!' | sed 's/^# \{0,1\}//'; exit 0 ;;
        *)                BETAC_ARGS="$BETAC_ARGS $1" ;;
    esac
    shift
done
# `myai up` is the Docker stack; keep the host launchd runner out of scope unless
# the operator explicitly asked for it (--runner). betac_up's default "ensure"
# only loads an already-installed runner, but --no-runner keeps the output clean
# and the contract honest: gateway + dashboard + mongo.
[ "$HAS_RUNNER_FLAG" = 0 ] && BETAC_ARGS="--no-runner $BETAC_ARGS"

# ── §13-class guard: the .vite-temp tmpfs mountpoint must pre-exist ────────────
guard_vite_temp() {
    grep -q 'node_modules/.vite-temp' "$REPO_ROOT/docker-compose.yml" 2>/dev/null || return 0
    local vt="$REPO_ROOT/runtime/node_modules/.vite-temp"
    if [ -d "$vt" ]; then
        c_info ".vite-temp mountpoint present"
    elif mkdir -p "$vt" 2>/dev/null; then
        c_ok "guarded .vite-temp mountpoint (recreated — post-purge §12 guard)"
    else
        c_warn ".vite-temp mountpoint missing and could not be created — a gateway rebuild may fail to start"
    fi
}

# ── health probe ──────────────────────────────────────────────────────────────
http_ok() { curl -fsS -o /dev/null --max-time 4 "$1" 2>/dev/null; }

# Read container health straight from Docker (curl-less fallback + the mongo
# probe, which has no HTTP surface). Resolve the container via compose first so
# auto-named portable stacks (<project>-<svc>-1) resolve too, not only
# container_name'd ones; fall back to a name grep when compose can't answer.
docker_health_ok() {
    local svc="$1" cid status
    cid=$( (cd "$PROJECT_DIR" && docker compose ps -q "$svc" 2>/dev/null) | head -1)
    [ -n "$cid" ] || cid=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E "\-${svc}(-[0-9]+)?\$" | head -1 || true)
    [ -n "$cid" ] || return 1
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$cid" 2>/dev/null || true)
    [ "$status" = "healthy" ] || [ "$status" = "running" ]
}

stack_healthy() {
    if command -v curl >/dev/null 2>&1; then
        http_ok "http://localhost:${GW_PORT}/health" && http_ok "http://localhost:${DASH_PORT}/api/health"
    else
        docker_health_ok gateway && docker_health_ok dashboard
    fi
}

wait_health() {
    local timeout="$1" waited=0 step="${MYAI_HEALTH_STEP:-3}"
    case "$step" in ''|*[!0-9]*|0) step=3 ;; esac
    c_info "waiting for health (gateway :${GW_PORT} + dashboard :${DASH_PORT}, up to ${timeout}s)…"
    while [ "$waited" -lt "$timeout" ]; do
        if stack_healthy; then
            c_ok "stack healthy — gateway + dashboard responding"
            return 0
        fi
        sleep "$step"; waited=$((waited + step))
    done
    c_warn "health wait timed out after ${timeout}s"
    return 1
}

# ── self-heal: bounded retry — capture logs, restart unhealthy, re-wait ───────
# The health gate never leaves a half-up stack silently running: on a failed
# wait it diagnoses WHICH services are unhealthy, snapshots their compose logs,
# restarts them (HEAL_RETRIES rounds, default 1), and re-waits. Exhausted →
# fail_summary_and_rollback stops the core services and `myai up` exits 1.
FAIL_LOG=""

unhealthy_services() {
    local out=""
    if command -v curl >/dev/null 2>&1; then
        http_ok "http://localhost:${GW_PORT}/health"       || out="$out gateway"
        http_ok "http://localhost:${DASH_PORT}/api/health" || out="$out dashboard"
    else
        docker_health_ok gateway   || out="$out gateway"
        docker_health_ok dashboard || out="$out dashboard"
    fi
    # mongo has no HTTP surface — read its container health directly; a dead
    # mongo is the usual root cause of an unhealthy gateway.
    docker_health_ok mongo || out="$out mongo"
    printf '%s' "${out# }"
}

capture_fail_logs() {
    FAIL_LOG="${TMPDIR:-/tmp}/myai-up-fail-$(date +%Y%m%d-%H%M%S).log"
    {
        echo "myai up — health-wait failure ($(date '+%Y-%m-%d %H:%M:%S'))"
        echo "project: $PROJECT_DIR (compose project: ${MYAI_PROJECT_NAME:-<default>})"
        echo "unhealthy: $*"
        echo
        echo "── docker compose ps ──"
        (cd "$PROJECT_DIR" && docker compose ps 2>&1)
        local svc
        for svc in "$@"; do
            echo
            echo "── docker compose logs --tail 120 $svc ──"
            (cd "$PROJECT_DIR" && docker compose logs --no-color --tail 120 "$svc" 2>&1)
        done
    } > "$FAIL_LOG" 2>&1 || true
    c_info "diagnostics captured → $FAIL_LOG"
}

run_health_gate() {
    wait_health "$HEALTH_TIMEOUT" && return 0
    local round=1 bad
    while [ "$round" -le "$HEAL_RETRIES" ]; do
        bad="$(unhealthy_services)"
        [ -n "$bad" ] || bad="gateway dashboard"   # probes flapping — heal the core pair
        c_warn "self-heal ${round}/${HEAL_RETRIES}: unhealthy → $bad — capturing logs, restarting"
        # shellcheck disable=SC2086
        capture_fail_logs $bad
        # shellcheck disable=SC2086
        (cd "$PROJECT_DIR" && docker compose restart $bad) || c_warn "docker compose restart failed for: $bad"
        if wait_health "$HEALTH_TIMEOUT"; then
            c_ok "self-heal recovered the stack (restart round ${round})"
            return 0
        fi
        round=$((round + 1))
    done
    return 1
}

fail_summary_and_rollback() {
    local bad
    bad="$(unhealthy_services)"
    echo
    hr
    c_err "myAI did NOT come up healthy — gave up after ${HEAL_RETRIES} restart round(s)"
    [ -n "$bad" ] && c_err "unhealthy: $bad"
    (cd "$PROJECT_DIR" && docker compose ps 2>/dev/null | sed 's/^/    /') || true
    [ -n "$FAIL_LOG" ] && c_info "full diagnostics: $FAIL_LOG"
    c_info "inspect:   myai status   ·   myai logs${bad:+ ${bad%% *}}"
    if [ "$KEEP_ON_FAIL" = 1 ]; then
        c_warn "--keep-on-fail: leaving the unhealthy stack running for live debugging"
    else
        c_warn "rolling back — stopping core services so nothing is left half-up (--keep-on-fail to skip)"
        if (cd "$PROJECT_DIR" && docker compose stop gateway dashboard mongo >/dev/null 2>&1); then
            c_ok "stack stopped — containers kept for postmortem (myai logs --no-follow still works)"
        else
            c_warn "docker compose stop failed — inspect with: docker compose ps"
        fi
    fi
    hr
}

# ── env-key reminder (bring-your-own .env) ────────────────────────────────────
warn_missing_key() {
    [ -n "${ANTHROPIC_API_KEY:-}" ] && return 0
    grep -qE '^ANTHROPIC_API_KEY=.+' "$REPO_ROOT/.env" 2>/dev/null && return 0
    c_warn "ANTHROPIC_API_KEY not set — LLM features are off. Add it to .env (bring-your-own key), or use the Claude CLI bridge."
}

# ── final banner ──────────────────────────────────────────────────────────────
print_ready() {
    echo
    hr
    c_ok "myAI is up — single-tenant, loopback-trusted (no login required on localhost)"
    echo
    printf '  %s%sDashboard%s   %s\n' "$BOLD" "$ORANGE" "$RESET" "$DASHBOARD_URL"
    c_info "Gateway MCP    http://localhost:${MCP_PORT}/mcp"
    c_info "Gateway REST   http://localhost:${GW_PORT}/health"
    warn_missing_key
    hr
}

# ── run ───────────────────────────────────────────────────────────────────────
if [ "$PORTABLE" = 1 ]; then
    # Downloader: run the portable stack from the init'd project, building the
    # gateway + dashboard images from the framework install (MYAI_FRAMEWORK_DIR).
    BUILD_FLAG=""
    case " $BETAC_ARGS " in *" --build "*) BUILD_FLAG="--build" ;; esac
    c_info "project   $PROJECT_DIR"
    c_info "framework  MYAI_FRAMEWORK_DIR=$MYAI_FRAMEWORK_DIR"
    # shellcheck disable=SC2086
    ( cd "$PROJECT_DIR" && docker compose up -d $BUILD_FLAG gateway dashboard mongo ) \
        || { c_err "docker compose up failed — see: (cd $PROJECT_DIR && docker compose logs)"; exit 1; }
else
    # Master framework repo: full betaC tooling (profiles, runner, betac compose).
    [ -x "$BETAC" ] || { c_err "scripts/betac_up.sh not found or not executable"; exit 1; }
    guard_vite_temp
    # shellcheck disable=SC2086
    "$BETAC" up $BETAC_ARGS
fi

if [ "$NO_WAIT" = 0 ] && ! run_health_gate; then
    if stack_healthy; then
        c_warn "stack turned healthy just after the wait gave up — continuing"
    else
        fail_summary_and_rollback
        exit 1
    fi
fi

print_ready
exit 0
