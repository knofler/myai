#!/usr/bin/env bash
# 37-arm-mail-watch.sh — SessionStart banner that ARMS the idle mail watcher.
#
# The mail-live hook (hooks/mail-live.sh) delivers mail into a BUSY session (it
# polls on every prompt/tool call). But a session sitting IDLE at the prompt runs
# no hooks, so one lane could not wake an idle peer on the same Mac. scripts/
# mail_watch.sh closes that gap — a blocking background poll whose exit re-invokes
# the (even idle) session. This banner is the standing instruction to arm it: an
# agent must launch the watcher as a background task at session start and RE-ARM
# it every time it exits (its exit means mail arrived and was handled).
#
# The three layers, in one place:
#   • watcher  (this / scripts/mail_watch.sh) — IDLE session, blocking bg poll
#   • mail-live hook (hooks/mail-live.sh)      — BUSY session, per-activity poll
#   • tmux ping (`tell` / session_ping.sh)     — operator/agent-initiated poke
#
# RUNNER FIRES DON'T NEED IT: a headless runner fire works ONE queued task and
# reads its mail at claim time, then exits — there is no idle window to cover. So
# this banner is suppressed in per-task runner workspaces (ci-workspaces / git
# worktrees), exactly like hooks/session/34-collaborator-activity.sh.
#
# Silent, best-effort, always exit 0 (a banner must never break session start).
set +e

ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
[ -z "$ROOT" ] && ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/../.." 2>/dev/null && pwd)"
[ -z "$ROOT" ] && exit 0

# Suppress in per-task runner workspaces — those are short-lived headless
# sessions that read mail at claim, not idle sessions needing a watcher.
WS_ROOT="${CI_WORKSPACES:-$HOME/ci-workspaces}"
case "$ROOT" in
  "$WS_ROOT"/*) exit 0 ;;
  *"/.worktrees/"*) exit 0 ;;
esac

# Resolve the watcher path (master checkout vs managed repo's AI/ copy).
WATCH=""
for cand in "$ROOT/scripts/mail_watch.sh" "$ROOT/AI/scripts/mail_watch.sh"; do
  [ -f "$cand" ] && { WATCH="$cand"; break; }
done
[ -n "$WATCH" ] || exit 0

# Default address set this session will watch (same derivation the watcher uses).
ADDRS=""
for lib in "$ROOT/scripts/lib/session_registry.sh" "$ROOT/AI/scripts/lib/session_registry.sh"; do
  # shellcheck source=/dev/null
  [ -f "$lib" ] && . "$lib" 2>/dev/null && break
done
command -v session_default_addrs >/dev/null 2>&1 && ADDRS="$(session_default_addrs "$ROOT" 2>/dev/null)"

if [ -n "${NO_COLOR:-}" ]; then B='' R='' Y=''
else B=$'\033[1m'; R=$'\033[0m'; Y=$'\033[1;33m'; fi

printf '%s\n' "${Y}╔══════════════════════════════════════════════════════════════╗${R}"
printf '%s\n' "${Y}║${R} ${B}📬 ARM MAIL WATCH (MANDATORY)${R}"
printf '%s\n' "${Y}╚══════════════════════════════════════════════════════════════╝${R}"
printf '   Run the idle mail watcher as a BACKGROUND task NOW:\n'
printf '     %sbash %s%s\n' "$B" "$WATCH" "$R"
if [ -n "$ADDRS" ] && [ "$ADDRS" != "[]" ]; then
  printf '   Watching: %s\n' "$ADDRS"
fi
printf '   • Launch it with run_in_background (timeout 2h).\n'
printf '   • When it EXITS it has printed new mail — handle it, then RE-ARM\n'
printf '     (run the watcher again in the background) on EVERY exit.\n'
printf "   • It only READS and prints — never auto-reply to a kind=result mail.\n"

exit 0
