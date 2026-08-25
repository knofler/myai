#!/usr/bin/env bash
# myai_wrapup.sh — the mechanical half of `wrap up`, collapsed into ONE
# entrypoint (BRAIN W4.2).
#
# Today `wrap up` hand-runs four separate scripted steps (rotate_state.sh,
# repo_card.sh, a memory_reindex MCP call, brain atom+merge) plus a hand-typed
# WRAPPED UP banner — five reasoning "steps" for the calling agent even though
# only one of them (the ~300-token session atom body: what shipped / decided /
# next / blockers) actually needs a model. `myai wrapup --mechanical` fuses
# the other four into one call so the agent's only remaining act during a
# close is authoring that atom body and piping it in.
#
# Usage:
#   myai wrapup --mechanical [--topic <topic>] [--repo <name>] [--slug <slug>]
#                [--atom-file <path>] [--no-atom] [--no-rotate] [--no-card]
#                [--no-reindex] [--reindex-scope master|all] [--profile <p>]
#                [--quiet]
#
#   echo "session summary…" | myai wrapup --mechanical --topic runner-ops
#
#   --topic <topic>        BRAIN_TOPIC for the atom — one of the ADR-020
#                           controlled set (runner-ops|cost-policy|
#                           gateway-infra|go-live|continuity|distribution|
#                           billing|brain|security|docs). Omit → warned
#                           'general' default (same as `myai brain write`).
#   --repo <name>           atom repo namespace (default: this folder's name)
#   --slug <slug>            atom slug (default: wrapup-<UTC timestamp>)
#   --atom-file <path>       read the atom body from a file instead of stdin
#   --no-atom                skip the brain atom+merge step entirely
#   --no-rotate               skip rotate_state.sh
#   --no-card                 skip repo_card.sh (App Directory upsert)
#   --no-reindex               skip the memory_reindex gateway call
#   --reindex-scope <s>        master (default, this repo) | all
#   --profile <p>               brain_session_start profile (default: cli)
#   --quiet                      suppress per-step banners
#
# Every step below is INDIVIDUALLY non-fatal: a missing script, an
# unreachable gateway, an unwired brain, or a failed push degrades that ONE
# step (reported inline) and the run continues. This script never uses
# `set -e` and always exits 0 once argument parsing succeeds — a wrap-up must
# never halt on the mechanical half. Steps, in order:
#   1. rotate_state.sh      — bound STATE.md / handoff (skip if missing)
#   2. repo_card.sh          — App Directory card upsert (skip if missing)
#   3. memory_reindex         — MCP call to re-embed state/handoff/archive
#   4. brain atom + merge      — brain_session_start → brain_atom_write →
#                                 brain_session_merge → brain_sync_verify.sh
#   5. WRAPPED UP banner        — printed last, dynamically filled from git
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
# Managed-repo layout support: this script + its lib/ siblings live under
# scripts/ (master repo) or AI/scripts/ (a managed repo carrying the AI/
# scaffold) — same dual-layout convention as repo_card.sh / gateway.sh.
if [ -f "$HERE/lib/brain.sh" ]; then
  LIBDIR="$HERE/lib"
  SCRIPTS_DIR="$HERE"
else
  LIBDIR="$ROOT/AI/scripts/lib"
  SCRIPTS_DIR="$ROOT/AI/scripts"
fi
BRAIN_LIB_OK=0
# shellcheck source=lib/brain.sh
if [ -f "$LIBDIR/brain.sh" ] && . "$LIBDIR/brain.sh" 2>/dev/null; then BRAIN_LIB_OK=1; fi
# shellcheck source=lib/gateway.sh
. "$LIBDIR/gateway.sh" 2>/dev/null || GATEWAY_LOCAL_TOKEN="${GATEWAY_LOCAL_TOKEN:-myai-local-bridge-dev}"
GATEWAY_MCP="${GATEWAY_MCP:-http://localhost:3100/mcp}"

cd "$ROOT" || exit 1

usage() { sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; }

MECHANICAL=0
TOPIC="" REPO_NS="" SLUG="" ATOM_FILE=""
NO_ATOM=0 NO_ROTATE=0 NO_CARD=0 NO_REINDEX=0
REINDEX_SCOPE="master"
PROFILE="${BRAIN_PROFILE:-cli}"
QUIET=0

while [ $# -gt 0 ]; do
  case "$1" in
    --mechanical) MECHANICAL=1 ;;
    --topic) shift; TOPIC="${1:-}" ;;
    --repo) shift; REPO_NS="${1:-}" ;;
    --slug) shift; SLUG="${1:-}" ;;
    --atom-file) shift; ATOM_FILE="${1:-}" ;;
    --no-atom) NO_ATOM=1 ;;
    --no-rotate) NO_ROTATE=1 ;;
    --no-card) NO_CARD=1 ;;
    --no-reindex) NO_REINDEX=1 ;;
    --reindex-scope) shift; REINDEX_SCOPE="${1:-master}" ;;
    --profile) shift; PROFILE="${1:-cli}" ;;
    --quiet) QUIET=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "myai wrapup: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [ "$MECHANICAL" != 1 ]; then
  echo "myai wrapup: pass --mechanical to run the mechanical close." >&2
  usage >&2
  exit 2
fi

bar() {
  [ "$QUIET" = 1 ] && return 0
  printf '\n\033[1m── %s %s\033[0m\n' "$1" "$(printf '%.0s─' $(seq 1 $((40 - ${#1}))) 2>/dev/null)"
}

STEP_ROTATE="skipped" STEP_CARD="skipped" STEP_REINDEX="skipped" STEP_BRAIN="skipped"
BRAIN_SHA=""

# ── 1. rotate_state.sh ────────────────────────────────────────────────────
bar "state rotation"
if [ "$NO_ROTATE" = 1 ]; then
  echo "  skipped (--no-rotate)"
elif [ -f "$SCRIPTS_DIR/rotate_state.sh" ]; then
  if bash "$SCRIPTS_DIR/rotate_state.sh" 2>&1 | sed 's/^/  /'; then
    STEP_ROTATE="ok"
  else
    STEP_ROTATE="failed (non-fatal)"
    echo "  rotate_state.sh failed — continuing"
  fi
else
  echo "  (no rotate_state.sh found — skipping)"
fi

# ── 2. repo_card.sh (App Directory upsert) ─────────────────────────────────
bar "app directory card"
if [ "$NO_CARD" = 1 ]; then
  echo "  skipped (--no-card)"
elif [ -f "$SCRIPTS_DIR/repo_card.sh" ]; then
  if bash "$SCRIPTS_DIR/repo_card.sh" 2>&1 | sed 's/^/  /'; then
    STEP_CARD="ok"
  else
    STEP_CARD="failed (non-fatal)"
    echo "  repo_card.sh failed — continuing"
  fi
else
  echo "  (no repo_card.sh found — skipping)"
fi

# ── 3. memory_reindex (best-effort RAG catch-up) ───────────────────────────
bar "memory reindex"
if [ "$NO_REINDEX" = 1 ]; then
  echo "  skipped (--no-reindex)"
elif ! command -v curl >/dev/null 2>&1; then
  echo "  (curl unavailable — skipping)"
else
  ARGS='{}'
  [ "$REINDEX_SCOPE" = "all" ] && ARGS='{"scope":"all"}'
  REINDEX_RESP="$(curl -sf -X POST "$GATEWAY_MCP" -H 'content-type: application/json' \
    -H "x-gateway-local-token: $GATEWAY_LOCAL_TOKEN" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"id\":1,\"params\":{\"name\":\"memory_reindex\",\"arguments\":$ARGS}}" 2>/dev/null)"
  if [ -n "$REINDEX_RESP" ]; then
    if command -v jq >/dev/null 2>&1; then
      TXT="$(printf '%s' "$REINDEX_RESP" | jq -r '.result.content[0].text // empty' 2>/dev/null)"
      if [ -n "$TXT" ]; then
        STORED="$(printf '%s' "$TXT" | jq -r '.totals.stored // "?"' 2>/dev/null)"
        SKIPPED="$(printf '%s' "$TXT" | jq -r '.totals.skipped // "?"' 2>/dev/null)"
        echo "  ✓ reindexed (scope=$REINDEX_SCOPE) — stored=$STORED skipped=$SKIPPED"
        STEP_REINDEX="ok"
      else
        echo "  reindex response unrecognized — $(printf '%s' "$REINDEX_RESP" | head -c 200)"
        STEP_REINDEX="failed (non-fatal)"
      fi
    else
      echo "  ✓ reindex call succeeded (install jq for a parsed summary)"
      STEP_REINDEX="ok"
    fi
  else
    echo "  gateway unreachable at $GATEWAY_MCP — skipping (non-fatal)"
    STEP_REINDEX="skipped (gateway unreachable)"
  fi
fi

# ── 4. brain atom + merge ──────────────────────────────────────────────────
bar "brain atom + merge"
if [ "$NO_ATOM" = 1 ]; then
  echo "  skipped (--no-atom)"
elif [ "$BRAIN_LIB_OK" != 1 ]; then
  echo "  (brain lib unavailable — skipping)"
else
  ATOM_BODY=""
  if [ -n "$ATOM_FILE" ]; then
    if [ -f "$ATOM_FILE" ]; then
      ATOM_BODY="$(cat "$ATOM_FILE")"
    else
      echo "  --atom-file not found: $ATOM_FILE"
    fi
  elif [ ! -t 0 ]; then
    ATOM_BODY="$(cat)"
  fi

  if [ -z "$ATOM_BODY" ]; then
    echo "  no atom body given (pipe the session summary on stdin, or --atom-file <path>) — skipping"
  elif ! brain_is_repo "$(brain_dir)" 2>/dev/null; then
    echo "  (no brain repo wired — run 'myai brain init' — skipping)"
  else
    [ -n "$REPO_NS" ] || REPO_NS="$(basename "$ROOT")"
    [ -n "$SLUG" ] || SLUG="wrapup-$(date -u +%Y%m%dT%H%M%SZ)"
    [ -n "$TOPIC" ] && export BRAIN_TOPIC="$TOPIC"
    brain_capture_code "$ROOT" >/dev/null 2>&1 || true

    if ! brain_session_start "$PROFILE" >/dev/null 2>&1; then
      echo "  brain_session_start failed — continuing without a brain atom"
    else
      ATOM_REL=""
      if ATOM_REL="$(printf '%s\n' "$ATOM_BODY" | brain_atom_write session "$REPO_NS" "$SLUG" 2>&1 | tail -1)"; then
        echo "  atom: $ATOM_REL"
        MERGE_LOG="$(mktemp -t myai-wrapup-merge.XXXXXX 2>/dev/null || echo /tmp/myai-wrapup-merge.$$)"
        if brain_session_merge >"$MERGE_LOG" 2>&1; then
          sed 's/^/  /' "$MERGE_LOG"
          STEP_BRAIN="ok"
          # brain_sync_verify.sh pushes + verifies main landed on origin and
          # prints the `Brain: <sha>` anchor line the next session's
          # `brain_delta` boots from — non-fatal, prints a loud warning
          # (never a crash) if the push didn't land.
          if [ -f "$SCRIPTS_DIR/brain_sync_verify.sh" ]; then
            VERIFY_OUT="$(bash "$SCRIPTS_DIR/brain_sync_verify.sh" 2>&1)"
            echo "$VERIFY_OUT" | sed 's/^/  /'
            BRAIN_SHA="$(printf '%s\n' "$VERIFY_OUT" | grep -m1 '^Brain: ' | cut -d' ' -f2-)"
          fi
        else
          sed 's/^/  /' "$MERGE_LOG"
          STEP_BRAIN="failed (non-fatal)"
          echo "  brain_session_merge failed — atom is committed on the session branch, retry 'myai brain merge' manually"
        fi
        rm -f "$MERGE_LOG"
      else
        echo "  brain_atom_write failed: $ATOM_REL"
        STEP_BRAIN="failed (non-fatal)"
      fi
    fi
    unset BRAIN_TOPIC BRAIN_CODE_REPO BRAIN_CODE_BRANCH BRAIN_CODE_SHA BRAIN_CODE_COMMITS 2>/dev/null || true
  fi
fi

# ── 5. WRAPPED UP banner ────────────────────────────────────────────────────
# Every field here is git/env-derivable — no reasoning required. See
# documentation/WRAP_UP_BANNER.md for the canonical template this mirrors.
bar "banner"

CFG_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CFG_BASE="$(basename "$CFG_DIR")"
case "$CFG_BASE" in
  .claude-museum)   ORG_LABEL="claude-museum";   DOT="🟣" ;;
  .claude-tech)     ORG_LABEL="claude-tech";     DOT="🔵" ;;
  .claude-personal) ORG_LABEL="claude-personal"; DOT="🟢" ;;
  .claude)          ORG_LABEL="claude";          DOT="🟡" ;;
  *)                ORG_LABEL="$CFG_BASE";       DOT="🟡" ;;
esac
ORG_NAME=""
if [ -f "$CFG_DIR/.claude.json" ] && command -v python3 >/dev/null 2>&1; then
  ORG_NAME="$(python3 -c "
import json
try:
    d = json.load(open('$CFG_DIR/.claude.json'))
    oa = d.get('oauthAccount') or {}
    print(oa.get('organizationName') or oa.get('emailAddress') or '')
except Exception:
    print('')
" 2>/dev/null)"
fi
[ -n "$ORG_NAME" ] || ORG_NAME="unknown"

REPO_NAME="$(basename "$ROOT")"
if [ -f "$ROOT/package.json" ] && grep -q '"name": "ai-management"' "$ROOT/package.json" 2>/dev/null; then
  REPO_KIND="master"
elif [ -d "$ROOT/AI" ]; then
  REPO_KIND="sub-repo"
else
  REPO_KIND="standalone"
fi
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '?')"
REMOTE="$(git remote get-url origin 2>/dev/null || echo 'none')"
HOST="$(hostname -s 2>/dev/null || echo '?')"
if [ "$HOST" = "vm" ] || [ "${CODECLOT_OVERRIDE:-0}" = "1" ]; then
  SESSION_KIND="Mobile"
else
  SESSION_KIND="CLI"
fi
WRAPPED_TS="$(date -u '+%Y-%m-%d %H:%M UTC')"

PRS="none"
if command -v gh >/dev/null 2>&1 && [ "$REMOTE" != "none" ]; then
  TODAY_UTC="$(date -u '+%Y-%m-%d')"
  PR_LIST="$(gh pr list --state merged --search "merged:>=$TODAY_UTC" --json number,title \
    --jq '.[] | "#\(.number) \(.title)"' 2>/dev/null)"
  [ -n "$PR_LIST" ] && PRS="$PR_LIST"
fi

DIRTY="$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')"
if [ "${DIRTY:-0}" -gt 0 ] 2>/dev/null; then
  STATUS_LINE="$DIRTY uncommitted change(s) — commit before closing"
else
  STATUS_LINE="All green — nothing pending"
fi

cat <<BANNER

╔══════════════════════════════════════════════════════════════════╗
║                                                                  ║
║   ██╗    ██╗██████╗  █████╗ ██████╗ ██████╗ ███████╗██████╗     ║
║   ██║    ██║██╔══██╗██╔══██╗██╔══██╗██╔══██╗██╔════╝██╔══██╗   ║
║   ██║ █╗ ██║██████╔╝███████║██████╔╝██████╔╝█████╗  ██║  ██║   ║
║   ██║███╗██║██╔══██╗██╔══██║██╔═══╝ ██╔═══╝ ██╔══╝  ██║  ██║   ║
║   ╚███╔███╔╝██║  ██║██║  ██║██║     ██║     ███████╗██████╔╝   ║
║    ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝     ╚═╝     ╚══════╝╚═════╝    ║
║                                                                  ║
║          ██╗   ██╗██████╗     ██╗                                ║
║          ██║   ██║██╔══██╗    ██║                                ║
║          ██║   ██║██████╔╝    ██║                                ║
║          ██║   ██║██╔═══╝     ╚═╝                                ║
║          ╚██████╔╝██║         ██╗                                ║
║           ╚═════╝ ╚═╝         ╚═╝                                ║
║                                                                  ║
║──────────────────────────────────────────────────────────────────║
║                                                                  ║
║   $DOT ORG:      $ORG_LABEL · $ORG_NAME
║   $DOT REPO:     $REPO_NAME ($REPO_KIND)
║   $DOT BRANCH:   $BRANCH
║   $DOT REMOTE:   $REMOTE
║   $DOT SESSION:  $SESSION_KIND ($HOST)
║   $DOT WRAPPED:  $WRAPPED_TS
║                                                                  ║
║   $DOT PRs:      $PRS
║   $DOT STATUS:   $STATUS_LINE
║                                                                  ║
╚══════════════════════════════════════════════════════════════════╝
BANNER

[ -n "$BRAIN_SHA" ] && echo "Brain: $BRAIN_SHA"

echo ""
echo "mechanical wrap-up summary: rotate=$STEP_ROTATE card=$STEP_CARD reindex=$STEP_REINDEX brain=$STEP_BRAIN"

exit 0
