#!/usr/bin/env bash
# shellcheck disable=SC2088  # "~/…" strings are display labels, never paths to expand
# config_journal.sh — the CHANGE JOURNAL (plan/SWARM_COORDINATOR_PLAN.md row 6,
# spec §5b): every change to operator config OUTSIDE git reaches the brain and
# the coordinator. Incident 2026-10-03: agy rewrote ~/.zshrc and the RC daemon
# plist; nothing reached git, the brain or a handoff, and the master suspected the
# wrong agent.
#
# Usage:
#   config_journal.sh scan            compare the watch list against the state;
#                                     a changed/new/removed file with no `note`
#                                     in the last 15 min is UNANNOUNCED → brain
#                                     atom attributed to the sessions live right
#                                     now, then (only once the atom is written)
#                                     one line + ONE coordinator mail per file per
#                                     day. Brain down → nothing printed or mailed;
#                                     the change is kept as a PENDING report and
#                                     retried at most once an hour. The first run
#                                     only seeds the baseline.
#   config_journal.sh scan-bg         session-start form (hooks/session/33): skip
#                                     when the last scan was < 5 min ago, else run
#                                     `scan` detached (nohup, output to
#                                     <host>.bg.log) — adds nothing to start time.
#   config_journal.sh note <file> "<why>"
#                                     announce a change you made: record the new
#                                     hash, brain atom (who, file, before→after,
#                                     why), ONE mail to the coordinator (or
#                                     the master's <host>/<lane> when no swarm is active).
#                                     <file> may also be "~/.docker/mcp profiles"
#                                     (or ~/.docker/mcp) — fingerprinted from
#                                     `docker mcp profile list/show` — or any
#                                     directory (hash of its top-level files).
#   config_journal.sh status          watched files, last scan, recent notes and
#                                     unannounced changes.
#
# Watch list (operator-approved, READ-ONLY — checksums only; nothing is ever
# written under ~/.gemini or any watched path):
#   ~/.zshrc  ~/.claude-*/settings*.json  ~/.gemini/config/*.json
#   ~/.gemini/antigravity-cli/settings.json  ~/Library/LaunchAgents/com.myai.*
#   ~/Library/LaunchAgents/com.google.antigravity-cli-daemon.plist
# ONLY config that lives OUTSIDE git. Repo files (hooks/, .claude/settings.json)
# are deliberately NOT watched (PR #488 review): git already tracks them, every
# checkout has its own copy (a per-host state would flag them on every switch
# between repos), and a `git pull` would read as an "unannounced" change.
# State: ~/.myai/config-journal/<host>.tsv (path, sha256, mtime, last-seen),
# plus <host>.pending.tsv (reports whose brain write failed), <host>.notes.tsv,
# <host>.log, <host>.lastscan and <host>.mail.dedup. A file whose mtime is
# unchanged is not re-hashed (fast path), so a content edit that preserves the
# mtime is not seen.
#
# Run by hooks/session/33-mailbox-inbox.sh at session start (scan-bg) and by
# every ~10th `swarm_master.sh tick`. Env: CJ_HOME (default $HOME),
# CONFIG_JOURNAL_DIR. Brain + mail go through the stubbable helpers
# _cj_brain / _cj_tell (gateway via scripts/lib/keyed_lease.sh kl_call).
# bash 3.2-safe; safe under `set -euo pipefail`. CONFIG_JOURNAL_LIB_ONLY=1 to source.
set -u

CJ_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
# shellcheck source=/dev/null
. "$CJ_HERE/lib/session_registry.sh"
# shellcheck source=/dev/null
. "$CJ_HERE/lib/session_lanes.sh"
# shellcheck source=/dev/null
. "$CJ_HERE/lib/keyed_lease.sh"

CJ_HOME="${CJ_HOME:-$HOME}"
CJ_DIR="${CONFIG_JOURNAL_DIR:-$HOME/.myai/config-journal}"
CJ_NOTE_WINDOW="${CJ_NOTE_WINDOW:-900}"
CJ_RETRY_EVERY="${CJ_RETRY_EVERY:-3600}"
CJ_BG_MIN_GAP="${CJ_BG_MIN_GAP:-300}"

cj_host()  { kl_host; }
cj_state() { printf '%s/%s.tsv' "$CJ_DIR" "$(cj_host)"; }
cj_notes() { printf '%s/%s.notes.tsv' "$CJ_DIR" "$(cj_host)"; }
cj_log()   { printf '%s/%s.log' "$CJ_DIR" "$(cj_host)"; }
cj_pending() { printf '%s/%s.pending.tsv' "$CJ_DIR" "$(cj_host)"; }
cj_stamp() { printf '%s/%s.lastscan' "$CJ_DIR" "$(cj_host)"; }
cj_who()   { local p; p="$(_lanes_self_pid)"; printf '%s/%s/%s' "$(cj_host)" "$(session_profile)" "${p:-no-session}"; }
_cj_now()  { date +%s; }
# _cj_short <hash|label> → first 12 chars of a sha256, labels ("none …") whole.
_cj_short() { case "$1" in [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]*) printf '%s' "${1:0:12}" ;; *) printf '%s' "$1" ;; esac; }
# _cj_slug <path> → a brain-slug-safe basename.
_cj_slug() { printf '%s' "$(basename "$1")" | tr -c 'A-Za-z0-9_-' '-'; }
_cj_today() { date +%Y-%m-%d; }

# _cj_brain <slug> <content> — brain_commit (kind memory, topic security). rc 1 on failure.
_cj_brain() {
  local res
  res="$(kl_call brain_commit "$(kl_strs "kind=memory" "topic=security" "slug=$1" "content=$2")")" || return 1
  [ -z "$(kl_json "$res" error)" ]
}
# _cj_tell <lane> <kind> <message> — durable mail, no live ping (journal noise
# must never type into a session).
_cj_tell() { TELL_NO_PING=1 TELL_KIND="$2" bash "$CJ_HERE/tell.sh" "$1" "$3" >/dev/null 2>&1 || true; }

# _cj_sha <file…> → "sha<TAB>path" per file (shasum -a 256, sha256sum fallback).
_cj_sha() {
  [ $# -gt 0 ] || return 0
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -- "$@" 2>/dev/null | awk '{h=$1; sub(/^[0-9a-f]+  \*?/, ""); printf "%s\t%s\n", h, $0}'
  else
    sha256sum -- "$@" 2>/dev/null | awk '{h=$1; sub(/^[0-9a-f]+  \*?/, ""); printf "%s\t%s\n", h, $0}'
  fi
}

# _cj_sha_stdin → sha256 of stdin (hex only).
_cj_sha_stdin() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -c1-64; else sha256sum | cut -c1-64; fi
}

# ── Non-file `note` targets ────────────────────────────────────────────────
# `note` used to hash only regular files, so a target that is not one — the
# Docker MCP profiles (rows inside ~/.docker/mcp/mcp-toolkit.db, noted as
# "~/.docker/mcp profiles") or any directory — journaled "none → none
# (removed)" on every change (2026-10-21, Docker MCP phase 0/2 notes). Each
# kind now gets a real fingerprint. Their history lives in <host>.targets.tsv,
# NOT the scan state: the scan diffs the state against the watch list, so a
# key outside it would read as "removed" on the next scan.
CJ_DOCKER_PROFILES_KEY_SUFFIX=".docker/mcp profiles"

_cj_targets() { printf '%s/%s.targets.tsv' "$CJ_DIR" "$(cj_host)"; }
_cj_docker() { "${CJ_DOCKER:-docker}" "$@"; }

# _cj_target_kind <abs> → docker-profiles | file | dir | missing
_cj_target_kind() {
  case "$1" in
    "$CJ_HOME/$CJ_DOCKER_PROFILES_KEY_SUFFIX"|"$CJ_HOME/.docker/mcp"|"$CJ_HOME/.docker/mcp/") echo docker-profiles; return ;;
  esac
  if [ -f "$1" ]; then echo file; elif [ -d "$1" ]; then echo dir; else echo missing; fi
}

# _cj_docker_profiles_fp → "sha<TAB>summary" over `docker mcp profile list` plus
# `profile show` of every profile (so adding a server to a profile moves the
# hash, not only adding a profile). rc 1 when docker mcp is unreachable.
_cj_docker_profiles_fp() {
  local list ids id body n
  list="$(_cj_docker mcp profile list 2>/dev/null)" || return 1
  ids="$(printf '%s\n' "$list" | awk '$1!="ID" && $1!~/^-+$/ && NF {print $1}')"
  body="$list"
  for id in $ids; do
    body="$body
## $id
$(_cj_docker mcp profile show "$id" 2>/dev/null || echo "(show failed)")"
  done
  n="$(printf '%s\n' "$ids" | grep -c . || true)"
  printf '%s\t%s profile(s): %s\n' "$(printf '%s' "$body" | _cj_sha_stdin)" "$n" "$(printf '%s' "$ids" | tr '\n' ' ' | sed 's/ *$//; s/ /, /g')"
}

# _cj_dir_fp <dir> → sha over the "sha<TAB>name" lines of its top-level files.
_cj_dir_fp() {
  local f
  for f in "$1"/* "$1"/.[!.]*; do
    if [ -f "$f" ]; then _cj_sha "$f" | awk -F'\t' '{n=$2; sub(/.*\//, "", n); printf "%s\t%s\n", $1, n}'; fi
  done | LC_ALL=C sort | _cj_sha_stdin
}

# _cj_mtime <file> → epoch mtime (GNU stat first, BSD fallback).
_cj_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# cj_watch_list → every existing watched file, one absolute path per line.
cj_watch_list() {
  local f
  for f in "$CJ_HOME/.zshrc" "$CJ_HOME"/.claude-*/settings*.json "$CJ_HOME"/.gemini/config/*.json \
           "$CJ_HOME/.gemini/antigravity-cli/settings.json" "$CJ_HOME"/Library/LaunchAgents/com.myai.* \
           "$CJ_HOME/Library/LaunchAgents/com.google.antigravity-cli-daemon.plist"; do
    if [ -f "$f" ]; then printf '%s\n' "$f"; fi
  done
  return 0
}

# _cj_lock / _cj_unlock — one scan at a time per host (mkdir lock, taken over
# when older than 120s).
_cj_lock() {
  local l ts
  l="$CJ_DIR/$(cj_host).lock"
  mkdir -p "$CJ_DIR" 2>/dev/null || return 1
  if mkdir "$l" 2>/dev/null; then _cj_now > "$l/ts"; return 0; fi
  ts="$(cat "$l/ts" 2>/dev/null || echo 0)"
  case "$ts" in ''|*[!0-9]*) ts=0 ;; esac
  if [ $(($(_cj_now) - ts)) -gt 120 ]; then
    rm -rf "$l" 2>/dev/null || true
    if mkdir "$l" 2>/dev/null; then _cj_now > "$l/ts"; return 0; fi
  fi
  return 1
}
_cj_unlock() { rm -rf "$CJ_DIR/$(cj_host).lock" 2>/dev/null || true; }

# _cj_announced <path> <now> → 0 when a note for <path> exists within the window.
_cj_announced() {
  awk -F'\t' -v p="$1" -v now="$2" -v w="$CJ_NOTE_WINDOW" '$1==p && now-$3<=w {f=1} END {exit f?0:1}' "$(cj_notes)" 2>/dev/null
}

# _cj_live_sessions → "lane/pid, …" for every live session right now.
_cj_live_sessions() {
  local s
  s="$(lanes_candidates '*' 2>/dev/null | awk -F'\t' '{printf "%s%s/%s", (n++ ? ", " : ""), $5, $1}' || true)"
  printf '%s' "${s:-none detected}"
}

_cj_coordinator_lane() { kl_coordinator_lane; }

# _cj_mail_once <path> <message> — ONE coordinator mail per file per day.
_cj_mail_once() {
  local dedup day
  dedup="$CJ_DIR/$(cj_host).mail.dedup"
  day="$(_cj_today)"
  if awk -F'\t' -v p="$1" -v d="$day" '$1==p && $2==d {f=1} END {exit f?0:1}' "$dedup" 2>/dev/null; then return 0; fi
  printf '%s\t%s\n' "$1" "$day" >> "$dedup"
  _cj_tell "$(_cj_coordinator_lane)" blocker "$2"
}

# _cj_plan <state> <now> (stdin = watched paths) → one Python pass (no
# per-file processes): "KEEP<TAB>path<TAB>sha<TAB>mtime" when the mtime is
# unchanged since the last scan, else "HASH<TAB>path<TAB>mtime".
_cj_plan() {
  /usr/bin/python3 -c '
import os, sys
state = {}
try:
    for l in open(sys.argv[1]):
        f = l.rstrip("\n").split("\t")
        if len(f) >= 3:
            state[f[0]] = f
except Exception:
    pass
for p in sys.stdin.read().split("\n"):
    if not p:
        continue
    try:
        m = str(int(os.stat(p).st_mtime))
    except Exception:
        continue
    s = state.get(p)
    if s and s[2] == m:
        print("KEEP\t%s\t%s\t%s" % (p, s[1], m))
    else:
        print("HASH\t%s\t%s" % (p, m))
' "$1"
}

# _cj_diff <old-state> <new-state> → "path<TAB>before<TAB>after" for every
# changed, new (before "-") or removed (after "-") path. ("-", not empty: a tab
# is IFS whitespace, so `read` would collapse an empty middle field.)
_cj_diff() {
  /usr/bin/python3 -c '
import sys
def load(p):
    d = {}
    try:
        for l in open(p):
            f = l.rstrip("\n").split("\t")
            if len(f) >= 2:
                d[f[0]] = f[1]
    except Exception:
        pass
    return d
a, b = load(sys.argv[1]), load(sys.argv[2])
for p in sorted(set(a) | set(b)):
    if a.get(p) != b.get(p):
        print("%s\t%s\t%s" % (p, a.get(p, "-"), b.get(p, "-")))
' "$1" "$2"
}

cj_scan() {
  local state now tmp plan kind path sha mtime before after tohash
  state="$(cj_state)"
  _cj_lock || return 0
  now="$(_cj_now)"
  printf '%s\n' "$now" > "$(cj_stamp)" 2>/dev/null || true
  tmp="$CJ_DIR/$(cj_host).tsv.new.$$"
  : > "$tmp"
  plan="$(cj_watch_list | _cj_plan "$state" "$now")"
  # Fast path: re-hash only files whose mtime moved (or that are new).
  tohash=""
  while IFS="$(printf '\t')" read -r kind path sha mtime; do
    case "$kind" in
      KEEP) printf '%s\t%s\t%s\t%s\n' "$path" "$sha" "$mtime" "$now" >> "$tmp" ;;
      HASH) tohash="$tohash$path	$sha
" ;;
    esac
  done <<EOF
$plan
EOF
  if [ -n "$tohash" ]; then
    # HASH lines carry the mtime in the 3rd field ($sha above); hash in one call.
    # shellcheck disable=SC2046  # one path per line; watched paths contain no spaces by construction
    _cj_sha $(printf '%s' "$tohash" | cut -f1 | tr '\n' ' ') > "$tmp.sha" || true
    while IFS="$(printf '\t')" read -r sha path; do
      [ -n "$path" ] || continue
      mtime="$(printf '%s' "$tohash" | awk -F'\t' -v p="$path" '$1==p {print $2; exit}')"
      printf '%s\t%s\t%s\t%s\n' "$path" "$sha" "$mtime" "$now" >> "$tmp"
    done < "$tmp.sha"
    rm -f "$tmp.sha"
  fi
  if [ ! -s "$state" ]; then
    # First run: seed the baseline silently.
    mv "$tmp" "$state"; _cj_unlock
    return 0
  fi
  # The state always moves on to the new hashes; a report whose brain write
  # fails is parked in the pending file instead (retried hourly below).
  while IFS="$(printf '\t')" read -r path before after; do
    [ -n "$path" ] || continue
    [ "$before" = - ] && before="none (new file)"
    [ "$after" = - ] && after="none (removed)"
    _cj_announced "$path" "$now" && continue
    _cj_pending_drop "$path"
    _cj_emit "$path" "$before" "$after" "$(_cj_live_sessions)" || _cj_pending_add "$path" "$before" "$after" "$now"
  done <<EOF
$(_cj_diff "$state" "$tmp")
EOF
  mv "$tmp" "$state"
  _cj_retry_pending "$now"
  _cj_unlock
  return 0
}

# _cj_pending_add <path> <before> <after> <now> — park a report whose brain
# write failed (live sessions recorded at detection). A path already pending
# keeps its original "before" and attempt time.
_cj_pending_add() {
  local f old
  f="$(cj_pending)"
  old="$(awk -F'\t' -v p="$1" '$1==p {print; exit}' "$f" 2>/dev/null || true)"
  if [ -n "$old" ]; then
    _cj_pending_drop "$1"
    printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$(printf '%s' "$old" | cut -f2)" "$3" "$(printf '%s' "$old" | cut -f4)" "$(printf '%s' "$old" | cut -f5)" >> "$f"
  else
    printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$4" "$(_cj_live_sessions)" >> "$f"
  fi
}
_cj_pending_drop() {
  local f; f="$(cj_pending)"
  [ -f "$f" ] || return 0
  awk -F'\t' -v p="$1" '$1!=p' "$f" > "$f.t.$$" 2>/dev/null && mv "$f.t.$$" "$f"
}

# _cj_retry_pending <now> — retry each parked report at most once per
# CJ_RETRY_EVERY (1h). Success → reported + dropped; failure → silent, retried
# next hour.
_cj_retry_pending() {
  local now="$1" f path before after last live rows
  f="$(cj_pending)"
  [ -s "$f" ] || return 0
  rows="$(cat "$f")"
  while IFS="$(printf '\t')" read -r path before after last live; do
    [ -n "$path" ] || continue
    case "$last" in ''|*[!0-9]*) last=0 ;; esac
    [ $((now - last)) -ge "$CJ_RETRY_EVERY" ] || continue
    _cj_pending_drop "$path"
    if ! _cj_emit "$path" "$before" "$after" "$live"; then
      printf '%s\t%s\t%s\t%s\t%s\n' "$path" "$before" "$after" "$now" "$live" >> "$f"
    fi
  done <<EOF
$rows
EOF
  return 0
}

# _cj_emit <path> <before> <after> <live> — an UNANNOUNCED change: brain atom
# FIRST; only once it is written: the log line, one visible line and the
# deduped coordinator mail. rc 1 (and nothing printed or mailed) when the brain
# write failed — the caller parks it as pending.
_cj_emit() {
  local path="$1" before="$2" after="$3" live="$4" content short
  short="${path#"$CJ_HOME"/}"; [ "$short" = "$path" ] || short="~/$short"
  content="UNANNOUNCED change to $short
host: $(cj_host)
before → after (sha256): $(_cj_short "$before") → $(_cj_short "$after")
live sessions at detection: $live
detected by: $(cj_who) (config_journal.sh scan)
No 'config_journal.sh note' was recorded for this file in the ${CJ_NOTE_WINDOW}s before the change was seen. If you made it, say so: config_journal.sh note $short \"<why>\"."
  _cj_brain "unannounced-config-change-$(_cj_slug "$path")" "$content" || return 1
  printf '%s\tUNANNOUNCED\t%s\t%s→%s\tlive: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$short" "$(_cj_short "$before")" "$(_cj_short "$after")" "$live" >> "$(cj_log)"
  echo "config journal: UNANNOUNCED change to $short (live sessions: $live) — brain atom + coordinator mail"
  _cj_mail_once "$path" "UNANNOUNCED config change on $(cj_host): $short ($(_cj_short "$before") → $(_cj_short "$after")); live sessions: $live. Whoever made it: config_journal.sh note $short \"<why>\""
  return 0
}

# _cj_spawn — run `scan` detached; stubbed in tests.
_cj_spawn() {
  nohup bash "$CJ_HERE/config_journal.sh" scan >> "$CJ_DIR/$(cj_host).bg.log" 2>&1 < /dev/null &
}

# cj_scan_bg — session-start form: skip when the last scan was under
# CJ_BG_MIN_GAP (5 min) ago, else spawn a detached scan and return at once.
cj_scan_bg() {
  local last
  mkdir -p "$CJ_DIR" 2>/dev/null || return 0
  last="$(cat "$(cj_stamp)" 2>/dev/null || echo 0)"
  case "$last" in ''|*[!0-9]*) last=0 ;; esac
  [ $(($(_cj_now) - last)) -ge "$CJ_BG_MIN_GAP" ] || return 0
  _cj_spawn
  return 0
}

cj_note() {
  local file="${1:-}" why="${2:-}" abs before after line short me coord kind watched=0 fp summary="" hist afterd
  [ -n "$file" ] && [ -n "$why" ] || { echo "usage: config_journal.sh note <file> \"<why>\"" >&2; return 2; }
  abs="$(cd "$(dirname "$file")" 2>/dev/null && printf '%s/%s' "$(pwd)" "$(basename "$file")")" || abs="$file"
  case "$file" in "~/"*) abs="$CJ_HOME/${file#"~/"}" ;; esac
  kind="$(_cj_target_kind "$abs")"
  [ "$kind" = docker-profiles ] && abs="$CJ_HOME/$CJ_DOCKER_PROFILES_KEY_SUFFIX"
  mkdir -p "$CJ_DIR" 2>/dev/null || true
  if [ "$(cj_watch_list | grep -cxF "$abs" || true)" != 0 ]; then watched=1; fi
  # A watched file's last hash is in the scan state; everything else noted is in
  # the targets file (see "Non-file note targets" above).
  if [ "$watched" = 1 ]; then hist="$(cj_state)"; else hist="$(_cj_targets)"; fi
  line="$(awk -F'\t' -v p="$abs" '$1==p {print; exit}' "$hist" 2>/dev/null || true)"
  before="$(printf '%s' "$line" | cut -f2)"; before="${before:-none}"
  case "$kind" in
    file) after="$(_cj_sha "$abs" | cut -f1)" ;;
    dir)  after="$(_cj_dir_fp "$abs")" ;;
    docker-profiles)
      if fp="$(_cj_docker_profiles_fp)" && [ -n "$fp" ]; then
        after="${fp%%	*}"; summary="${fp#*	}"
      else
        after="unavailable (docker mcp not reachable)"
      fi ;;
    *) after="none (removed)" ;;
  esac
  if [ "$watched" = 0 ] && { [ "$kind" = file ] || [ "$kind" = missing ]; }; then
    echo "config journal: note — $abs is not on the watch list (recorded anyway)" >&2
  fi
  me="$(cj_who)"
  short="${abs#"$CJ_HOME"/}"; [ "$short" = "$abs" ] || short="~/$short"
  afterd="$(_cj_short "$after")${summary:+ [$summary]}"
  printf '%s\t%s\t%s\t%s\t%s\n' "$abs" "$after" "$(_cj_now)" "$me" "$(printf '%s' "$why" | tr '\t\n' '  ')" >> "$(cj_notes)"
  # Record the announced hash so later scans (watched file) or the next note
  # (any other target) see it as known. A label (removed / unavailable) is
  # never recorded: the last real hash stays the next "before".
  case "$after" in
    none*|unavailable*) ;;
    *)
      if [ "$watched" = 1 ] && [ "$kind" = file ]; then
        if _cj_lock; then
          {
            awk -F'\t' -v p="$abs" '$1!=p' "$(cj_state)" 2>/dev/null || true
            printf '%s\t%s\t%s\t%s\n' "$abs" "$after" "$(_cj_mtime "$abs")" "$(_cj_now)"
          } > "$(cj_state).n.$$"
          mv "$(cj_state).n.$$" "$(cj_state)"
          _cj_unlock
        fi
      else
        {
          awk -F'\t' -v p="$abs" '$1!=p' "$(_cj_targets)" 2>/dev/null || true
          printf '%s\t%s\t%s\n' "$abs" "$after" "$(_cj_now)"
        } > "$(_cj_targets).n.$$"
        mv "$(_cj_targets).n.$$" "$(_cj_targets)"
      fi ;;
  esac
  printf '%s\tNOTE\t%s\t%s→%s\tby %s: %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$short" "$(_cj_short "$before")" "$afterd" "$me" "$why" >> "$(cj_log)"
  if ! _cj_brain "config-change-$(_cj_slug "$abs")" "Config change (announced) to $short
who: $me
target: $abs ($kind)
before → after (sha256): $(_cj_short "$before") → $afterd
why: $why"; then
    echo "config journal: brain atom NOT written (gateway unreachable?) — note kept locally in $(cj_notes)" >&2
  fi
  coord="$(kl_coordinator)"
  if [ -z "$coord" ] || [ "$coord" != "$me" ]; then
    _cj_tell "$(_cj_coordinator_lane)" "done" "config change by $me: $short ($(_cj_short "$before") → $afterd) — $why"
  fi
  echo "config journal: noted $short ($(_cj_short "$before") → $afterd) — brain atom + coordinator mail"
  return 0
}

cj_status() {
  local n
  n="$(cj_watch_list | grep -c . || true)"
  echo "config journal — $(cj_host): $n watched file(s); state $(cj_state)"
  if [ -s "$(cj_state)" ]; then
    local ts
    ts="$(awk -F'\t' '{if ($4>m) m=$4} END {print m+0}' "$(cj_state)")"
    echo "  last scan: $(date -d "@$ts" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || date -r "$ts" '+%Y-%m-%d %H:%M:%S' 2>/dev/null || echo "$ts")"
  else
    echo "  no baseline yet (the next scan seeds it)"
  fi
  if [ -s "$(cj_log)" ]; then
    echo "  recent events:"
    tail -n 8 "$(cj_log)" | sed 's/^/    /'
  fi
  return 0
}

cj_main() {
  local verb="${1:-status}"
  shift || true
  case "$verb" in
    scan) cj_scan ;;
    scan-bg) cj_scan_bg ;;
    note) cj_note "${1:-}" "${2:-}" ;;
    status) cj_status ;;
    -h|--help|help) sed -n '2,55p' "$CJ_HERE/config_journal.sh" | sed 's/^# \{0,1\}//' ;;
    *) echo "config_journal: unknown verb '$verb' (scan | scan-bg | note | status)" >&2; return 2 ;;
  esac
}

[ -n "${CONFIG_JOURNAL_LIB_ONLY:-}" ] && return 0
cj_main "$@"
