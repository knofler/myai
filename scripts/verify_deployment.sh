#!/usr/bin/env bash
# ============================================================
# verify_deployment.sh — confirm a merge actually deployed, without the
# short-sha trap that produced a false "no deployment registered" report.
# ============================================================
# THE BUG (2026-09-12, repeated 2026-09-14): `GET /repos/{r}/deployments?sha=
# <SHORT-SHA>` filters server-side on an EXACT sha match, so a 7/8-char short
# sha silently returns `[]` — indistinguishable from "nothing fired". Both
# incidents read that empty array as absence; one of them was wrong (the
# deployment had actually fired and succeeded 77s after the merge). The
# 2026-09-12 handoff's rule: "poll to a terminal state before claiming
# absence."
#
# THE FIX: list deployments UNFILTERED (no `sha=` query param at all), match
# client-side with a startswith prefix comparison (works for short or full
# sha, either direction), and poll the matched deployment's statuses to a
# TERMINAL state (success/failure/error/inactive) before printing a verdict.
# "No deployment found" is only ever reported after polling the full
# --timeout-sec window for a match — never off a single list call.
#
# THE REGRESSION IN THE FIX (2026-09-15, PR #454): the same merge sha gets
# TWO deployments — github-pages (fires at t+1s, reliably RED while hosted
# Actions is billing-blocked) and Vercel's `Production` (registered ~74s
# later). The first version of this script took the first sha match from ANY
# environment, locked onto the already-present github-pages one, and printed
# "RESULT: FAILURE" for a production deploy that succeeded. Two lessons:
#   (a) filter to the TARGET ENVIRONMENT — default `production`, matched
#       case-insensitively client-side (Vercel registers `Production`; a
#       server-side `environment=` query param is the same exact-match trap
#       as `sha=`). Pass `--environment any` for first-arrival-wins.
#   (b) "a deployment for this sha exists" ≠ "the deployment I care about
#       exists yet" — keep polling for the target environment until the
#       timeout; never terminate on a non-target environment's arrival.
#
# USAGE:
#   ./scripts/verify_deployment.sh <merge-sha> [--repo owner/repo]
#                                   [--environment <env>|any]  (default: production)
#                                   [--timeout-sec N] [--poll-sec N]
#
#   ./scripts/verify_deployment.sh dfd1df6a
#   ./scripts/verify_deployment.sh dfd1df6ab12c... --repo <owner>/<repo>
#
# Requires: gh (authenticated), jq.
#
# Exit codes:
#   0 — matched a deployment in the TARGET environment, terminal SUCCESS
#   1 — matched a deployment in the TARGET environment, terminal
#       FAILURE/ERROR/INACTIVE (never a non-target environment's failure)
#   2 — no deployment matching sha + target environment after polling the
#       full timeout window (this — and ONLY this — is the "no deployment
#       fired" verdict; sha matches in OTHER environments are listed but do
#       not change the verdict)
#   3 — matched a deployment but it never reached a terminal state within
#       the timeout (report as UNRESOLVED/pending, never as absence)
#   4 — usage / tooling error (missing arg, gh/jq unavailable, gh not authed)
# ============================================================
set -uo pipefail

log() { echo "[verify-deployment $(date -u +%H:%M:%S)Z] $*"; }

# ── pure helpers (unit-testable via VERIFY_DEPLOYMENT_LIB_ONLY=1) ──────────

# deploy_sha_matches <query-sha> <candidate-sha> → 0 (match) / 1 (no match).
# Prefix-compares in whichever direction is shorter, so a short query sha
# matches a full candidate sha and vice versa.
deploy_sha_matches() {
    local q="${1:-}" c="${2:-}"
    [ -n "$q" ] && [ -n "$c" ] || return 1
    local qn=${#q} cn=${#c} n
    n=$(( qn < cn ? qn : cn ))
    [ "${q:0:$n}" = "${c:0:$n}" ]
}

# deploy_env_matches <target-env> <candidate-env> → 0 (match) / 1 (no match).
# Case-insensitive, so the default target `production` matches Vercel's
# registered `Production`. Target `any` matches every environment (explicit
# opt-in to first-arrival-wins — the pre-2026-09-15 behavior that locked
# onto a red github-pages deployment and misreported a successful prod ship).
deploy_env_matches() {
    local t="${1:-}" c="${2:-}"
    [ "$t" = "any" ] && return 0
    [ -n "$t" ] && [ -n "$c" ] || return 1
    [ "$(printf '%s' "$t" | tr '[:upper:]' '[:lower:]')" = "$(printf '%s' "$c" | tr '[:upper:]' '[:lower:]')" ]
}

# deploy_status_verdict <state> → success | failure | pending
# Classifies a single GitHub deployment_status `state` value. Terminal states
# per the API: success, failure, error, inactive. Non-terminal: pending,
# queued, in_progress, and no status at all yet.
deploy_status_verdict() {
    case "${1:-}" in
        success) echo success ;;
        failure|error|inactive) echo failure ;;
        *) echo pending ;;
    esac
}

# ── unit-test hook (scripts/tests/test_verify_deployment.sh) ───────────────
# shellcheck disable=SC2317  # reached when the unit test sources this file as a library
if [ "${VERIFY_DEPLOYMENT_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

# ── args ─────────────────────────────────────────────────────────────────
MERGE_SHA="" REPO="" ENVIRONMENT="${VERIFY_DEPLOYMENT_ENVIRONMENT:-production}" TIMEOUT_SEC="${VERIFY_DEPLOYMENT_TIMEOUT_SEC:-300}" POLL_SEC="${VERIFY_DEPLOYMENT_POLL_SEC:-15}"
while [ $# -gt 0 ]; do
    case "$1" in
        --repo)         shift; REPO="${1:?--repo needs a value}" ;;
        --environment)  shift; ENVIRONMENT="${1:?--environment needs a value}" ;;
        --timeout-sec)  shift; TIMEOUT_SEC="${1:?--timeout-sec needs a value}" ;;
        --poll-sec)     shift; POLL_SEC="${1:?--poll-sec needs a value}" ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        -*) echo "ERROR: unknown flag: $1" >&2; exit 4 ;;
        *) MERGE_SHA="$1" ;;
    esac
    shift
done

[ -n "$MERGE_SHA" ] || { echo "ERROR: usage: verify_deployment.sh <merge-sha> [--repo owner/repo] [--environment env|any] [--timeout-sec N] [--poll-sec N]" >&2; exit 4; }
command -v gh  >/dev/null 2>&1 || { echo "ERROR: gh CLI not found" >&2; exit 4; }
command -v jq  >/dev/null 2>&1 || { echo "ERROR: jq not found" >&2; exit 4; }
gh auth status >/dev/null 2>&1 || { echo "ERROR: gh not authenticated" >&2; exit 4; }

if [ -z "$REPO" ]; then
    REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || true)"
    [ -n "$REPO" ] || { echo "ERROR: could not resolve repo — pass --repo owner/repo" >&2; exit 4; }
fi

log "watching $REPO for a deployment matching sha $MERGE_SHA in environment '$ENVIRONMENT' (timeout ${TIMEOUT_SEC}s, poll ${POLL_SEC}s)"

# List UNFILTERED and match environment client-side too: the server-side
# `environment=` query param is the same exact-match trap as `sha=` (Vercel
# registers `Production`, capital P — `environment=production` would miss it).
DEPLOY_QS="repos/$REPO/deployments?per_page=100"

DEADLINE=$(( $(date +%s) + TIMEOUT_SEC ))
DEPLOY_ID="" DEPLOY_SHA="" DEPLOY_ENV="" DEPLOY_URL="" OTHER_ENVS=""

# ── phase 1: find the deployment (unfiltered list + client-side sha AND
#    environment match). A sha match in a NON-target environment (e.g. the
#    reliably-red github-pages docs deploy that fires at t+1s) never ends
#    this loop — the target environment lands ~74s after the merge, so keep
#    polling for it until the deadline. ──────────────────────────────────
while :; do
    LIST_JSON="$(gh api "$DEPLOY_QS" 2>/dev/null || echo '[]')"
    MATCH_JSON="$(printf '%s' "$LIST_JSON" | jq -c '. // []' 2>/dev/null || echo '[]')"

    while IFS= read -r row; do
        [ -n "$row" ] || continue
        cand_sha="$(printf '%s' "$row" | jq -r '.sha // empty')"
        deploy_sha_matches "$MERGE_SHA" "$cand_sha" || continue
        cand_env="$(printf '%s' "$row" | jq -r '.environment // "unknown"')"
        if deploy_env_matches "$ENVIRONMENT" "$cand_env"; then
            DEPLOY_ID="$(printf '%s' "$row" | jq -r '.id')"
            DEPLOY_SHA="$cand_sha"
            DEPLOY_ENV="$cand_env"
            break
        fi
        case " $OTHER_ENVS " in
            *" $cand_env "*) ;;
            *)  OTHER_ENVS="${OTHER_ENVS:+$OTHER_ENVS }$cand_env"
                log "sha matched a deployment in environment '$cand_env' — not the target '$ENVIRONMENT'; ignoring it and continuing to poll" ;;
        esac
    done < <(printf '%s' "$MATCH_JSON" | jq -c 'sort_by(.id) | reverse | .[]' 2>/dev/null)

    [ -n "$DEPLOY_ID" ] && break
    NOW=$(date +%s)
    [ "$NOW" -lt "$DEADLINE" ] || break
    sleep "$POLL_SEC"
done

if [ -z "$DEPLOY_ID" ]; then
    if [ -n "$OTHER_ENVS" ]; then
        log "RESULT: no deployment matching $MERGE_SHA in target environment '$ENVIRONMENT' after polling ${TIMEOUT_SEC}s — the sha DID deploy to other environment(s): $OTHER_ENVS. Their verdicts do NOT apply to '$ENVIRONMENT' (re-run with --environment <env> to poll one of them)."
    else
        log "RESULT: no deployment matching $MERGE_SHA (environment '$ENVIRONMENT') found in $REPO after polling ${TIMEOUT_SEC}s — genuine absence, not a query artefact."
    fi
    exit 2
fi

log "matched deployment id=$DEPLOY_ID sha=$DEPLOY_SHA environment=$DEPLOY_ENV — polling statuses to a terminal state"

# ── phase 2: poll that deployment's statuses to a terminal state ──────────
VERDICT="pending"
while :; do
    STATUSES_JSON="$(gh api "repos/$REPO/deployments/$DEPLOY_ID/statuses?per_page=100" 2>/dev/null || echo '[]')"
    LATEST_STATE="$(printf '%s' "$STATUSES_JSON" | jq -r 'sort_by(.id) | reverse | .[0].state // empty' 2>/dev/null)"
    DEPLOY_URL="$(printf '%s' "$STATUSES_JSON" | jq -r 'sort_by(.id) | reverse | map(select(.environment_url != null and .environment_url != "")) | .[0].environment_url // empty' 2>/dev/null)"

    if [ -n "$LATEST_STATE" ]; then
        VERDICT="$(deploy_status_verdict "$LATEST_STATE")"
        [ "$VERDICT" != "pending" ] && break
    fi

    NOW=$(date +%s)
    [ "$NOW" -lt "$DEADLINE" ] || break
    sleep "$POLL_SEC"
done

log "state=${LATEST_STATE:-none} environment=$DEPLOY_ENV environment_url=${DEPLOY_URL:-none}"

case "$VERDICT" in
    success)
        log "RESULT: SUCCESS — deployment $DEPLOY_ID ($DEPLOY_SHA, environment $DEPLOY_ENV) is live at ${DEPLOY_URL:-<no environment_url reported>}"
        exit 0 ;;
    failure)
        log "RESULT: FAILURE — deployment $DEPLOY_ID ($DEPLOY_SHA, environment $DEPLOY_ENV) ended in state '$LATEST_STATE'"
        exit 1 ;;
    *)
        log "RESULT: UNRESOLVED — deployment $DEPLOY_ID ($DEPLOY_SHA, environment $DEPLOY_ENV) had not reached a terminal state after ${TIMEOUT_SEC}s (last state: ${LATEST_STATE:-none}). This is NOT an absence — re-run with a longer --timeout-sec or check manually."
        exit 3 ;;
esac
