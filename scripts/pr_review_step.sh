#!/usr/bin/env bash
# pr_review_step.sh — automated fleet PR review, per documentation/PR_REVIEW_RUBRIC.md.
#
# LANE: runner-driven RECURRING TASK (recurring_tasks_create), never a GitHub
# Actions workflow (Actions is billing-blocked) and never a gateway cron —
# the gateway cron dispatches MCP tools/agents in-gateway, this needs a full
# `claude -p` headless review + `gh` calls, which only the CLI runner host
# environment can do. See documentation/PR_REVIEW_RUBRIC.md for the full lane
# design and the P0/P1/P2 rubric this script enforces.
#
# WHAT IT DOES, per fleet repo (config/managed_repos.txt via repo_paths.sh,
# skipping anything in config/schedule_ignore.txt):
#   1. `gh pr list --limit 200` (paginated/guarded via lib/gh_list.sh — never
#      the silently-truncated 30-item default, task-39d2bf78).
#   2. Skip a PR whose head SHA already carries a `myai-review` commit status
#      (idempotent — a re-fire never reviews the same SHA twice).
#   3. Fetch the diff (cap 400 KB; over cap → file list + additions/deletions
#      "risk hotspots" only, never blow the review prompt up). Headless
#      review via `claude -p` — Sonnet by default; any P0 the Sonnet pass
#      finds is re-checked once on Opus (or Fable when Opus is paced out)
#      before it is posted, mirroring cli_task_runner.sh's own
#      failure-escalation shape (ESCALATION_MODEL).
#   4. Post ONE consolidated PR comment (Verdict/P0/P1/P2/Notes, per the
#      rubric's Output contract), set commit status `myai-review` (success =
#      no P0, failure = P0 present), and label `myai-reviewed`.
#   5. Record the run via the gateway `job_history_record` MCP tool so the
#      dashboard /runs page shows it (same call shape as
#      scripts/ingest_runner_history.sh).
#
# Hard caps: one review per head SHA (state #2), 3 reviews per PR lifetime
# (MAX_REVIEWS_PER_PR, tracked via the `myai-review` status description),
# and a per-PR cost guard — config/session-limits.json → pr_review.max_usd
# (default 0.40): if the pre-flight cost estimate for the diff exceeds the
# cap, the run aborts THAT PR with commit status `error` and a one-line
# reason instead of spending anything.
#
#   ./scripts/pr_review_step.sh                    # review every eligible PR, fleet-wide
#   ./scripts/pr_review_step.sh --dry-run           # log what would happen, write/post nothing
#   ./scripts/pr_review_step.sh --repo ai_management  # limit to one repo (by basename)
#   ./scripts/pr_review_step.sh --pr 42 --repo foo  # limit to one PR (manual re-review)
#
# ENV: GATEWAY_MCP (default http://localhost:3100/mcp), REVIEW_MODEL (default
#      claude-sonnet-5), ESCALATION_MODEL (default claude-opus-5-5),
#      FABLE_MODEL (default claude-fable-5-1, used when Opus is paced out —
#      PACED_OUT_TO_FABLE=1), CLI_CMD (default claude), PR_REVIEW_MAX_USD
#      (overrides the config/session-limits.json cap for this run).
#
# Pure parsing/decision helpers (pr_review_has_status, pr_review_parse_verdict,
# pr_review_status_for_verdict, pr_review_estimate_cost_usd, ...) are unit
# tested by scripts/tests/test_pr_review_step.sh, which sources this file with
# PR_REVIEW_LIB_ONLY=1 (same convention as reconcile_review_tasks.sh's
# RECONCILE_LIB_ONLY) so the test suite never touches gh/claude/the gateway.
set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
REPO_ROOT="$(cd "$SELF_DIR/.." && pwd)"
LIB_DIR="$SELF_DIR/lib"

. "$LIB_DIR/gh_list.sh"
. "$LIB_DIR/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
. "$LIB_DIR/repo_paths.sh" 2>/dev/null || true

GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"
REVIEW_MODEL="${REVIEW_MODEL:-claude-sonnet-5}"
ESCALATION_MODEL="${ESCALATION_MODEL:-claude-opus-5-5}"
FABLE_MODEL="${FABLE_MODEL:-claude-fable-5-1}"
CLI_CMD="${CLI_CMD:-claude}"
STATUS_CONTEXT="myai-review"
REVIEW_LABEL="myai-reviewed"
DIFF_CAP_BYTES="${DIFF_CAP_BYTES:-400000}"
MAX_REVIEWS_PER_PR="${MAX_REVIEWS_PER_PR:-3}"
IGNORE_FILE="${SCHEDULE_IGNORE_FILE:-$REPO_ROOT/config/schedule_ignore.txt}"
SESSION_LIMITS_FILE="${SESSION_LIMITS_FILE:-$REPO_ROOT/config/session-limits.json}"

# ── pure helpers (unit tested — no gh/claude/gateway calls in here) ─────────

# pr_review_ignored_repos <ignore-file> → one repo name per line (comments/
# blanks stripped). Mirrors config/schedule_ignore.txt's own documented format.
pr_review_ignored_repos() {
    local f="$1"
    [ -f "$f" ] || return 0
    grep -v '^[[:space:]]*#' "$f" 2>/dev/null | grep -v '^[[:space:]]*$' | sed -e 's/[[:space:]]*$//' -e 's/^[[:space:]]*//'
}

# pr_review_is_ignored <repo-name> <ignore-file> → 0 (true) iff listed.
pr_review_is_ignored() {
    local repo="$1" f="$2" line
    while IFS= read -r line; do
        [ -n "$line" ] && [ "$line" = "$repo" ] && return 0
    done < <(pr_review_ignored_repos "$f")
    return 1
}

# pr_review_max_usd <session-limits.json> → pr_review.max_usd, default 0.40.
# PR_REVIEW_MAX_USD env always wins (manual override for a single run).
pr_review_max_usd() {
    if [ -n "${PR_REVIEW_MAX_USD:-}" ]; then printf '%s' "$PR_REVIEW_MAX_USD"; return 0; fi
    local f="$1" v
    if [ -f "$f" ] && command -v python3 >/dev/null 2>&1; then
        v="$(/usr/bin/python3 -c '
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    v = d.get("pr_review", {}).get("max_usd")
    print(v if v is not None else "")
except Exception:
    print("")' "$f" 2>/dev/null)"
        [ -n "$v" ] && { printf '%s' "$v"; return 0; }
    fi
    printf '0.40'
}

# pr_review_has_status <commit-status-json> <context> → "yes"/"no". Input is
# the JSON from `gh api repos/<nwo>/commits/<sha>/status` ({"statuses":[...]}
# — each entry the LATEST for its context, per GitHub's Combined Status API),
# so presence of one entry with a matching context is sufficient — no need to
# pick the newest ourselves.
pr_review_has_status() {
    local json="$1" ctx="$2"
    printf '%s' "$json" | CTX="$ctx" /usr/bin/python3 -c '
import sys, json, os
try:
    d = json.load(sys.stdin)
except Exception:
    print("no"); sys.exit(0)
ctx = os.environ["CTX"]
for s in (d.get("statuses") or []):
    if s.get("context") == ctx:
        print("yes"); sys.exit(0)
print("no")'
}

# pr_review_estimate_cost_usd <diff-bytes> <model> → USD estimate (2dp).
# tokens ~= bytes/4 (rough English/code average); rates mirror
# cli_task_runner.sh's estimate_task_cost_usd (kept in sync manually with
# runtime/src/llm/cost-estimator.ts's per-million OUTPUT rates). Treats the
# whole diff as if it were output-priced — conservative on purpose: this is a
# pre-flight gate, not a post-hoc actual.
pr_review_estimate_cost_usd() {
    local bytes="${1:-0}" model="${2:-claude-sonnet-5}" rate tokens
    case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
    case "$model" in
        *opus*)   rate=25.00 ;;
        *haiku*)  rate=4.00  ;;
        *fable*)  rate=50.00 ;;
        *sonnet*) rate=15.00 ;;
        *)        rate=15.00 ;;
    esac
    tokens=$(( bytes / 4 ))
    awk -v t="$tokens" -v r="$rate" 'BEGIN{printf "%.2f", (t/1000000)*r}'
}

# pr_review_over_cap <estimate-usd> <cap-usd> → 0 (true) iff estimate > cap.
pr_review_over_cap() {
    awk -v e="${1:-0}" -v c="${2:-0}" 'BEGIN{exit !(e > c)}'
}

# pr_review_parse_verdict <raw-model-output> → normalized single-line JSON
# {"verdict":"APPROVE"|"REQUEST CHANGES","p0":n,"p1":n,"p2":n}. The review
# prompt (build_review_prompt below) instructs the model to end its reply
# with exactly one machine-readable line: `VERDICT_JSON: {...}`. This pulls
# the LAST such line out of otherwise-freeform markdown (the human-readable
# review, per the rubric's Output contract, is posted verbatim as the PR
# comment; this line is stripped from neither — GitHub renders an unknown
# trailing line harmlessly, but callers that want the pure comment body use
# pr_review_strip_verdict_line). FAILS CLOSED: no parseable line, or a p0
# count that doesn't parse, → REQUEST CHANGES / p0=1 (never silently APPROVE
# on a parse failure) with a synthetic p0 note.
pr_review_parse_verdict() {
    local raw="$1"
    printf '%s' "$raw" | /usr/bin/python3 -c '
import sys, json, re

text = sys.stdin.read()
m = None
for line in text.splitlines():
    mm = re.match(r"^\s*VERDICT_JSON:\s*(\{.*\})\s*$", line)
    if mm:
        m = mm  # keep the LAST match (loop runs in order)
fail_closed = {"verdict": "REQUEST CHANGES", "p0": 1, "p1": 0, "p2": 0, "parse_error": True}
if not m:
    print(json.dumps(fail_closed)); sys.exit(0)
try:
    d = json.loads(m.group(1))
except Exception:
    print(json.dumps(fail_closed)); sys.exit(0)
def as_int(v):
    try:
        n = int(v)
        return n if n >= 0 else 0
    except Exception:
        return 0
verdict = d.get("verdict")
if verdict not in ("APPROVE", "REQUEST CHANGES"):
    verdict = "REQUEST CHANGES"
out = {"verdict": verdict, "p0": as_int(d.get("p0")), "p1": as_int(d.get("p1")), "p2": as_int(d.get("p2"))}
# Internal inconsistency (model said APPROVE but also reported a P0) is
# itself a P0-shaped failure — never trust a bare "APPROVE" string over the
# P0 count it shipped alongside.
if out["p0"] > 0:
    out["verdict"] = "REQUEST CHANGES"
print(json.dumps(out))'
}

# pr_review_status_for_verdict <verdict-json> → "<state>\t<description>" where
# state is success (no P0) or failure (P0 present) — the two states this
# script ever posts for the `myai-review` context itself (the separate
# `error` state, for the cost-cap abort path, is posted directly by the
# caller since it never reaches a verdict at all).
pr_review_status_for_verdict() {
    local verdict_json="$1"
    printf '%s' "$verdict_json" | /usr/bin/python3 -c '
import sys, json
d = json.loads(sys.stdin.read())
p0, p1, p2 = d.get("p0", 0), d.get("p1", 0), d.get("p2", 0)
if p0 > 0:
    print(f"failure\tmyAI review: {p0} P0, {p1} P1, {p2} P2 — blocks merge")
else:
    print(f"success\tmyAI review: 0 P0, {p1} P1, {p2} P2")'
}

# pr_review_needs_escalation <verdict-json> → 0 (true) iff the Sonnet pass
# reported at least one P0 (the rubric's "any P0 candidate is re-checked once
# by Opus/Fable before it is posted").
pr_review_needs_escalation() {
    local p0
    p0="$(printf '%s' "$1" | /usr/bin/python3 -c 'import sys,json; print(json.loads(sys.stdin.read()).get("p0",0))' 2>/dev/null)"
    case "$p0" in ''|*[!0-9]*) p0=0 ;; esac
    [ "$p0" -gt 0 ]
}

# pr_review_escalation_model <paced-out-to-fable> → which model re-checks a
# P0 candidate. Mirrors cli_task_runner.sh's own paced-out-to-Fable fallback:
# Opus is the default escalation tier; when the daily Opus cap has paced this
# fire out (PACED_OUT_TO_FABLE=1), fall back to Fable instead of skipping the
# re-check entirely.
pr_review_escalation_model() {
    local paced="${1:-${PACED_OUT_TO_FABLE:-0}}"
    if [ "$paced" = "1" ]; then printf '%s' "$FABLE_MODEL"; else printf '%s' "$ESCALATION_MODEL"; fi
}

# pr_review_within_lifetime_cap <reviews-so-far> <max> → 0 (true) iff another
# review is still allowed for this PR (hard cap: 3 reviews per PR lifetime).
pr_review_within_lifetime_cap() {
    local so_far="${1:-0}" max="${2:-$MAX_REVIEWS_PER_PR}"
    case "$so_far" in ''|*[!0-9]*) so_far=0 ;; esac
    [ "$so_far" -lt "$max" ]
}

# pr_review_build_prompt <rubric-text> <diff-or-filelist> → the full headless
# review prompt, ending with the Output contract + the VERDICT_JSON line the
# parser above requires.
pr_review_build_prompt() {
    local rubric="$1" body="$2"
    cat <<PROMPT
You are the myAI fleet automated PR reviewer. Review the pull request below
strictly against this rubric. Be concrete: every P0/P1 finding must cite a
file:line and a one-line reason it blocks/should-fix.

$rubric

── PR diff / file list ──────────────────────────────────────────
$body
── end PR diff / file list ──────────────────────────────────────

Reply in the exact Output contract from the rubric above (## myAI review —
Verdict, then P0/P1/P2/Notes sections). Then, as the VERY LAST line of your
reply and on a line by itself, emit exactly:
VERDICT_JSON: {"verdict":"APPROVE"|"REQUEST CHANGES","p0":<int>,"p1":<int>,"p2":<int>}
PROMPT
}

# pr_review_diff_body <diff-text> <name-status-text> <additions> <deletions>
# <cap-bytes> → the text handed to the model: the raw diff if it fits under
# the cap, else the file list + additions/deletions "risk hotspots" instead
# (never truncates a diff mid-hunk, which would hide exactly the kind of
# finding the rubric cares about).
pr_review_diff_body() {
    local diff="$1" filelist="$2" additions="${3:-0}" deletions="${4:-0}" cap="${5:-$DIFF_CAP_BYTES}" bytes
    bytes="${#diff}"
    if [ "$bytes" -le "$cap" ]; then
        printf '%s' "$diff"
    else
        printf 'DIFF TOO LARGE (%s bytes > %s cap) — reviewing file list + risk hotspots only.\n+%s / -%s lines across the PR.\n\n%s' \
            "$bytes" "$cap" "$additions" "$deletions" "$filelist"
    fi
}

# ── unit-test hook — stop here before any gh/claude/gateway/network call ───
if [ "${PR_REVIEW_LIB_ONLY:-0}" = "1" ]; then return 0 2>/dev/null || exit 0; fi

# ── impure helpers (network — not unit tested; follow established repo patterns) ──

mcp() { # mcp <tool> <json-args>
    local body raw
    body="{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"$1\",\"arguments\":$2}}"
    raw="$(curl -sf -m 20 -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
        -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" -d "$body" 2>/dev/null || true)"
    [ -n "$raw" ] || return 1
    printf '%s' "$raw" | /usr/bin/python3 -c 'import sys,json; print(json.load(sys.stdin)["result"]["content"][0]["text"])' 2>/dev/null
}

log() { echo "[pr-review $(date -u +%H:%M:%S)Z] $*"; }

run_claude_review() { # <prompt> <model> → raw stdout text (empty on failure)
    local prompt="$1" model="$2"
    printf '%s' "$prompt" | "$CLI_CMD" -p --model "$model" --permission-mode auto 2>/dev/null || true
}

# repo_nwo_for_path <abs-repo-path> → owner/repo, or "" if unresolvable.
repo_nwo_for_path() {
    local p="$1"
    (cd "$p" 2>/dev/null && gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null) || true
}

DRY_RUN=false
REPO_FILTER=""
PR_FILTER=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY_RUN=true ;;
        --repo)    shift; REPO_FILTER="${1:?--repo needs a value}" ;;
        --pr)      shift; PR_FILTER="${1:?--pr needs a value}" ;;
        -h|--help) grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; exit 1 ;;
    esac
    shift
done

MAX_USD="$(pr_review_max_usd "$SESSION_LIMITS_FILE")"
RUBRIC="$(cat "$REPO_ROOT/documentation/PR_REVIEW_RUBRIC.md" 2>/dev/null | sed -n '/^## Rubric/,/^## Output contract/p')"
[ -n "$RUBRIC" ] || RUBRIC="(rubric file unavailable — reviewing against general engineering standards only)"

REVIEWED=0 SKIPPED=0 ABORTED=0 FAILED=0

review_one_repo() { # <abs-path>
    local path="$1" name nwo prs
    name="$(basename "$path")"
    [ -n "$REPO_FILTER" ] && [ "$name" != "$REPO_FILTER" ] && return 0
    pr_review_is_ignored "$name" "$IGNORE_FILE" && { log "  [$name] in schedule_ignore.txt — skip."; return 0; }
    # -e, not -d: a git WORKTREE's .git is a FILE (gitdir pointer), not a directory.
    [ -e "$path/.git" ] || return 0
    nwo="$(repo_nwo_for_path "$path")"
    [ -n "$nwo" ] || { log "  [$name] no GitHub remote resolvable — skip."; return 0; }

    prs="$(cd "$path" && gh_pr_list --state open --json number,headRefOid,title,url,additions,deletions,baseRefName 2>/dev/null)" || {
        log "  [$nwo] gh pr list failed/truncated — skip this repo this fire."; return 0
    }

    printf '%s' "$prs" | /usr/bin/python3 -c '
import sys, json
for pr in json.loads(sys.stdin.read() or "[]"):
    print(f"{pr[\"number\"]}\t{pr[\"headRefOid\"]}\t{pr.get(\"additions\",0)}\t{pr.get(\"deletions\",0)}")
' 2>/dev/null | while IFS=$'\t' read -r num sha additions deletions; do
        [ -n "$PR_FILTER" ] && [ "$PR_FILTER" != "$num" ] && continue
        review_one_pr "$path" "$nwo" "$num" "$sha" "$additions" "$deletions"
    done
}

review_one_pr() { # <path> <nwo> <number> <sha> <additions> <deletions>
    local path="$1" nwo="$2" num="$3" sha="$4" additions="$5" deletions="$6"
    local status_json prior_count

    status_json="$(gh api "repos/$nwo/commits/$sha/status" 2>/dev/null || echo '{}')"
    if [ "$(pr_review_has_status "$status_json" "$STATUS_CONTEXT")" = "yes" ]; then
        log "  [$nwo#$num] $sha already carries $STATUS_CONTEXT — skip (idempotent)."
        SKIPPED=$((SKIPPED+1)); return 0
    fi

    # Lifetime cap: count myai-review statuses already posted for THIS PR
    # (any SHA) via the review label's presence as a cheap proxy is unsafe
    # (force-pushes reset it) — instead count distinct commit statuses via
    # the PR's status-check history is not directly queryable, so we track
    # via a lightweight marker: number of `myai-review` comments already
    # posted (gh pr view --json comments), which is 1:1 with reviews run.
    prior_count="$(gh pr view "$num" -R "$nwo" --json comments \
        --jq '[.comments[] | select(.body | startswith("## myAI review"))] | length' 2>/dev/null || echo 0)"
    case "$prior_count" in ''|*[!0-9]*) prior_count=0 ;; esac
    if ! pr_review_within_lifetime_cap "$prior_count" "$MAX_REVIEWS_PER_PR"; then
        log "  [$nwo#$num] already reviewed $prior_count times (cap $MAX_REVIEWS_PER_PR) — skip."
        SKIPPED=$((SKIPPED+1)); return 0
    fi

    local diff filelist body est
    diff="$(gh pr diff "$num" -R "$nwo" 2>/dev/null || echo '')"
    filelist="$(gh pr diff "$num" -R "$nwo" --name-only 2>/dev/null || echo '')"
    body="$(pr_review_diff_body "$diff" "$filelist" "$additions" "$deletions" "$DIFF_CAP_BYTES")"
    est="$(pr_review_estimate_cost_usd "${#body}" "$REVIEW_MODEL")"

    if pr_review_over_cap "$est" "$MAX_USD"; then
        log "  [$nwo#$num] estimated \$$est > cap \$$MAX_USD — aborting this PR (cost guard)."
        ABORTED=$((ABORTED+1))
        $DRY_RUN || gh api -X POST "repos/$nwo/statuses/$sha" \
            -f state=error -f context="$STATUS_CONTEXT" \
            -f description="myAI review skipped: est \$$est exceeds pr_review.max_usd \$$MAX_USD" >/dev/null 2>&1 || true
        return 0
    fi

    log "  [$nwo#$num] reviewing (~\$$est est, model $REVIEW_MODEL)..."
    if $DRY_RUN; then
        log "  [$nwo#$num] DRY-RUN — would run headless review, post comment + status + label."
        REVIEWED=$((REVIEWED+1)); return 0
    fi

    local prompt raw verdict
    prompt="$(pr_review_build_prompt "$RUBRIC" "$body")"
    raw="$(run_claude_review "$prompt" "$REVIEW_MODEL")"
    verdict="$(pr_review_parse_verdict "$raw")"

    if pr_review_needs_escalation "$verdict"; then
        local esc_model esc_raw esc_verdict
        esc_model="$(pr_review_escalation_model)"
        log "  [$nwo#$num] P0 candidate found on $REVIEW_MODEL — re-checking on $esc_model..."
        esc_raw="$(run_claude_review "$prompt" "$esc_model")"
        esc_verdict="$(pr_review_parse_verdict "$esc_raw")"
        raw="$esc_raw"; verdict="$esc_verdict"
    fi

    local state_desc state desc
    state_desc="$(pr_review_status_for_verdict "$verdict")"
    state="${state_desc%%$'\t'*}"; desc="${state_desc#*$'\t'}"

    if [ -z "$raw" ]; then
        log "  [$nwo#$num] headless review produced no output — posting error status, not a comment."
        FAILED=$((FAILED+1))
        gh api -X POST "repos/$nwo/statuses/$sha" \
            -f state=error -f context="$STATUS_CONTEXT" -f description="myAI review: headless invocation produced no output" >/dev/null 2>&1 || true
        record_run "$nwo" "$num" "failed" "no-result" ""
        return 0
    fi

    printf '%s' "$raw" | gh pr comment "$num" -R "$nwo" --body-file - >/dev/null 2>&1 \
        || log "  [$nwo#$num] WARN: failed to post review comment"
    gh api -X POST "repos/$nwo/statuses/$sha" \
        -f state="$state" -f context="$STATUS_CONTEXT" -f description="$desc" >/dev/null 2>&1 \
        || log "  [$nwo#$num] WARN: failed to post commit status"
    gh pr edit "$num" -R "$nwo" --add-label "$REVIEW_LABEL" >/dev/null 2>&1 \
        || log "  [$nwo#$num] WARN: failed to add label $REVIEW_LABEL (may not exist in this repo yet)"

    log "  [$nwo#$num] done — $state ($desc)"
    REVIEWED=$((REVIEWED+1))
    record_run "$nwo" "$num" "done" "$state_desc" "$sha"
}

record_run() { # <nwo> <number> <status> <result-line> <sha>
    local nwo="$1" num="$2" status="$3" result="$4" sha="$5"
    mcp job_history_record "$(/usr/bin/python3 -c '
import json, sys
print(json.dumps({
    "repo": sys.argv[1], "taskId": f"pr-review-{sys.argv[1]}-{sys.argv[2]}",
    "status": sys.argv[3], "resultLine": sys.argv[4][:2000], "model": sys.argv[5],
}))' "$nwo" "$num" "$status" "$result" "$REVIEW_MODEL")" >/dev/null 2>&1 || true
}

log "starting fleet PR review sweep (cap \$$MAX_USD/PR, model $REVIEW_MODEL, escalation $ESCALATION_MODEL)"
if command -v repo_paths >/dev/null 2>&1; then
    while IFS= read -r p; do
        [ -n "$p" ] && [ -d "$p" ] && review_one_repo "$p"
    done < <(repo_paths)
else
    log "repo_paths.sh unavailable — reviewing only this checkout ($REPO_ROOT)."
    review_one_repo "$REPO_ROOT"
fi

log "done — reviewed:$REVIEWED skipped:$SKIPPED aborted(cost-cap):$ABORTED failed:$FAILED $($DRY_RUN && echo '(dry-run)')"
exit 0
