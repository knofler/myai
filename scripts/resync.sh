#!/usr/bin/env bash
# resync.sh — make BOTH memories current in one deterministic, token-free step:
# the CODE repo and the BRAIN. Safe at session start AND mid-session.
#
# OPERATOR DIRECTIVE (2026-09-14): "why cant always just start from repo code
# fetch and brain fetch, thats the decent way to start, like we did here in the
# middle of an existing session, plugged back in office mac wrapped up session
# here." Correct, and the gaps were real:
#
#   1. NOTHING SYNCED THE CODE REPO except the MODEL. `boot_sync.sh` syncs the
#      brain and the gateway; the code pull was a prose step in the `agent mode`
#      / `-min` protocol, improvised per session. So a mid-session re-plug — the
#      other Mac ships and wraps while this session is live — had no mechanism
#      at all. On 2026-09-14 that was 8 code commits + 8 brain atoms that only
#      arrived because the operator said so.
#   2. THE BOOT FORK-KILLER COULD LIE. `brain_converge` bounds its fetch with
#      `_brain_net_git`, whose budget is 2s, and on a Mac with no `timeout`/
#      `gtimeout` binary that degrades to `ssh -o ConnectTimeout=2 -o
#      BatchMode=yes`. A brain fetch here measures ~2.5s, and BatchMode makes a
#      not-yet-unlocked SSH key a hard failure rather than a wait. Result, this
#      very session: "brain: offline — converge skipped" on a perfectly online
#      machine, no action taken, brain left 3 behind until a later hook with a
#      looser budget happened to fix it. Same family as every other silent
#      failure in this repo: a warning nobody acts on == no warning.
#
# DESIGN. This script does NOT reimplement brain reconciliation — `brain_converge`
# already carries the safety (backup ref, distiller-outputs-only auto-resolve,
# abort + escalate on a real atom conflict, never reset --hard/force-push). It
# supplies the missing CODE half, gives the brain half a realistic network
# budget, and reports one honest verdict for both.
#
# THE CODE HALF IS RUNBOOK MODE 8, ENCODED. Dropbox replays a stale Mac's
# working tree over this one (`.git` is Dropbox-ignored, so history never syncs
# but working files do), which both blocks `pull --ff-only` and shows phantom
# modifications. Five occurrences to date. The runbook's proven procedure is
# exactly: prove every local deviation is a byte-identical echo of origin, and
# only then reset/remove and fast-forward. This script refuses to guess — ONE
# file that genuinely differs and it stops and reports, per the runbook's own
# "don't guess" rule.
#
# NEVER: reset --hard, clean -fd (it would take LOCAL-ONLY files), force-push,
# auto-merge diverged code, or touch a file whose content is not provably
# reproducible from origin.
#
# Usage:  resync.sh [--dry-run] [--quiet] [--code-only|--brain-only]
# Exit:   0 = current (or no-op)   1 = needs the operator   2 = usage error
set -uo pipefail

DRY=""; QUIET=""; DO_CODE=1; DO_BRAIN=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --quiet)   QUIET=1 ;;
    --code-only)  DO_BRAIN=0 ;;
    --brain-only) DO_CODE=0 ;;
    -h|--help) sed -n '2,6p;44,46p' "$0" | sed 's/^# \{0,2\}//'; exit 0 ;;
    *) echo "resync.sh: unknown arg '$1'" >&2; exit 2 ;;
  esac
  shift
done

say() { [ -n "$QUIET" ] || printf '%s\n' "$*"; }
NEEDS_OPERATOR=0

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

# Bounded fetch with ONE retry on a longer leash. The first attempt at session
# start is the cold one (DNS, SSH agent, keychain, wifi wake); giving up on it
# is what produced the false "offline". A real outage still fails fast enough.
net_fetch() {
  local dir="$1"; shift
  git -C "$dir" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=10 fetch -q "$@" 2>/dev/null && return 0
  sleep 2
  GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o ConnectTimeout=10" \
    git -C "$dir" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 fetch -q "$@" 2>/dev/null
}

# KNOWN-REGENERATING TRACKED STATE (2026-09-14, reported by the office-Mac peer).
# TRANSITION-ONLY as of task-1eba9e51 (2026-09-28): runner-repo-staleness is
# now per-host by name (state/runner-repo-staleness.<host>.json), UNTRACKED
# and gitignored — check_tracked_hygiene.sh denies it outright. This pattern
# stays so a checkout that has not yet fast-forwarded past the untrack commit
# (where the legacy shared file is still tracked and always locally modified)
# can discard its local rewrite losslessly and complete that very
# fast-forward. Once the fleet is converged nothing matches it anymore.
# History: rewritten from scratch on every boot / runner cycle with a fresh
# timestamp and counts, it was ALWAYS locally modified — ALWAYS "genuine local
# work" by the test below — and a single file blocked the fast-forward on
# EVERY boot on BOTH Macs. We had each hand-discarded the same file three
# times before anyone said so.
#
# Discarding a local modification to one of these is lossless BY DEFINITION:
# the content is a snapshot its own generator reproduces, never an input. That
# is the ONLY property that earns a place on this list — do not add a file
# merely because it is noisy. Every discard is REPORTED, never silent.
#
# NOT the fix for a machine-local file that should not be tracked at all: that
# is `check_tracked_hygiene.sh`'s DENY list + gitignore + `git rm --cached`,
# the route state/mongo-mirror-status.json took (task-93cf87bd, `70b730e7`).
# RESYNC_NO_REGENERABLE=1 disables this and restores the hard stop.
REGENERABLE='^(AI/)?state/runner-repo-staleness\.json$'

is_regenerable() {
  [ -z "${RESYNC_NO_REGENERABLE:-}" ] || return 1
  printf '%s' "$1" | grep -Eq "$REGENERABLE"
}

# ---------------------------------------------------------------- CODE half --
if [ "$DO_CODE" = 1 ]; then
  BR="$(git -C "$ROOT" branch --show-current 2>/dev/null)"
  if [ -z "$BR" ]; then
    say "code:  detached HEAD — skipped (nothing safe to fast-forward)"
  elif ! git -C "$ROOT" remote get-url origin >/dev/null 2>&1; then
    say "code:  no origin remote — skipped"
  elif ! net_fetch "$ROOT" origin; then
    say "code:  ⚠ fetch FAILED twice (genuinely offline, or credentials) — NOT synced"
    NEEDS_OPERATOR=1
  else
    AB="$(git -C "$ROOT" rev-list --left-right --count "HEAD...origin/$BR" 2>/dev/null || echo "0 0")"
    AHEAD="${AB%%	*}"; BEHIND="${AB##*	}"
    case "$AHEAD"  in ''|*[!0-9]*) AHEAD=0  ;; esac
    case "$BEHIND" in ''|*[!0-9]*) BEHIND=0 ;; esac

    if [ "$BEHIND" = 0 ]; then
      if [ "$AHEAD" = 0 ]; then say "code:  up to date ($BR @ $(git -C "$ROOT" rev-parse --short HEAD))"
      else say "code:  up to date with origin, $AHEAD local commit(s) UNPUSHED ($BR)"; fi
    elif [ "$AHEAD" != 0 ]; then
      say "code:  ⚠ DIVERGED — $AHEAD local / $BEHIND remote commit(s). Not auto-merging code."
      say "       decide: 'git rebase origin/$BR' (clean local commits) or 'git merge origin/$BR'."
      NEEDS_OPERATOR=1
    else
      # Behind only: the fast-forward case. Classify every local deviation first.
      DIFFERS=""; ECHOES=""; COLLISIONS=""; DISPOSABLE=""
      while IFS= read -r f; do
        [ -n "$f" ] || continue
        if git -C "$ROOT" cat-file -e "origin/$BR:$f" 2>/dev/null \
           && git -C "$ROOT" diff --quiet "origin/$BR" -- "$f" 2>/dev/null; then
          ECHOES="$ECHOES$f"$'\n'          # tracked, already identical to origin
        elif is_regenerable "$f"; then
          DISPOSABLE="$DISPOSABLE$f"$'\n'  # tracked on purpose, but regenerated
        else
          DIFFERS="$DIFFERS$f"$'\n'        # genuine local work (or a deletion)
        fi
      done <<< "$(git -C "$ROOT" diff --name-only 2>/dev/null)"

      while IFS= read -r f; do
        [ -n "$f" ] || continue
        git -C "$ROOT" cat-file -e "origin/$BR:$f" 2>/dev/null || continue   # LOCAL-ONLY: leave alone
        a="$(shasum -a 256 "$ROOT/$f" 2>/dev/null | cut -d' ' -f1)"
        b="$(git -C "$ROOT" show "origin/$BR:$f" 2>/dev/null | shasum -a 256 | cut -d' ' -f1)"
        if [ -n "$a" ] && [ "$a" = "$b" ]; then COLLISIONS="$COLLISIONS$f"$'\n'
        elif is_regenerable "$f"; then COLLISIONS="$COLLISIONS$f"$'\n'; DISPOSABLE="$DISPOSABLE$f"$'\n'
        else DIFFERS="$DIFFERS$f"$'\n'; fi
      done <<< "$(git -C "$ROOT" ls-files --others --exclude-standard 2>/dev/null)"

      # Count without the `|| echo 0` trap: `grep -c` ALREADY prints 0 on no
      # match and exits 1, so the fallback appended a SECOND zero, making every
      # count the string "0\n0" — which is != 0, so the guard below refused to
      # fast-forward in every clean case. Caught by test_resync.sh, same family
      # as the SC2015 `A && B || C` defects this repo fixes rather than baselines.
      nlines() { printf '%s' "$1" | grep -c . 2>/dev/null; }
      NE="$(nlines "$ECHOES")";     NE="${NE:-0}"
      NC="$(nlines "$COLLISIONS")"; NC="${NC:-0}"
      ND="$(nlines "$DIFFERS")";    ND="${ND:-0}"
      NX="$(nlines "$DISPOSABLE")"; NX="${NX:-0}"

      if [ "$ND" != 0 ]; then
        say "code:  ⚠ $BEHIND behind, but $ND file(s) hold GENUINE local changes — NOT resetting (runbook mode 8: don't guess)."
        printf '%s' "$DIFFERS" | sed 's/^/         differs: /'
        say "       commit/stash them, then re-run. Untouched: $NE echo(es), $NC identical collision(s)."
        NEEDS_OPERATOR=1
      elif [ -n "$DRY" ]; then
        say "code:  DRY — would ff $BEHIND commit(s); reset $NE Dropbox echo(es), remove $NC identical collision(s)"
      else
        [ "$NE" = 0 ] || git -C "$ROOT" checkout -- . 2>/dev/null
        # A tracked-but-regenerated file is ALWAYS locally modified, so it
        # blocks `merge --ff-only` entirely on its own. It was only ever cleared
        # by ACCIDENT: the blanket `checkout -- .` above runs only when at least
        # one Dropbox ECHO exists. With NE=0 and a single regenerating file the
        # cleanup was a no-op and the ff failed "after cleanup" on EVERY boot —
        # exactly the hand-discarding this list was added to stop. Discard the
        # tracked ones by name; the untracked ones are in COLLISIONS below.
        while IFS= read -r f; do
          [ -n "$f" ] || continue
          git -C "$ROOT" ls-files --error-unmatch -- "$f" >/dev/null 2>&1 \
            && git -C "$ROOT" checkout -- "$f" 2>/dev/null
        done <<< "$DISPOSABLE"
        while IFS= read -r f; do [ -n "$f" ] && rm -f "$ROOT/$f" 2>/dev/null; done <<< "$COLLISIONS"
        if git -C "$ROOT" merge --ff-only -q "origin/$BR" 2>/dev/null; then
          say "code:  +$BEHIND commit(s) → $(git -C "$ROOT" rev-parse --short HEAD)$([ "$NE" != 0 ] || [ "$NC" != 0 ] && printf ' (cleared %s Dropbox echo(es), %s collision(s))' "$NE" "$NC")"
          if [ "$NX" != 0 ]; then
            printf '%s' "$DISPOSABLE" | sed 's/^/         discarded regenerating: /'
          fi
          git -C "$ROOT" log --oneline "HEAD@{1}..HEAD" 2>/dev/null | head -3 | sed 's/^/         /'
        else
          say "code:  ⚠ fast-forward FAILED after cleanup — hand-inspect (runbook mode 8)"
          NEEDS_OPERATOR=1
        fi
      fi
    fi
  fi
fi

# --------------------------------------------------------------- BRAIN half --
if [ "$DO_BRAIN" = 1 ]; then
  LIB="$ROOT/scripts/lib/brain.sh"; [ -f "$LIB" ] || LIB="$ROOT/AI/scripts/lib/brain.sh"
  if [ ! -f "$LIB" ]; then
    say "brain: no brain lib — skipped"
  else
  # shellcheck disable=SC1090
  . "$LIB" 2>/dev/null
  if ! command -v brain_converge >/dev/null 2>&1; then
    say "brain: lib unusable — skipped"
  else
    BD="$(brain_dir 2>/dev/null)"
    if [ -z "$BD" ] || [ ! -d "$BD/.git" ]; then
      say "brain: no brain store — skipped"
    else
      BEFORE="$(git -C "$BD" rev-parse --short main 2>/dev/null)"
      # The whole point: a realistic budget, so a cold fetch is not read as offline.
      if [ -n "$DRY" ]; then
        # brain_converge is SILENT when already converged, and a silent dry-run
        # reads as "didn't run". Say which it was.
        DOUT="$(BRAIN_NET_TIMEOUT="${BRAIN_NET_TIMEOUT:-15}" BRAIN_CONVERGE_DRY=1 brain_converge 2>&1)"
        if [ -n "$DOUT" ]; then printf '%s\n' "$DOUT" | sed 's/^/brain: /' | sed 's/^brain: brain: /brain: /'
        else say "brain: DRY — already converged (main @ $BEFORE), nothing to do"; fi
      else
        OUT="$(BRAIN_NET_TIMEOUT="${BRAIN_NET_TIMEOUT:-15}" brain_converge 2>&1)"
        AFTER="$(git -C "$BD" rev-parse --short main 2>/dev/null)"
        if [ -n "$OUT" ]; then printf '%s\n' "$OUT" | sed 's/^/brain: /' | sed 's/^brain: brain: /brain: /'; fi
        if [ "$BEFORE" != "$AFTER" ]; then
          GAINED="$(git -C "$BD" rev-list --count "$BEFORE..main" 2>/dev/null || echo '?')"
          say "brain: +$GAINED atom/commit(s) → $AFTER"
        elif [ -z "$OUT" ]; then
          say "brain: up to date (main @ $AFTER)"
        fi
        case "$OUT" in *offline*|*ESCALAT*|*conflict*) NEEDS_OPERATOR=1 ;; esac
      fi
    fi
  fi
  fi
fi

if [ "$NEEDS_OPERATOR" != 0 ]; then
  say "resync: NEEDS OPERATOR — see the ⚠ line(s) above."
  exit 1
fi
exit 0
