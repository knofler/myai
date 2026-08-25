#!/usr/bin/env bash
# tenant_fairshare.sh — sourceable helper: weighted round-robin ordering across
# tenants for the off-hours runner's multi-tenant sweep (RUNNER fair-share,
# task-63c727c1, ADR-011 M4 follow-on).
#
# Problem: cli_task_runner.sh's claim_resolvable_task() (and the stale-working
# watchdog) always walk the served-tenant candidate list in the FIXED order
# tenant_keys.sh's tk_each() emits — i.e. line order in tenant-keys.env, the
# same every single fire. Since a fire claims exactly one task and stops at the
# first tenant with anything claimable, whichever tenant is listed first wins
# the claim on EVERY fire for as long as it has any pending task — a deep
# backlog on tenant #1 permanently head-of-line-blocks every other tenant
# sharing this free off-hours window. (Distinct from priority PREEMPTION in
# tasks/preemption.ts, which operates WITHIN one tenant's queue — this is
# fairness ACROSS tenants.)
#
# Fix: reorder the candidate list each fire using Smooth Weighted Round-Robin
# (SWRR — the same algorithm nginx uses for weighted upstream selection):
# every served tenant accrues `current += effectiveWeight` each fire; the
# tenant with the highest `current` goes first this fire and has
# `sum(effectiveWeight)` subtracted back off; state persists across fires
# (each fire is a fresh process) in a small local JSON file. Over many fires
# this converges to giving each tenant a share of first-picks proportional to
# its weight, and a tenant that is skipped keeps accruing `current` every
# fire it loses — bounding the worst-case wait, so no tenant is ever
# permanently starved regardless of weight.
#
#   effectiveWeight(tenant) = tierWeight(tenant) + min(pendingCount(tenant), PENDING_WEIGHT_CAP)
#
#   tierWeight  — config/tenant_guardrails.conf `tier=free|solo|team|scale`
#                 field (mirrors ITenant.plan, ADR-010 §2.2): free=1, solo=2,
#                 team=3, scale=5. Absent tenant / absent field / unrecognized
#                 value = free = 1 (backwards compatible: an all-untiered
#                 fleet gets a plain equal-weight round robin instead of
#                 today's fixed-order monopoly).
#   pendingCount — caller-supplied live queue depth (optional). Omitted or
#                 unknown for a tenant = 0, which still fixes the pure
#                 starvation bug with zero extra signal required. Capped
#                 (PENDING_WEIGHT_CAP, default 3) so one tenant's huge backlog
#                 can only nudge the rotation, never dominate it outright —
#                 that would just reintroduce the same monopoly the tier
#                 weight is trying to bound.
#
# bash 3.2-safe (no associative arrays, no mapfile) — the actual SWRR math and
# state persistence run in python3 (already a hard dependency of this runner;
# see task_fields_from_json etc.) for correctness/testability; this file is a
# thin, well-documented stdin/stdout shim around it. Functions print to
# stdout; the only side effect is the state file write in
# tfs_order_candidates. Safe to source repeatedly.
#
# State is per-machine (same convention as the runner's other local ledgers —
# pacing session counts, budget files): each Mac rotates its own served-tenant
# set independently. Fine for the current model where each machine's runner
# process picks ONE task per fire from candidates it alone is iterating.

# tfs_resolve_state_file — $TENANT_FAIRSHARE_STATE_FILE wins; else the
# per-machine default next to the other runner ledgers.
tfs_resolve_state_file() {
    printf '%s' "${TENANT_FAIRSHARE_STATE_FILE:-$HOME/.ai-cli-runner/tenant_fairshare_state.json}"
}

# tfs_tier_weight <tenantId> [guardrails_file] — resolved fair-share weight for
# a tenant's configured `tier` field. Always prints a positive integer;
# never fails (an absent guardrails lib/file/tenant/field all resolve to the
# free-tier default of 1, same "no line = normal default behaviour" backwards-
# compatibility convention as tg_max_minutes).
tfs_tier_weight() {
    local t
    t="$(tg_lookup_field "$1" tier "${2:-}" 2>/dev/null)" || t=""
    case "$t" in
        scale) printf '5' ;;
        team)  printf '3' ;;
        solo)  printf '2' ;;
        *)     printf '1' ;;   # free / absent tenant / absent field / unrecognized value
    esac
}

# tfs_order_candidates [pending_tsv] — reads "id<TAB>key" candidate lines
# (tenant_keys.sh's tk_each()/CANDIDATES format) on stdin, reorders them by
# weighted round-robin, and prints "id<TAB>key" lines in the new order on
# stdout — a drop-in replacement for the input, so callers need no shape
# changes. $1, if given, is "id<TAB>pendingCount" lines (a tenant absent from
# it, or the arg omitted entirely, is pendingCount=0 — a safe no-op default,
# never an error). 0 or 1 candidate passes through unchanged and never touches
# the state file — the default single-tenant/loopback path stays a total
# no-op, exactly as before this change.
tfs_order_candidates() {
    local pending_src="${1:-}" guardrails_file="${TENANT_GUARDRAILS_FILE:-}"
    local cand_tab
    cand_tab="$(cat)"
    local n
    n=$(printf '%s\n' "$cand_tab" | grep -c . || true)
    if [ "${n:-0}" -le 1 ]; then printf '%s\n' "$cand_tab"; return 0; fi

    local TAB id key w pend rows=""
    TAB="$(printf '\t')"
    while IFS="$TAB" read -r id key; do
        [ -z "$id" ] && [ -z "$key" ] && continue
        w="$(tfs_tier_weight "$id" "$guardrails_file")"
        pend="0"
        if [ -n "$pending_src" ]; then
            pend="$(printf '%s\n' "$pending_src" | awk -F'\t' -v i="$id" '$1==i{print $2; exit}')"
            case "$pend" in ''|*[!0-9]*) pend="0" ;; esac
        fi
        rows="${rows}${id}${TAB}${key}${TAB}${w}${TAB}${pend}
"
    done <<EOF
$cand_tab
EOF

    STATE_FILE="$(tfs_resolve_state_file)" PENDING_CAP="${PENDING_WEIGHT_CAP:-3}" \
        /usr/bin/python3 -c '
import sys, os, json, tempfile

state_file = os.environ["STATE_FILE"]
try:
    cap = int(os.environ.get("PENDING_CAP", "3") or "3")
except Exception:
    cap = 3

rows = []
for line in sys.stdin.read().splitlines():
    if not line:
        continue
    parts = line.split("\t")
    while len(parts) < 4:
        parts.append("")
    tid, key, w, pend = parts[0], parts[1], parts[2], parts[3]
    try:
        w = int(w)
    except Exception:
        w = 1
    try:
        pend = int(pend)
    except Exception:
        pend = 0
    eff = max(1, w) + min(max(0, pend), cap)
    rows.append({"id": tid, "key": key, "weight": eff})

if not rows:
    sys.exit(0)

try:
    with open(state_file) as f:
        state = json.load(f)
    if not isinstance(state, dict):
        state = {}
except Exception:
    state = {}

# Smooth Weighted Round-Robin (nginx algorithm): bump every served tenant\x27s
# `current` by its effective weight, pick the max (ties broken by original
# candidate order — rows[] is already in that order, and max() keeps the
# first maximal element), subtract the total weight back off the winner.
# This is one fire\x27s worth of bookkeeping; repeated fires converge to a
# schedule proportional to weight, and a tenant that loses still accrues
# `current` every fire it is skipped, bounding its worst-case wait.
total = 0
for r in rows:
    cur = state.get(r["id"], 0) + r["weight"]
    state[r["id"]] = cur
    r["current"] = cur
    total += r["weight"]

winner = max(rows, key=lambda r: r["current"])
state[winner["id"]] = winner["current"] - total

# Prune tenants no longer in the served set so the state file cannot grow
# unbounded as the tenant roster churns.
state = {k: v for k, v in state.items() if any(r["id"] == k for r in rows)}

try:
    d = os.path.dirname(state_file)
    if d:
        os.makedirs(d, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=(d or "."), prefix=".tfs-")
    with os.fdopen(fd, "w") as f:
        json.dump(state, f)
    os.replace(tmp, state_file)
except Exception:
    pass   # best-effort persistence; a failed write just resets rotation next fire

ordered = sorted(rows, key=lambda r: (r["id"] != winner["id"], -r["current"]))
for r in ordered:
    print("%s\t%s" % (r["id"], r["key"]))
' <<EOF
$rows
EOF
}
