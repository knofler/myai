#!/usr/bin/env bash
# session_registry.sh — the live-session registry: the one place `tell <label>`
# and session_ping.sh look up WHICH tmux session a label names, so a director
# can wake a worker live without guessing the pane.
#
# WHY THIS EXISTS (task-d759dd15, live session-to-session messaging on one Mac):
# ListAgents/SendMessage only see same-ACCOUNT sessions, so the master (one org)
# and tech (Team) running side by side on one Mac cannot talk live. The durable
# mailbox (mail_send/mail_inbox) IS account-independent and already works, but
# live DELIVERY — poking an idle peer so it reads the mail NOW — was missing.
# An idle claude session runs no hooks, so the only way to inject into it is
# `tmux send-keys` into its pane. That needs a label→pane map: this registry.
#
# Each session writes ONE row at session start (hooks/session/36-live-session-
# registry.sh). A row is a single tab-separated line:
#
#   label <TAB> profile <TAB> repo <TAB> host <TAB> tmux_session <TAB> pid <TAB> address <TAB> epoch
#
#   label         human handle (the tmux session name, or "<host> - <repo>")
#   profile       <x> for ~/.claude-<x> | agy | qwen | default (the account lane)
#   repo          canonical repo id (lowercased)
#   host          hostname -s (lowercased)
#   tmux_session  myai-fleet-<profile>-<repo>  (empty when not inside tmux)
#   pid           the claude process pid (liveness probe)
#   address       the mailbox address to send to  (host/repo)
#   epoch         when the row was written (newest wins on resolve)
#
# bash 3.2-safe (macOS /bin/bash). No external deps beyond coreutils. Sourced,
# never executed. Override SESSION_REGISTRY_FILE in tests for a throwaway file.
#
# A non-tmux tty CANNOT be live-injected: macOS blocks TIOCSTI, so there is no
# way to push keystrokes into a plain terminal that is not a tmux pane. Such a
# session still gets its mail the moment it next submits a prompt (the mail-live
# hook) or on its next session start (the mailbox banner) — just not instantly.

# Resolve the registry file path. ~/.myai is the machine-local store already
# used for tokens/env; the registry is machine-local by nature (tmux panes
# don't cross Macs). Tests point SESSION_REGISTRY_FILE at a tmpdir.
session_registry_file() {
  if [ -n "${SESSION_REGISTRY_FILE:-}" ]; then
    printf '%s\n' "$SESSION_REGISTRY_FILE"
  else
    # MYAI_HOME is the per-user STATE dir. A framework checkout there (the old
    # portable-compose meaning of the name, still set in some shells/.env files)
    # put state files at the AI repo root on both Macs (2026-10-18) — ignore it.
    local h="${MYAI_HOME:-}"
    if [ -n "$h" ] && [ -f "$h/scripts/lib/brain.sh" ] && [ -d "$h/runtime" ]; then h=""; fi
    printf '%s\n' "${h:-$HOME/.myai}/live-sessions.tsv"
  fi
}

# session_registry_write <label> <profile> <repo> <host> <tmux_session> <pid> <address>
# Upsert this session's row, keyed by pid (a session has exactly one live pid),
# so a restart or re-boot refreshes the row in place instead of piling dupes.
# Also drops rows whose pid is no longer alive (cheap GC — the file never grows
# without bound on a long-lived Mac). Appends epoch itself. Atomic via tmp+mv.
session_registry_write() {
  local label="$1" profile="$2" repo="$3" host="$4" tmux_session="$5" pid="$6" address="$7"
  local file tmp now line rpid
  file="$(session_registry_file)"
  mkdir -p "$(dirname "$file")" 2>/dev/null || return 0
  now="$(date +%s 2>/dev/null)"; [ -n "$now" ] || now=0
  tmp="$file.$$.tmp"
  : > "$tmp" 2>/dev/null || return 0
  # Keep every OTHER session's row whose pid is still alive; drop our old pid
  # row (we rewrite it) and any dead rows.
  if [ -f "$file" ]; then
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      rpid="$(printf '%s' "$line" | awk -F'\t' '{print $6}')"
      [ "$rpid" = "$pid" ] && continue
      if [ -n "$rpid" ] && kill -0 "$rpid" 2>/dev/null; then
        printf '%s\n' "$line" >> "$tmp"
      fi
    done < "$file"
  fi
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$label" "$profile" "$repo" "$host" "$tmux_session" "$pid" "$address" "$now" >> "$tmp"
  mv -f "$tmp" "$file" 2>/dev/null || rm -f "$tmp" 2>/dev/null
}

# session_registry_resolve <query> → echoes the single best-matching row (the
# full tab-separated line), or nothing (exit 1) if no row matches.
#
# Match precedence, each tier beating the next, newest-epoch wins within a tier:
#   1. exact tmux_session        (`tell myai-fleet-tech-ai_management`)
#   2. exact label               (`tell "office-mac - AI"`)
#   3. exact profile             (`tell <lane>`)                ← the common case
#   4. exact repo                (`tell ai_management`)
#   5. case-insensitive substring of the label
# A row is only eligible when it has a tmux_session AND its pid is still alive
# (only a live tmux pane can be injected). Callers read tmux_session (field 5)
# and address (field 7) from the returned line.
# session_default_addrs [root] → the JSON array of mailbox addresses THIS
# session answers to: host/repo, repo, (opt-in) role, host/<lane> (swarm-repo
# sessions only) and host/coordinator (the coordinator lease holder only). This is the ONE place the default address set is derived, so
# the idle watcher (scripts/mail_watch.sh), the busy mail-live hook, and the
# session-start banner all watch exactly the same addresses. Mirrors
# hooks/mail-live.sh's _mail_live_addrs; kept here so the watcher — which runs
# as a plain background task, not a hook — can source one lib for it.
#
#   host/repo host + canonical repo id                      ("office-mac/my-repo")
#   repo      canonical repo id, lowercased                 ("ai_management")
#   role      $MYAI_SESSION_ROLE, lowercased, when set      ("reviewer")
#   host/profile  host + session_profile, when not default AND the session
#                 runs in the swarm repo ($SWARM_REPO, default ai_management)
#                                                           ("office-mac/tech")
#   host/coordinator  only the session holding the swarm-coordinator lease
#                 (session_is_coordinator)                  ("office-mac/coordinator")
#
# ADDRESS COLLISION FIX (2026-10-04): the operator's iTerm arrangement opened
# master-lane sessions in several workspace repos (+ a worker in others) — with
# host + host/profile on every session, mail to office-mac/<master> surfaced in
# FIVE such sessions (any could ack it first) and bare "office-mac" in ~11.
# Bare host is gone; lane mail only reaches lane sessions in the swarm repo;
# the coordinator's role mail has its own single-holder address.
#
# host/profile is what `tell <lane>` / `tell agy` mail. Without it two lanes
# in the SAME repo share one address (host/repo), and a peer
# that is not in tmux never resolves — `tell tech` then mailed the literal
# address "tech", which no watcher listened on, so the message was never seen
# (2026-10-03: phone → master → worker silently dropped).
#
# Repo id resolves through scripts/lib/repo_id.sh's canonical_repo_id when it is
# reachable (master checkout folder "AI" → "ai_management"), else the checkout
# basename. bash 3.2-safe. Prints "[]" only if even the hostname can't be read.
# session_master_repo → the one repo whose sessions take part in the swarm
# (lane mail, coordinator eligibility). Operator rule 2026-10-04.
session_master_repo() { printf '%s' "${SWARM_REPO:-ai_management}" | tr '[:upper:]' '[:lower:]'; }

# _sr_session_pid → pid of the claude/agy process this shell runs under
# (LANES_SELF_PID wins — detached helpers pass it in). Empty when none.
_sr_session_pid() {
  local p="$$" d=0 c
  if [ -n "${LANES_SELF_PID:-}" ]; then printf '%s' "$LANES_SELF_PID"; return 0; fi
  while [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null && [ "$d" -lt 15 ]; do
    c="$(ps -o comm= -p "$p" 2>/dev/null || true)"
    case "${c##*/}" in claude|agy) printf '%s' "$p"; return 0 ;; esac
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ' || true)"; d=$((d + 1))
  done
  return 0
}

# session_coordinator_file → host-wide record of the coordinator lease holder
# ("<host>/<lane>/<pid>"), written by `swarm master take`/failover and removed
# when it steps down or loses the lease (scripts/swarm_master.sh).
session_coordinator_file() {
  printf '%s/coordinator.%s.current' "${SWARM_DIR:-$HOME/.myai/swarm}" \
    "$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
}

# session_is_coordinator → 0 when THIS session is the recorded coordinator and
# that pid is still alive (a crashed holder's stale file never matches).
session_is_coordinator() {
  local f holder pid me
  f="$(session_coordinator_file)"
  [ -f "$f" ] || return 1
  holder="$(head -1 "$f" 2>/dev/null || true)"
  pid="${holder##*/}"
  case "$pid" in ''|*[!0-9]*) return 1 ;; esac
  me="$(_sr_session_pid)"
  [ -n "$me" ] && [ "$me" = "$pid" ] && kill -0 "$pid" 2>/dev/null
}

# session_direct_addrs [root] → the subset of session_default_addrs that names
# THIS session specifically (host/<lane>, host/coordinator), one per line.
# Unacked mail there is unhandled by definition — the watcher reports it even
# on its first (otherwise silent) pass.
session_direct_addrs() {
  session_default_addrs "${1:-}" | \
    SR_H="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')" SR_P="$(session_profile)" \
    /usr/bin/python3 -c '
import json, os, sys
h, p = os.environ["SR_H"], os.environ["SR_P"]
for a in json.loads(sys.stdin.read() or "[]"):
    if a in (h + "/" + p, h + "/coordinator"):
        print(a)
' 2>/dev/null || true
}

session_default_addrs() {
  local root repo host repo_lc role_part="" here _ridlib profile
  root="${1:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
  if ! command -v canonical_repo_id >/dev/null 2>&1; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)"
    for _ridlib in "$here/repo_id.sh" "$root/scripts/lib/repo_id.sh" "$root/AI/scripts/lib/repo_id.sh"; do
      # shellcheck source=/dev/null
      [ -f "$_ridlib" ] && . "$_ridlib" 2>/dev/null && break
    done
  fi
  if command -v canonical_repo_id >/dev/null 2>&1; then
    repo="$(canonical_repo_id "$root")"
  else
    repo="$(basename "$root")"
  fi
  host="$(hostname -s 2>/dev/null | tr '[:upper:]' '[:lower:]')"
  [ -n "$host" ] || { printf '[]\n'; return 0; }
  repo_lc="$(printf '%s' "$repo" | tr '[:upper:]' '[:lower:]')"
  if [ -n "${MYAI_SESSION_ROLE:-}" ]; then
    role_part=",\"$(printf '%s' "$MYAI_SESSION_ROLE" | tr '[:upper:]' '[:lower:]')\""
  fi
  profile="$(session_profile)"
  # A runner fire (MYAI_RUNNER_FIRE=1) shares a worker's config dir but is not
  # that worker's session — it must never answer host/<lane>. A lane
  # session OUTSIDE the swarm repo (an arrangement tab in WEBSITE/AZURE/…) does
  # not answer host/<lane> either: lane mail is swarm mail.
  if [ "$profile" != "default" ] && [ "${MYAI_RUNNER_FIRE:-0}" != "1" ] \
     && [ "$repo_lc" = "$(session_master_repo)" ]; then
    role_part="$role_part,\"$host/$profile\""
  fi
  if [ "${MYAI_RUNNER_FIRE:-0}" != "1" ] && session_is_coordinator; then
    role_part="$role_part,\"$host/coordinator\""
  fi
  printf '["%s/%s","%s"%s]\n' "$host" "$repo_lc" "$repo_lc" "$role_part"
}

# session_profile → the account/agent lane this session runs as, lowercased:
# $MYAI_SESSION_PROFILE when set (non-Claude agents, e.g. agy_session.sh sets
# "agy"), else derived from CLAUDE_CONFIG_DIR (~/.claude-<x> → x), else
# "default".
session_profile() {
  local p="default"
  if [ -n "${MYAI_SESSION_PROFILE:-}" ]; then
    p="$MYAI_SESSION_PROFILE"
  else
    case "${CLAUDE_CONFIG_DIR:-}" in
      */.claude-*) p="${CLAUDE_CONFIG_DIR##*/.claude-}" ;;
    esac
  fi
  printf '%s' "$p" | tr '[:upper:]' '[:lower:]'
}

# session_is_profile_label <label> → 0 when <label> names a session lane rather
# than a repo/role/tmux handle. `tell <lane>` mails host/<lane>.
session_is_profile_label() {
  case "$1" in
    # default = a bare `claude` on ~/.claude (CLAUDE_CONFIG_DIR unset) — the
    # lane lanes_match/check_session already resolve; without it session_ping
    # and tell called such a session "not live-wakeable" (2026-10-18).
    default|agy|qwen) return 0 ;;
    ''|*[!a-z0-9_-]*) return 1 ;;
  esac
  # A Claude lane is any ~/.claude-<x> profile this Mac has (v1 G6: lane names
  # are the user's data, never a list in code).
  [ -d "$HOME/.claude-$1" ]
}

session_registry_resolve() {
  local q="$1" file
  file="$(session_registry_file)"
  [ -f "$file" ] || return 1
  SR_Q="$q" awk -F'\t' '
    function alive(p) { if (p !~ /^[0-9]+$/) return 0; return (system("kill -0 " p " 2>/dev/null") == 0) }
    BEGIN { q = ENVIRON["SR_Q"]; ql = tolower(q); besttier = 99; bestepoch = -1; best = "" }
    {
      label=$1; profile=$2; repo=$3; tmux=$5; pid=$6; epoch=$8+0
      if (tmux == "") next
      if (!alive(pid)) next
      tier = 99
      if (tmux == q)                         tier = 1
      else if (label == q)                   tier = 2
      else if (profile == q)                 tier = 3
      else if (repo == q)                    tier = 4
      else if (index(tolower(label), ql))    tier = 5
      if (tier == 99) next
      if (tier < besttier || (tier == besttier && epoch > bestepoch)) {
        besttier = tier; bestepoch = epoch; best = $0
      }
    }
    END { if (best != "") { print best; exit 0 } else exit 1 }
  ' "$file"
}
