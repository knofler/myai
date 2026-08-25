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
COMPOSE_FILE="$(cd "$(dirname "$0")/.." && pwd)/docker-compose.runner.yml"
RUNNER_NAME="${RUNNER_NAME:-myai-local}"

dc() { docker compose -f "$COMPOSE_FILE" "$@"; }

need_gh() {
    command -v gh >/dev/null 2>&1 || { echo "FATAL: gh CLI not found"; exit 1; }
    gh auth status >/dev/null 2>&1 || { echo "FATAL: gh not authenticated (run: gh auth login)"; exit 1; }
}

mint_token() {
    gh api -X POST "repos/${REPO_SLUG}/actions/runners/registration-token" --jq .token 2>/dev/null
}

remote_status() {
    gh api "repos/${REPO_SLUG}/actions/runners" \
        --jq '.runners[] | "  \(.name)  status=\(.status)  busy=\(.busy)  labels=[\([.labels[].name] | join(","))]"' 2>/dev/null
}

case "${1:-status}" in
up)
    need_gh
    echo "▶ minting a registration token (single-use, ~1h TTL)…"
    TOKEN="$(mint_token)"
    [ -n "$TOKEN" ] || { echo "FATAL: could not mint a registration token (need admin on $REPO_SLUG)"; exit 1; }
    echo "▶ building + starting the runner…"
    RUNNER_TOKEN="$TOKEN" RUNNER_NAME="$RUNNER_NAME" dc up -d --build || exit 1
    echo "▶ waiting for GitHub to report it Online…"
    for i in $(seq 1 30); do
        sleep 2
        if gh api "repos/${REPO_SLUG}/actions/runners" --jq '.runners[].status' 2>/dev/null | grep -q online; then
            echo "✅ runner Online:"; remote_status; exit 0
        fi
    done
    echo "⚠ not Online after 60s — check: $0 logs"; exit 1
    ;;
status)
    echo "── container ──"
    docker ps --filter name=myai-gh-runner --format '  {{.Names}}\t{{.Status}}' 2>/dev/null | grep . || echo "  (not running)"
    echo "── registered at GitHub ──"
    need_gh
    remote_status | grep . || echo "  (no runners registered on $REPO_SLUG)"
    ;;
logs)   dc logs -f --tail=100 ;;
down)   dc down; echo "stopped (registration persists — 'up' restarts in seconds)" ;;
reset)
    need_gh
    echo "▶ removing runner registration + local volume…"
    dc down -v
    for id in $(gh api "repos/${REPO_SLUG}/actions/runners" --jq ".runners[] | select(.name==\"${RUNNER_NAME}\") | .id" 2>/dev/null); do
        gh api -X DELETE "repos/${REPO_SLUG}/actions/runners/${id}" 2>/dev/null && echo "  deregistered runner id=$id"
    done
    echo "done — run '$0 up' for a fresh registration"
    ;;
*) sed -n '5,16p' "$0"; exit 1 ;;
esac
