#!/usr/bin/env bash
# init_fork.sh — Bootstrap a fresh fork/clone of ai_management.
#
# Resets personal data (state, logs, archive, managed_repos.txt) to fresh
# templates so the framework is ready for a new user without exposing the
# original author's session history.
#
# Modes:
#   --check    Non-destructive. Reports what would be reset.
#   --reset    Destructive. Backs up personal data, then resets from templates.
#   --help     Show this message.
#
# Default (no flag) is --check.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BLUE='\033[0;34m'
GREEN='\033[38;5;208m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

MODE="${1:---check}"

# ── Files that hold personal data ─────────────────────────────────────────────
PERSONAL_FILES=(
  "state/STATE.md"
  "state/AI_AGENT_HANDOFF.md"
  "logs/claude_log.md"
  "logs/copilot.md"
  "logs/gemini.md"
  "config/managed_repos.txt"
  "state/tasks.json"
  "state/scan-status.json"
)
ARCHIVE_DIR="state/archive"

# ── Helpers ───────────────────────────────────────────────────────────────────
file_size() {
  if [ -f "$1" ]; then
    wc -c < "$1" | tr -d ' '
  else
    echo "0"
  fi
}

print_help() {
  cat <<'HELP'
init_fork.sh — Bootstrap a fresh fork/clone of ai_management.

USAGE
  ./scripts/init_fork.sh [--check|--reset|--help]

MODES
  --check    Non-destructive (default). Lists every file the reset would
             touch with current size and target template.
  --reset    Destructive. Creates a timestamped backup at .fork-backup/,
             overwrites personal-data files with their templates, clears
             the archive folder, and writes the .fork-initialized marker.
  --help     Show this message.

SAFETY
  --reset refuses to run if a .master-do-not-fork-init file exists at
  repo root. Place this file (empty, gitignored) on machines where the
  repo is the author's working master to prevent foot-shooting.

  --reset also offers to drop+recreate the MongoDB volume (clears the
  RAG corpus + sessions). Prompts before doing so.

NEXT STEPS AFTER --reset
  1. docker compose up -d            # start fresh stack
  2. Edit config/managed_repos.txt   # add your local repo paths
  3. ./scripts/health_check.sh       # verify framework integrity
  4. ./scripts/init_ai.sh <path>     # install AI/ folder into each managed repo
  5. Open Claude Code → type: agent mode
HELP
}

print_status() {
  echo -e "${BOLD}=== Fork-init status check ===${NC}"
  echo ""
  echo -e "${BOLD}Personal-data files:${NC}"
  printf "%-40s %12s %12s\n" "FILE" "CURRENT" "TEMPLATE"
  printf "%-40s %12s %12s\n" "----" "-------" "--------"
  local has_personal=0
  for f in "${PERSONAL_FILES[@]}"; do
    local cur tpl
    cur=$(file_size "$f")
    tpl=$(file_size "${f}.template")
    [ "$tpl" = "0" ] && tpl=$(file_size "${f}.example")
    if [ "$cur" != "0" ] && [ "$cur" != "$tpl" ]; then
      printf "${YELLOW}%-40s %12s %12s${NC}\n" "$f" "${cur}B" "${tpl}B"
      has_personal=1
    else
      printf "%-40s %12s %12s\n" "$f" "${cur}B" "${tpl}B"
    fi
  done
  echo ""
  echo -e "${BOLD}Archive folder:${NC}"
  if [ -d "$ARCHIVE_DIR" ]; then
    local count
    count=$(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
    local size
    size=$(du -sh "$ARCHIVE_DIR" 2>/dev/null | awk '{print $1}')
    if [ "$count" = "0" ]; then
      echo "  (empty — fresh state)"
    else
      echo -e "  ${YELLOW}$count file(s), $size — would be moved to backup${NC}"
      has_personal=1
    fi
  else
    echo "  (no archive folder)"
  fi
  echo ""
  echo -e "${BOLD}Markers:${NC}"
  if [ -f ".fork-initialized" ]; then
    echo -e "  ${GREEN}.fork-initialized present${NC} — repo was initialised as fork at $(cat .fork-initialized)"
  else
    echo "  .fork-initialized: not present"
  fi
  if [ -f ".master-do-not-fork-init" ]; then
    echo -e "  ${RED}.master-do-not-fork-init present${NC} — --reset is BLOCKED on this machine"
  fi
  echo ""
  echo -e "${BOLD}Docker stack:${NC}"
  if docker compose ps --format json 2>/dev/null | head -1 | grep -q "myai-"; then
    docker compose ps --format 'table {{.Name}}\t{{.Status}}' 2>&1 | head -10
  else
    echo "  (not running — start with: docker compose up -d)"
  fi
  echo ""
  if [ "$has_personal" = "1" ]; then
    echo -e "${YELLOW}This repo currently holds personal data.${NC}"
    echo "Run './scripts/init_fork.sh --reset' to scrub it (with backup)."
  else
    echo -e "${GREEN}Fresh state — nothing to reset.${NC}"
  fi
}

do_reset() {
  # Safety: refuse if master marker exists
  if [ -f ".master-do-not-fork-init" ]; then
    echo -e "${RED}REFUSING: .master-do-not-fork-init present.${NC}"
    echo "This file marks the original author's master repo. Forks should never"
    echo "see this marker. If you intend to reset on this machine, remove the"
    echo "marker first: rm .master-do-not-fork-init"
    exit 1
  fi

  echo -e "${BOLD}=== Fork-init RESET ===${NC}"
  echo ""
  echo -e "${YELLOW}This will:${NC}"
  echo "  1. Back up personal data to .fork-backup/<timestamp>/"
  echo "  2. Overwrite STATE.md, AI_AGENT_HANDOFF.md, logs/*, managed_repos.txt"
  echo "     with their .template / .example versions"
  echo "  3. Move state/archive/*.md into the backup folder"
  echo "  4. Write .fork-initialized marker with today's UTC date"
  echo "  5. Offer to drop+recreate the MongoDB volume (clears RAG corpus)"
  echo ""
  printf "Continue? [y/N] "
  read -r ans
  if [ "$ans" != "y" ] && [ "$ans" != "Y" ]; then
    echo "Aborted."
    exit 0
  fi

  local stamp
  stamp=$(date -u +%Y%m%d-%H%M%S)
  local backup=".fork-backup/${stamp}"
  mkdir -p "$backup/state" "$backup/logs" "$backup/config"

  echo ""
  echo "Backing up to $backup/..."

  # Move personal files into backup, install templates
  for f in "${PERSONAL_FILES[@]}"; do
    if [ -f "$f" ]; then
      local target_dir="$backup/$(dirname "$f")"
      mkdir -p "$target_dir"
      cp -p "$f" "$target_dir/" 2>/dev/null || true
      echo "  backed up $f"
    fi
    local tpl
    if [ -f "${f}.template" ]; then
      tpl="${f}.template"
    elif [ -f "${f}.example" ]; then
      tpl="${f}.example"
    else
      tpl=""
    fi
    if [ -n "$tpl" ]; then
      cp "$tpl" "$f"
      echo "  reset $f from $tpl"
    fi
  done

  # Move archive
  if [ -d "$ARCHIVE_DIR" ] && [ "$(find "$ARCHIVE_DIR" -maxdepth 1 -type f -name "*.md" | wc -l)" -gt 0 ]; then
    mkdir -p "$backup/state/archive"
    find "$ARCHIVE_DIR" -maxdepth 1 -type f -name "*.md" -exec mv {} "$backup/state/archive/" \;
    echo "  moved archive .md files into backup"
  fi

  # MongoDB reset prompt
  echo ""
  if docker compose ps 2>/dev/null | grep -q myai-mongo; then
    printf "Drop+recreate myai-mongo volume to clear RAG corpus? [y/N] "
    read -r ans
    if [ "$ans" = "y" ] || [ "$ans" = "Y" ]; then
      docker compose down -v
      docker compose up -d
      echo "  Mongo volume recreated."
    else
      echo "  Mongo volume kept (RAG corpus preserved — may contain prior author's vectors)."
    fi
  fi

  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > .fork-initialized
  echo ""
  echo -e "${GREEN}=== Fork initialised ===${NC}"
  echo ""
  cat <<'NEXT'
NEXT STEPS
  1. docker compose up -d            (if not already running)
  2. Edit config/managed_repos.txt with your repo paths
  3. ./scripts/health_check.sh       (verify framework)
  4. ./scripts/init_ai.sh /path/to/repo  (per repo you want to manage)
  5. Open Claude Code in any managed repo and type: agent mode

  Backup of your previous state lives at .fork-backup/<timestamp>/ — gitignored.
NEXT
}

# ── Main ──────────────────────────────────────────────────────────────────────
case "$MODE" in
  --help|-h|help)
    print_help
    ;;
  --check|check)
    print_status
    ;;
  --reset|reset)
    do_reset
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo ""
    print_help
    exit 1
    ;;
esac
