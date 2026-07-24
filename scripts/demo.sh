#!/usr/bin/env bash
# =============================================================================
# demo.sh — scripted walkthrough of the `myai` CLI (record-friendly).
#
# A narrated, sectioned demo of the AI Management Framework's install-to-running
# flow. Safe by default: it PRINTS each command and explains it, but only RUNS
# the read-only ones (`myai --version`, `myai doctor`). The stack-mutating steps
# (`init`, `up`, `down`) are shown but NOT executed unless you pass --run.
#
# Usage:
#   scripts/demo.sh                 # narrate + run read-only steps (safe)
#   scripts/demo.sh --run [DIR]     # also execute init/up/down against DIR
#                                   #   (DIR defaults to a fresh mktemp dir)
#   scripts/demo.sh --no-pause      # don't wait for Enter between steps
#   scripts/demo.sh --help
#
# Record it:
#   asciinema rec myai-demo.cast -c 'scripts/demo.sh --no-pause'
#
# Requires: bash 3.2+. The runnable steps additionally need node, docker, git.
# =============================================================================
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
MYAI="$REPO_ROOT/bin/myai.cjs"

RUN=false
PAUSE=true
TARGET_DIR=""

# ── colors (tty only) ──
if [ -t 1 ]; then
  B=$'\033[1m'; C=$'\033[36m'; G=$'\033[32m'; Y=$'\033[33m'; D=$'\033[2m'; R=$'\033[0m'
else
  B=""; C=""; G=""; Y=""; D=""; R=""
fi

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --run) RUN=true ;;
    --no-pause) PAUSE=false ;;
    -h|--help) usage ;;
    *) [ -z "$TARGET_DIR" ] && TARGET_DIR="$1" || true ;;
  esac
  shift
done

step=0
section() {
  step=$((step + 1))
  printf '\n%s━━ %d. %s ━━%s\n' "$B$C" "$step" "$1" "$R"
}
say()  { printf '%s%s%s\n' "$D" "$1" "$R"; }
cmd()  { printf '%s$ %s%s\n' "$G" "$1" "$R"; }
pause() { $PAUSE && { printf '%s  …press Enter%s' "$Y" "$R"; read -r _ || true; } || true; }

# A read-only command we actually execute for the demo.
demo_run() { cmd "$*"; "$@"; echo; }
# A mutating command we only display unless --run.
demo_show() {
  cmd "$*"
  if $RUN; then "$@"; echo
  else say "  (shown only — pass --run to execute)"; fi
}

printf '%s\n' "$B"
cat <<'BANNER'
   ███╗   ███╗██╗   ██╗ █████╗ ██╗     myai — AI Management Framework
   ████╗ ████║╚██╗ ██╔╝██╔══██╗██║     a self-installing AI brain for
   ██╔████╔██║ ╚████╔╝ ███████║██║     any software project
   ██║╚██╔╝██║  ╚██╔╝  ██╔══██║██║
   ██║ ╚═╝ ██║   ██║   ██║  ██║██║     scripts/demo.sh
BANNER
printf '%s\n' "$R"

# ── 1. The CLI exists and reports its version ────────────────────────────────
section "Meet the CLI"
say "One npm package installs two bins: \`myai\` and \`ai-manage\`."
demo_run node "$MYAI" --version
pause

# ── 2. Discover the commands ─────────────────────────────────────────────────
section "What can it do?"
say "A thin dispatcher over the framework's bash playbooks + docker compose."
demo_run node "$MYAI" --help
pause

# ── 3. Preflight ─────────────────────────────────────────────────────────────
section "Preflight your machine"
say "\`doctor\` verifies node, docker (+engine), compose, git, key, and ports."
demo_run node "$MYAI" doctor || say "  (doctor reported warnings/blocking issues — expected on a partial setup)"
pause

# ── 4. Scaffold into a project ───────────────────────────────────────────────
section "Scaffold the framework into a project"
if $RUN && [ -z "$TARGET_DIR" ]; then
  TARGET_DIR="$(mktemp -d 2>/dev/null || echo /tmp/myai-demo-$$)"
  say "Using temp dir: $TARGET_DIR"
fi
say "\`init\` drops the framework + a portable docker-compose + .env into a repo."
demo_show node "$MYAI" init --no-wizard "${TARGET_DIR:-~/path/to/your-project}"
pause

# ── 5. Bring the stack up ────────────────────────────────────────────────────
section "Run the self-contained stack"
say "gateway + dashboard + mongo on localhost; waits for health, prints the URL."
demo_show node "$MYAI" up
say "Dashboard → ${B}http://localhost:3210${R}   Gateway/MCP → http://localhost:3100"
pause

# ── 6. Register existing repos ───────────────────────────────────────────────
section "Register your other repos"
say "\`scan\` spiders git repos under a dir and seeds cross-repo RAG awareness."
demo_show node "$MYAI" scan --dry-run "${TARGET_DIR:-~/code}"
pause

# ── 7. Tear down ─────────────────────────────────────────────────────────────
section "Clean up"
demo_show node "$MYAI" down
echo
printf '%s✓ Demo complete.%s  Next: `myai init <path>` then `myai up`.\n' "$G" "$R"
say "Docs: documentation/DISTRIBUTION.md   Changes: CHANGELOG.md"

# Best-effort cleanup of a temp dir we created.
if $RUN && [ -n "${TARGET_DIR:-}" ] && [ "${TARGET_DIR#/tmp/}" != "$TARGET_DIR" ]; then
  rm -rf "$TARGET_DIR" 2>/dev/null || true
fi
