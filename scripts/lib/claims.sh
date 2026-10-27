#!/usr/bin/env bash
# claims.sh — resource CLAIMS before work (plan/SWARM_COORDINATOR_PLAN.md row 5,
# spec §5b "Claims before work"). An agent claims a file or directory before
# touching it, so two sessions never silently edit the same thing.
#
# A claim is a gateway KEYED lease (scripts/lib/keyed_lease.sh):
#   key    claim:<repo-id>:<relpath>   relpath relative to the repo root;
#                                      directories end with "/" and cover
#                                      everything under them
#   holder <host>/<lane>/<session-pid> (same identity as swarm master)
#   TTL    CLAIM_TTL (default 1800s), renewed by `swarm_master.sh tick`
# This session's claims are recorded in
#   ~/.myai/swarm/claims.<host>.<lane>.<pid>.tsv  (key, epoch, relpath, repo, note)
# Claims are ADVISORY: nothing stops an agent that never claims. Conflicts are
# negotiated by mail (holder's lane + the coordinator), never by force.
#
# Used by scripts/claim.sh (the CLI), scripts/swarm_master.sh (renewal),
# hooks/pre-tool/04-protected-files.sh (warn-only check), check_session.sh and
# hooks/session/33-mailbox-inbox.sh (visibility). Sourced, never executed.
# bash 3.2-safe; safe under `set -euo pipefail`. Tests stub kl_call (or set
# MYAI_LEASE_STUB), _lanes_self_pid and _cl_tell.

CL_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
if ! command -v session_profile >/dev/null 2>&1; then
  # shellcheck source=/dev/null
  . "$CL_HERE/session_registry.sh"
fi
if ! command -v _lanes_self_pid >/dev/null 2>&1; then
  # shellcheck source=/dev/null
  . "$CL_HERE/session_lanes.sh"
fi
if ! command -v kl_call >/dev/null 2>&1; then
  # shellcheck source=/dev/null
  . "$CL_HERE/keyed_lease.sh"
fi
if ! command -v canonical_repo_id >/dev/null 2>&1; then
  # shellcheck source=/dev/null
  . "$CL_HERE/repo_id.sh"
fi

CLAIM_TTL="${CLAIM_TTL:-1800}"

cl_pid()    { _lanes_self_pid; }
cl_holder() { local p; p="$(cl_pid)"; [ -n "$p" ] || return 1; printf '%s/%s/%s' "$(kl_host)" "$(session_profile)" "$p"; }
cl_tsv()    { printf '%s/claims.%s.%s.%s.tsv' "$(kl_swarm_dir)" "$(kl_host)" "$(session_profile)" "$(cl_pid)"; }
_cl_now()   { date +%s; }
# _cl_tell <lane> <message> — durable mail (kind blocker) + live ping. Stubbed in tests.
_cl_tell() { TELL_KIND=blocker bash "$CL_HERE/../tell.sh" "$1" "$2" >/dev/null 2>&1 || true; }

# cl_resolve <path> → sets CL_REPO_ID CL_REL (as given) CL_KEYREL (as keyed) CL_TOP. rc 1 = not inside a git
# repo; rc 2 = not claimable (the repo root itself, whitespace, too long).
# The repo id is the MAIN checkout's canonical id, so a claim taken in a lane
# worktree and one taken in the Dropbox checkout collide as they should.
cl_resolve() {
  local out common
  out="$(/usr/bin/python3 - "$1" <<'PY' 2>/dev/null
import os, sys
p = sys.argv[1]
is_dir = p.endswith("/")
a = os.path.abspath(p)
if os.path.isdir(a):
    is_dir = True
e, rest = a, []
while not os.path.exists(e) and e != "/":
    e, tail = os.path.split(e)
    rest.insert(0, tail)
real = os.path.join(os.path.realpath(e), *rest) if rest else os.path.realpath(e)
d = real if os.path.isdir(real) else os.path.dirname(real)
while not os.path.isdir(d):
    d = os.path.dirname(d)
print("%s\t%s" % (d, real + ("/" if is_dir else "")))
PY
)" || return 1
  [ -n "$out" ] || return 1
  local dir real
  IFS="$(printf '\t')" read -r dir real <<EOF
$out
EOF
  CL_TOP="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null)" || return 1
  CL_TOP="$(cd "$CL_TOP" && pwd -P)"
  common="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || return 1
  CL_REPO_ID="$(canonical_repo_id "$(cd "$common/.." && pwd -P)" | tr '[:upper:]' '[:lower:]')"
  case "$real" in
    "$CL_TOP"/*) CL_REL="${real#"$CL_TOP"/}" ;;
    *) return 1 ;;
  esac
  case "$CL_REL" in ''|/) return 2 ;; esac
  case "$CL_REL" in *[[:space:]]*) return 2 ;; esac
  [ "${#CL_REL}" -le 160 ] || return 2
  # The KEY is case-folded on a case-insensitive filesystem (macOS), so
  # Foo.ts and foo.ts — the same file there — collide; CL_REL keeps the path
  # as given for display. CLAIM_CASEFOLD=1|0 overrides the Darwin default.
  CL_KEYREL="$CL_REL"
  if [ "$(cl_casefold)" = 1 ]; then CL_KEYREL="$(printf '%s' "$CL_REL" | tr '[:upper:]' '[:lower:]')"; fi
  return 0
}

cl_key() { printf 'claim:%s:%s' "$1" "$2"; }
cl_casefold() {
  if [ -n "${CLAIM_CASEFOLD:-}" ]; then printf '%s' "$CLAIM_CASEFOLD"; return 0; fi
  if [ "$(uname -s 2>/dev/null)" = Darwin ]; then printf 1; else printf 0; fi
}

# cl_overlap <a> <b> → 0 when the two relpaths collide: equal, or one is a
# directory claim ("…/") containing the other.
cl_overlap() {
  [ "$1" = "$2" ] && return 0
  case "$1" in */) case "$2" in "$1"*) return 0 ;; esac ;; esac
  case "$2" in */) case "$1" in "$2"*) return 0 ;; esac ;; esac
  return 1
}

# cl_conflicts <repo-id> <relpath> [me] → "relpath<TAB>holder<TAB>age<TAB>note"
# for every VALID claim by another holder that overlaps. rc 1 = gateway down.
cl_conflicts() {
  local repo="$1" rel="$2" me="${3:-}" rows key holder epoch stale age note r
  rows="$(kl_list "claim:$repo:")" || return 1
  while IFS="$(printf '\t')" read -r key holder epoch stale age note; do
    [ -n "$key" ] || continue
    [ "$stale" = false ] || continue
    [ "$holder" != "$me" ] || continue
    r="${key#claim:"$repo":}"
    if cl_overlap "$r" "$rel"; then printf '%s\t%s\t%s\t%s\n' "$r" "$holder" "$age" "$note"; fi
  done <<EOF
$rows
EOF
  return 0
}

# _cl_mail_conflict <relpath> <holder> <note> — ONE mail per path per hour to
# the holder's lane + the coordinator's lane.
_cl_mail_conflict() {
  local rel="$1" holder="$2" note="$3" dedup now last lanes l hl cl msg
  dedup="$(kl_swarm_dir)/claim-mail.dedup"
  mkdir -p "$(kl_swarm_dir)" 2>/dev/null || true
  now="$(_cl_now)"
  last="$(awk -F'\t' -v k="$CL_REPO_ID:${CL_KEYREL:-$rel}" '$1==k {v=$2} END {print v}' "$dedup" 2>/dev/null || true)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  if [ $((now - last)) -lt 3600 ]; then return 0; fi
  printf '%s\t%s\n' "$CL_REPO_ID:${CL_KEYREL:-$rel}" "$now" >> "$dedup"
  hl="$(kl_holder_lane "$holder")"
  cl="$(kl_coordinator_lane)"
  lanes="$hl"
  if [ "$cl" != "$hl" ]; then lanes="$lanes $cl"; fi
  msg="$(session_profile) wants $rel ($CL_REPO_ID) held by $holder${note:+ ($note)}: propose split / sequence / handover"
  for l in $lanes; do _cl_tell "$l" "$msg"; done
  return 0
}

_cl_tsv_drop() { # <key>
  local f; f="$(cl_tsv)"
  [ -f "$f" ] || return 0
  awk -F'\t' -v k="$1" '$1!=k' "$f" > "$f.tmp.$$" 2>/dev/null && mv "$f.tmp.$$" "$f"
}

cl_take() { # <path> [note]
  local path="$1" note="${2:-}" me rc conf key res meta first
  me="$(cl_holder)" || { echo "claim: not inside a claude/agy session (no session pid) — set LANES_SELF_PID or run it from the session" >&2; return 2; }
  cl_resolve "$path"; rc=$?
  if [ "$rc" = 1 ]; then echo "claim: $path is not inside a git repo" >&2; return 2; fi
  if [ "$rc" = 2 ]; then echo "claim: $path can't be claimed (repo root, whitespace or >160 chars)" >&2; return 2; fi
  conf="$(cl_conflicts "$CL_REPO_ID" "$CL_KEYREL" "$me")" || { echo "claim: gateway unreachable — not claimed" >&2; return 3; }
  if [ -n "$conf" ]; then
    first="$(printf '%s\n' "$conf" | head -1)"
    echo "claim: REFUSED — $CL_REL overlaps a claim held by another session:" >&2
    printf '%s\n' "$conf" | awk -F'\t' '{printf "  %s  held by %s  (%ss ago)%s\n", $1, $2, $3, ($4 != "" ? "  — " $4 : "")}' >&2
    echo "  the holder and the coordinator have been mailed (once per hour per path): propose split / sequence / handover" >&2
    _cl_mail_conflict "$CL_REL" "$(printf '%s' "$first" | cut -f2)" "$(printf '%s' "$first" | cut -f4)"
    return 1
  fi
  key="$(cl_key "$CL_REPO_ID" "$CL_KEYREL")"
  meta="$(kl_strs "lane=$(session_profile)" "pid=$(cl_pid)" "host=$(kl_host)" "note=$note" "path=$CL_REL")"
  res="$(kl_call lease_acquire "$(kl_args "key=$key" "holder=$me" "leaseSeconds=$CLAIM_TTL" "meta=$meta")")" || { echo "claim: gateway unreachable — not claimed" >&2; return 3; }
  if [ "$(kl_json "$res" acquired)" != true ]; then
    echo "claim: REFUSED — $CL_REL held by $(kl_json "$res" heldBy.holder)$(kl_json "$res" error)" >&2
    _cl_mail_conflict "$CL_REL" "$(kl_json "$res" heldBy.holder)" ""
    return 1
  fi
  mkdir -p "$(kl_swarm_dir)" 2>/dev/null || true
  _cl_tsv_drop "$key"
  printf '%s\t%s\t%s\t%s\t%s\n' "$key" "$(kl_json "$res" lease.epoch)" "$CL_REL" "$CL_REPO_ID" "$(printf '%s' "$note" | tr '\t\n' '  ')" >> "$(cl_tsv)"
  echo "claim: $CL_REL ($CL_REPO_ID) claimed by $me for $((CLAIM_TTL / 60)) min — renewed while this session's tick runs; release with: claim release $path"
  return 0
}

cl_release() { # <path> [--force]
  local path="$1" force="${2:-}" me rc key line epoch rows holder stale res
  me="$(cl_holder 2>/dev/null || true)"
  cl_resolve "$path"; rc=$?
  if [ "$rc" != 0 ]; then echo "claim: $path is not a claimable path in a git repo" >&2; return 2; fi
  key="$(cl_key "$CL_REPO_ID" "$CL_KEYREL")"
  line="$(awk -F'\t' -v k="$key" '$1==k' "$(cl_tsv)" 2>/dev/null | tail -1)"
  if [ -n "$line" ] && [ -n "$me" ]; then
    epoch="$(printf '%s' "$line" | cut -f2)"
    res="$(kl_call lease_release "$(kl_args "key=$key" "holder=$me" "epoch=$epoch")")" || { echo "claim: gateway unreachable — not released (expires in ≤$((CLAIM_TTL / 60)) min)" >&2; return 3; }
    _cl_tsv_drop "$key"
    if [ "$(kl_json "$res" released)" = true ]; then echo "claim: released $CL_REL"; else echo "claim: $CL_REL was no longer held by this session ($(kl_json "$res" reason))"; fi
    return 0
  fi
  rows="$(kl_list "$key")" || { echo "claim: gateway unreachable" >&2; return 3; }
  line="$(printf '%s\n' "$rows" | awk -F'\t' -v k="$key" '$1==k' | head -1)"
  if [ -z "$line" ]; then echo "claim: $CL_REL is not claimed"; return 0; fi
  holder="$(printf '%s' "$line" | cut -f2)"; epoch="$(printf '%s' "$line" | cut -f3)"; stale="$(printf '%s' "$line" | cut -f4)"
  if [ "$force" != --force ]; then
    echo "claim: refusing — $CL_REL is held by $holder${stale:+ (stale=$stale)}, not this session (${me:-no session}). The coordinator can override: claim release $path --force" >&2
    return 1
  fi
  res="$(kl_call lease_release "$(kl_args "key=$key" "holder=${me:-$(kl_host)/operator/0}" "force=true" "epoch=$epoch")")" || { echo "claim: gateway unreachable" >&2; return 3; }
  if [ "$(kl_json "$res" released)" = true ]; then
    echo "claim: force-released $CL_REL (was $holder)"
    return 0
  fi
  echo "claim: force release failed: $(kl_json "$res" reason)$(kl_json "$res" error)" >&2
  return 1
}

cl_check() { # <path> → 0 free (or ours), 1 held by another session, 2 not claimable, 3 gateway down
  local path="$1" me rc conf
  me="$(cl_holder 2>/dev/null || true)"
  cl_resolve "$path"; rc=$?
  if [ "$rc" != 0 ]; then return 2; fi
  conf="$(cl_conflicts "$CL_REPO_ID" "$CL_KEYREL" "$me")" || return 3
  [ -n "$conf" ] || return 0
  printf '%s\n' "$conf" | awk -F'\t' '{printf "%s held by %s (%ss ago)%s\n", $1, $2, $3, ($4 != "" ? " — " $4 : "")}'
  return 1
}

# cl_list_repo <repo-id|""> → "relpath  holder  age  note" for valid claims
# (all repos when empty). rc 1 = gateway down.
cl_list_repo() {
  local prefix="claim:" rows me
  [ -n "${1:-}" ] && prefix="claim:$1:"
  me="$(cl_holder 2>/dev/null || true)"
  rows="$(kl_list "$prefix")" || return 1
  printf '%s\n' "$rows" | awk -F'\t' -v me="$me" 'NF>=4 && $4=="false" {
    k=$1; sub(/^claim:/, "", k)
    printf "  %-48s %s%s  %ss ago%s\n", k, $2, ($2==me ? " (this session)" : ""), $5, ($6 != "" ? "  — " $6 : "") }'
}

# cl_holder_claims <holder> → relpaths (repo:relpath) of VALID claims held by
# <holder>, space-separated. Empty on none / gateway down.
cl_holder_claims() {
  local rows
  rows="$(kl_list "claim:" 2>/dev/null)" || return 0
  printf '%s\n' "$rows" | awk -F'\t' -v h="$1" '$2==h && $4=="false" {k=$1; sub(/^claim:/, "", k); printf "%s%s", (n++ ? ", " : ""), k} END {if (n) print ""}'
}

# cl_renew — heartbeat every claim this session holds; drop lost ones (one
# line each). Called by swarm_master.sh tick. Silent otherwise.
cl_renew() {
  local f me key epoch rel repo note res
  f="$(cl_tsv)"
  [ -s "$f" ] || return 0
  me="$(cl_holder)" || return 0
  while IFS="$(printf '\t')" read -r key epoch rel repo note; do
    [ -n "$key" ] || continue
    res="$(kl_call lease_heartbeat "$(kl_args "key=$key" "holder=$me" "epoch=$epoch" "leaseSeconds=$CLAIM_TTL")")" || continue
    if [ "$(kl_json "$res" ok)" = false ]; then
      _cl_tsv_drop "$key"
      res="$(kl_json "$res" heldBy.holder)"
      echo "claim: lost claim on $rel ($repo) — ${res:+now held by $res}${res:-released by someone else}"
    fi
  done < "$f"
  return 0
}
