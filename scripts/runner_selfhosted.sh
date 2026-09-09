#!/usr/bin/env bash
# runner_selfhosted.sh — manage the local self-hosted GitHub Actions runner.
#
# WHY: ai_management is a PRIVATE repo, so every GitHub-hosted Actions minute is
# metered, and 8 workflows fire per PR-to-main (two of them on windows-latest at
# a 2x multiplier). Self-hosted runners consume ZERO billable minutes on any repo
# visibility. This machine already verifies the same gates locally via local-ci.sh.
#
# Usage:
#   scripts/runner_selfhosted.sh up       # build + register + start
#   scripts/runner_selfhosted.sh status   # is it Online at GitHub? busy?
#   scripts/runner_selfhosted.sh logs     # tail runner logs
#   scripts/runner_selfhosted.sh down     # stop (config persists; re-`up` is instant)
#   scripts/runner_selfhosted.sh reset    # deregister + wipe volume (fresh registration)
#
# SAFETY: only ever point a self-hosted runner at a repo you control. On a PUBLIC
# repo a forked PR could execute untrusted code on this machine.
set -uo pipefail

REPO_SLUG="knofler/ai_management"
# The runner lives in the main compose file under the `ci` profile (one myai
# namespace in Docker Desktop). Every command here must pass --profile ci or
# compose resolves the service to nothing and silently no-ops.
COMPOSE_FILE="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.yml"
# MACHINE-UNIQUE BY DEFAULT — do not flatten this back to a constant.
# entrypoint.sh registers with `config.sh --unattended --replace --name "$RUNNER_NAME"`.
# `--replace` means a SECOND machine using the SAME name does not error: it
# silently TAKES OVER the first machine's registration, and that Mac's runner
# goes offline and stops taking jobs with no message anywhere. A per-host default
# makes the collision impossible by construction.
# (Legacy: work-desktop registered as `myai-local` before this default existed. Its
# next `up` will register `myai-<its-hostname>` and leave `myai-local` behind as
# an offline entry — delete that one stale runner in GitHub settings once, or
# pin RUNNER_NAME=myai-local on that machine.)
RUNNER_NAME="${RUNNER_NAME:-myai-$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')}"

# MACHINE-DECIDED MEMORY CAP — detect the Mac, then decide. The runner is
# CI infra (excluded from the 2 GB app-stack RAM guard) so its cap is per-host,
# not one fleet constant: a laptop caps it low, a build box leaves it high. The
# DECISION lives in config/gh_runner_mem.txt keyed by `hostname -s`, so nothing
# machine-specific has to live in .env (which Dropbox-syncs to every Mac). An
# explicit GH_RUNNER_MEM_LIMIT in the environment still wins over the map.
. "$(cd "$(dirname "$0")" && pwd)/lib/runner_mem.sh"
GH_RUNNER_MEM_LIMIT="${GH_RUNNER_MEM_LIMIT:-$(resolve_runner_mem)}"
export GH_RUNNER_MEM_LIMIT

dc() { docker compose -f "$COMPOSE_FILE" --profile ci "$@"; }

# EVERY compose verb below is scoped to the gh-runner SERVICE. Now that the
# runner shares a compose file with gateway/dashboard/mongo, an unscoped
# `down`/`up` here would tear down or start the entire myai stack — the runner
# script must never touch the app containers.
SVC="gh-runner"
VOLUME="ai_gh-runner-config"
# Mirrors container_name for the gh-runner service. Kept beside SVC/VOLUME so a
# rename is a one-line change here, not a silent "(not running)" in `status`.
CONTAINER="myai-gh-runner"

need_gh() {
    command -v gh >/dev/null 2>&1 || { echo "FATAL: gh CLI not found"; exit 1; }
    gh auth status >/dev/null 2>&1 || { echo "FATAL: gh not authenticated (run: gh auth login)"; exit 1; }
}

mint_token() {
    gh api -X POST "repos/${REPO_SLUG}/actions/runners/registration-token" --jq .token 2>/dev/null
}

# The agentName THIS machine last registered, read straight out of the pinned
# volume via a throwaway container so it works whether or not the runner is up.
local_runner_name() {
    docker run --rm -v "${VOLUME}:/c" alpine:3 \
        sh -c 'sed -n "s/.*\"agentName\": *\"\([^\"]*\)\".*/\1/p" /c/.runner 2>/dev/null' 2>/dev/null | tr -d "\r"
}

# All `actions/runners` reads below use --paginate: the endpoint pages at 30,
# and a name-lookup / deregister that missed a runner on page 2 would silently
# act on a partial set (MYTHOS: never trust a truncated list). --jq is applied
# per page, so `.runners[] | select(...)` still sees every runner across pages.
remote_status() {
    gh api --paginate "repos/${REPO_SLUG}/actions/runners" \
        --jq '.runners[] | "  \(.name)  status=\(.status)  busy=\(.busy)  labels=[\([.labels[].name] | join(","))]"' 2>/dev/null
}

LOCAL_NAME="$(local_runner_name)"

case "${1:-status}" in
up)
    need_gh
    echo "▶ minting a registration token (single-use, ~1h TTL)…"
    TOKEN="$(mint_token)"
    [ -n "$TOKEN" ] || { echo "FATAL: could not mint a registration token (need admin on $REPO_SLUG)"; exit 1; }
    # COLLISION PRE-FLIGHT: refuse to steal another machine's registration.
    # OWNERSHIP IS DECIDED BY THE VOLUME, NOT BY "is a container running".
    # `.runner` in the name-pinned volume records the agentName THIS machine
    # registered; that is the only local fact that proves ownership, and it
    # survives the container being down. ("is our container up" is NOT a
    # substitute: with a container running under some OTHER name, that test
    # passes and we would still hijack the name being requested.)
    if gh api --paginate "repos/${REPO_SLUG}/actions/runners" \
         --jq ".runners[] | select(.name==\"${RUNNER_NAME}\") | .name" 2>/dev/null | grep -q .; then
        if [ "$LOCAL_NAME" != "$RUNNER_NAME" ]; then
            if [ "${RUNNER_REPLACE:-0}" != "1" ]; then
                echo "REFUSING: a runner named '${RUNNER_NAME}' is already registered on ${REPO_SLUG},"
                echo "          but this machine's volume is registered as '${LOCAL_NAME:-<never registered>}'"
                echo "          — so '${RUNNER_NAME}' belongs to ANOTHER machine."
                echo "          Registering would silently take it over (config.sh --replace) and knock"
                echo "          that machine's runner offline."
                echo "          Pick a distinct name:  RUNNER_NAME=myai-<something> $0 up"
                echo "          Or, if you are certain this machine owns it:  RUNNER_REPLACE=1 $0 up"
                exit 1
            fi
            echo "⚠ RUNNER_REPLACE=1 — deliberately taking over '${RUNNER_NAME}'"
        fi
    fi

    echo "▶ building + starting the runner… (name: ${RUNNER_NAME}, mem: ${GH_RUNNER_MEM_LIMIT})"
    RUNNER_TOKEN="$TOKEN" RUNNER_NAME="$RUNNER_NAME" dc up -d --build "$SVC" || exit 1
    echo "▶ waiting for GitHub to report '${RUNNER_NAME}' Online…"
    # Must match THIS runner by NAME. The old check grepped `.runners[].status`
    # for any online runner, so on a fleet with a second machine already up it
    # returned success instantly — a false green that reported our runner Online
    # before it had registered at all. Verified: that is exactly what it did on
    # runner-host 2026-08-27 while `myai-local` (work-desktop) was online.
    for i in $(seq 1 45); do
        sleep 2
        if gh api --paginate "repos/${REPO_SLUG}/actions/runners" \
             --jq ".runners[] | select(.name==\"${RUNNER_NAME}\" and .status==\"online\") | .name" \
             2>/dev/null | grep -q .; then
            echo "✅ runner '${RUNNER_NAME}' Online:"; remote_status; exit 0
        fi
    done
    echo "⚠ '${RUNNER_NAME}' not Online after 90s — check: $0 logs"; exit 1
    ;;
status)
    echo "── container ──"
    docker ps --filter "name=$CONTAINER" --format '  {{.Names}}\t{{.Status}}' 2>/dev/null | grep . || echo "  (not running)"
    echo "── registered at GitHub ──"
    need_gh
    remote_status | grep . || echo "  (no runners registered on $REPO_SLUG)"
    ;;
logs)   dc logs -f --tail=100 "$SVC" ;;
# stop+rm the single service — NOT `down`, which would take the app stack with it.
# Every compose call is `|| exit 1`: this script has no `set -e`, and it now drives
# the APP compose file, which carries mandatory interpolations (${MONGODB_URI:?}).
# On a machine with no .env every verb here fails — without the guard the script
# would print "stopped" and exit 0 while the runner kept taking jobs.
down)   dc stop "$SVC" || { echo "FATAL: could not stop $SVC (is .env present?)"; exit 1; }
        dc rm -f "$SVC" || { echo "FATAL: could not remove $SVC"; exit 1; }
        echo "stopped (registration persists — 'up' restarts in seconds)" ;;
reset)
    need_gh
    echo "▶ removing runner registration + local volume…"
    # Local teardown MUST fully succeed before the GitHub-side deletion. Otherwise
    # a failed wipe leaves .runner on the volume while the registration is deleted
    # upstream — entrypoint.sh then takes its "already registered" branch and
    # auth-fails forever, which `up` cannot repair.
    dc stop "$SVC" || { echo "FATAL: could not stop $SVC (is .env present?)"; exit 1; }
    dc rm -f "$SVC" || { echo "FATAL: could not remove $SVC"; exit 1; }
    # The volume is name-pinned, so `down -v` semantics have to be explicit. Errors
    # are surfaced, never swallowed — a still-mounted volume means an aborted reset.
    if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
        docker volume rm "$VOLUME" >/dev/null || {
            echo "FATAL: could not remove volume $VOLUME — registration left intact on purpose."
            echo "       Resolve the volume (docker volume rm $VOLUME) and re-run '$0 reset'."
            exit 1
        }
        echo "  removed volume $VOLUME"
    else
        echo "  volume $VOLUME already absent"
    fi
    for id in $(gh api --paginate "repos/${REPO_SLUG}/actions/runners" --jq ".runners[] | select(.name==\"${RUNNER_NAME}\") | .id" 2>/dev/null); do
        gh api -X DELETE "repos/${REPO_SLUG}/actions/runners/${id}" 2>/dev/null && echo "  deregistered runner id=$id"
    done
    echo "done — run '$0 up' for a fresh registration"
    ;;
*) sed -n '5,16p' "$0"; exit 1 ;;
esac
