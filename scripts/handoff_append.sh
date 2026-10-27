#!/usr/bin/env bash
# handoff_append.sh — APPEND-SAFE handoff writes (plan/SWARM_COORDINATOR_PLAN.md
# row 7, spec §5): several agents wrap up into ONE state/AI_AGENT_HANDOFF.md, so
# no agent may rewrite the file — each inserts its own line under a lock.
#
# Usage:
#   handoff_append.sh --header "<line>" [--file state/AI_AGENT_HANDOFF.md]
#       inserts "> <line>" directly ABOVE the first "> " header line (newest first).
#   handoff_append.sh --action "<line>" [--file …]
#       inserts "> <line>" right after "**ACTION for next agent:**" and its blank
#       line (newest first).
#   A line that already starts with ">" is not prefixed again.
#
# Guarantees: every other line is kept byte-for-byte; the write is atomic (tmp
# file in the same directory + mv); concurrent appenders serialise on a mkdir
# lock. The lock is MACHINE-LOCAL, outside Dropbox:
#   ${MYAI_HOME:-~/.myai}/locks/handoff-<repo-id>.lock
# (it guards one file per repo per machine; edits from other Macs are already
# serialised through git). Inside it, an `owner` file holds "<pid> <nonce>
# <epoch>" — our TOKEN; release removes the lock only while it still holds our
# token. A lock is STALE when its owner epoch — or, with no owner file yet (an
# appender killed between mkdir and the write), the lock dir's own mtime — is
# older than HANDOFF_LOCK_STALE (60s). Takeover is atomic: the stale lock is
# RENAMED to a unique tombstone (only the rename winner proceeds), its owner is
# re-read and must still be the stale one before the tombstone is removed —
# otherwise a fresh lock grabbed in that instant is put back.
# Exit 0 written · 1 lock timeout / anchor missing · 2 usage.
# bash 3.2-safe; safe under `set -euo pipefail`.
set -u

HA_HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
HANDOFF_LOCK_STALE="${HANDOFF_LOCK_STALE:-60}"
HANDOFF_LOCK_WAIT="${HANDOFF_LOCK_WAIT:-30}"

_ha_now()   { date +%s; }
_ha_sleep() { sleep "$1"; }
# _ha_mtime <path> → epoch mtime (GNU stat first, BSD fallback); empty if gone.
_ha_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || true; }

# _ha_lock_path <file> → ${MYAI_HOME:-~/.myai}/locks/handoff-<repo-id>.lock.
# repo id = the MAIN checkout's canonical id (worktrees share it); a file
# outside git gets "file-<cksum of its absolute path>".
_ha_lock_path() {
  local dir common id
  dir="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)" || dir="$(dirname "$1")"
  common="$(git -C "$dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [ -n "$common" ]; then
    if ! command -v canonical_repo_id >/dev/null 2>&1; then
      # shellcheck source=/dev/null
      . "$HA_HERE/lib/repo_id.sh" 2>/dev/null || true
    fi
    if command -v canonical_repo_id >/dev/null 2>&1; then
      id="$(canonical_repo_id "$(cd "$common/.." && pwd -P)")"
    else
      id="$(basename "$(cd "$common/.." && pwd -P)")"
    fi
  else
    id="file-$(printf '%s' "$dir/$(basename "$1")" | cksum | awk '{print $1}')"
  fi
  id="$(printf '%s' "$id" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9_-' '-')"
  printf '%s/locks/handoff-%s.lock' "${MYAI_HOME:-$HOME/.myai}" "$id"
}

# _ha_sig <lockdir> → the lock's identity + age source: "<owner>|<epoch>", the
# epoch taken from the owner token, else from the dir mtime. Empty if gone.
_ha_sig() {
  local owner ts
  [ -d "$1" ] || return 0
  owner="$(cat "$1/owner" 2>/dev/null || true)"
  ts="$(printf '%s' "$owner" | awk '{print $3}')"
  case "$ts" in ''|*[!0-9]*) ts="$(_ha_mtime "$1")" ;; esac
  printf '%s|%s' "$owner" "$ts"
}

# _ha_lock <lockdir> → 0 locked (HA_TOKEN set); 1 timed out.
_ha_lock() {
  local l="$1" waited=0 sig ts tomb
  mkdir -p "$(dirname "$l")" 2>/dev/null || return 1
  HA_TOKEN="$$ ${RANDOM}${RANDOM}${RANDOM} $(_ha_now)"
  while ! mkdir "$l" 2>/dev/null; do
    sig="$(_ha_sig "$l")"
    ts="${sig##*|}"
    case "$ts" in ''|*[!0-9]*) ts="" ;; esac
    if [ -n "$ts" ] && [ $(($(_ha_now) - ts)) -gt "$HANDOFF_LOCK_STALE" ]; then
      tomb="$l.stale.$$.${RANDOM}${RANDOM}"
      # Atomic takeover: only ONE contender wins this rename.
      if mv "$l" "$tomb" 2>/dev/null; then
        if [ "$(_ha_sig "$tomb")" = "$sig" ]; then
          rm -rf "$tomb" 2>/dev/null || true
        else
          # We grabbed a lock re-created a moment ago — not the stale one. Put
          # it back while the slot is still free. Residual risk (documented):
          # a THIRD appender re-creating the lock in that sub-millisecond gap.
          if [ ! -e "$l" ]; then mv "$tomb" "$l" 2>/dev/null || true; fi
          rm -rf "$tomb" 2>/dev/null || true
        fi
      fi
      continue
    fi
    if [ "$waited" -ge $((HANDOFF_LOCK_WAIT * 10)) ]; then return 1; fi
    _ha_sleep 0.1; waited=$((waited + 1))
  done
  printf '%s\n' "$HA_TOKEN" > "$l/owner.$$" && mv "$l/owner.$$" "$l/owner"
  return 0
}

# _ha_unlock <lockdir> — remove the lock only while it still holds OUR token.
_ha_unlock() {
  if [ "$(cat "$1/owner" 2>/dev/null || true)" = "${HA_TOKEN:-}" ]; then
    rm -rf "$1" 2>/dev/null || true
  else
    echo "handoff_append: lock $1 is no longer ours (taken over as stale?) — left in place" >&2
  fi
}

# ha_insert <file> <header|action> <line> — the locked, atomic insert.
ha_insert() {
  local file="$1" mode="$2" line="$3" lock tmp rc
  [ -f "$file" ] || { echo "handoff_append: $file not found" >&2; return 1; }
  case "$line" in '>'*) ;; *) line="> $line" ;; esac
  lock="$(_ha_lock_path "$file")"
  _ha_lock "$lock" || { echo "handoff_append: could not lock $file within ${HANDOFF_LOCK_WAIT}s" >&2; return 1; }
  tmp="$(dirname "$file")/.$(basename "$file").tmp.$$"
  HA_LINE="$line" /usr/bin/python3 - "$file" "$mode" "$tmp" <<'PY'
import os, sys
src, mode, tmp = sys.argv[1:4]
line = os.environ["HA_LINE"]
with open(src, encoding="utf-8", newline="") as f:
    lines = f.read().split("\n")
at = None
if mode == "header":
    for i, l in enumerate(lines):
        if l.startswith("> "):
            at = i
            break
else:
    for i, l in enumerate(lines):
        if l.strip() == "**ACTION for next agent:**":
            at = i + 1
            if at < len(lines) and lines[at].strip() == "":
                at += 1
            break
if at is None:
    sys.exit(3)
lines.insert(at, line)
with open(tmp, "w", encoding="utf-8", newline="") as f:
    f.write("\n".join(lines))
PY
  rc=$?
  if [ "$rc" = 0 ]; then
    mv "$tmp" "$file"
  else
    rm -f "$tmp"
    if [ "$rc" = 3 ]; then
      if [ "$mode" = header ]; then echo "handoff_append: no '> ' header line in $file" >&2
      else echo "handoff_append: no '**ACTION for next agent:**' line in $file" >&2; fi
    fi
  fi
  _ha_unlock "$lock"
  [ "$rc" = 0 ]
}

ha_main() {
  local mode="" line="" file=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --header|--action)
        [ $# -ge 2 ] || { echo "handoff_append: $1 needs a value" >&2; return 2; }
        mode="${1#--}"; line="$2"; shift 2 ;;
      --file)
        [ $# -ge 2 ] || { echo "handoff_append: --file needs a value" >&2; return 2; }
        file="$2"; shift 2 ;;
      -h|--help) sed -n '2,19p' "$HA_HERE/handoff_append.sh" | sed 's/^# \{0,1\}//'; return 0 ;;
      *) echo "handoff_append: unknown argument $1" >&2; return 2 ;;
    esac
  done
  [ -n "$mode" ] && [ -n "$line" ] || { echo "usage: handoff_append.sh --header \"<line>\" | --action \"<line>\" [--file F]" >&2; return 2; }
  if [ -z "$file" ]; then
    file="$(cd "$HA_HERE/.." && pwd)/state/AI_AGENT_HANDOFF.md"
    # Managed repos keep the handoff under AI/state.
    [ -f "$file" ] || file="$(cd "$HA_HERE/../.." && pwd)/AI/state/AI_AGENT_HANDOFF.md"
  fi
  ha_insert "$file" "$mode" "$line" || return 1
  echo "handoff_append: $mode line added to $file"
}

[ -n "${HANDOFF_APPEND_LIB_ONLY:-}" ] && return 0
ha_main "$@"
