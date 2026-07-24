#!/bin/bash
set -euo pipefail

# ============================================================
# AI Management Framework — Distributable Install Script
# Phase 4b of plan/AI_AUTOMATION_PLAN.md
# ============================================================
#
# Scans a target directory for git repositories, detects tech
# stacks, initializes the AI framework in each, starts the
# Docker stack (gateway + MongoDB + dashboard), triggers RAG
# indexing, and reports status.
#
# Usage:
#   ./scripts/install.sh /path/to/projects
#   ./scripts/install.sh /path/to/projects --max-depth 3
#   ./scripts/install.sh /path/to/projects --dry-run
#   ./scripts/install.sh /path/to/projects --skip-docker
#   ./scripts/install.sh /path/to/projects --yes
#
# Idempotent: safe to run multiple times. Already-initialized
# repos are detected and skipped. Docker stack is rebuilt only
# if not already running.
# ============================================================

# ── Script location ─────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TRACKING_FILE="$REPO_DIR/config/managed_repos.txt"
INIT_SCRIPT="$REPO_DIR/scripts/init_ai.sh"

# ── Defaults ────────────────────────────────────────────────
MAX_DEPTH=4
DRY_RUN=false
SKIP_DOCKER=false
AUTO_YES=false
TARGET_DIR=""

# ── Colors (disable if not a terminal) ──────────────────────
if [ -t 1 ]; then
  RED='\033[0;31m'
  GREEN='\033[38;5;208m'
  YELLOW='\033[1;33m'
  CYAN='\033[0;36m'
  BOLD='\033[1m'
  DIM='\033[2m'
  NC='\033[0m'
else
  RED='' GREEN='' YELLOW='' CYAN='' BOLD='' DIM='' NC=''
fi

# ── Helpers ─────────────────────────────────────────────────
info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
err()   { echo -e "${RED}[ERR]${NC}   $*"; }
fatal() { err "$*"; exit 1; }

usage() {
  cat <<EOF
Usage: $(basename "$0") <target-directory> [options]

Scan a directory tree for git repositories, initialize the AI
management framework in each, and start the Docker stack.

Options:
  --max-depth N    Max directory depth for repo discovery (default: $MAX_DEPTH)
  --dry-run        Show what would be done without making changes
  --skip-docker    Skip Docker stack startup
  --yes, -y        Skip confirmation prompt
  --help, -h       Show this help

Examples:
  ./scripts/install.sh ~/code
  ./scripts/install.sh ~/projects --max-depth 3 --dry-run
  ./scripts/install.sh ~/projects --yes
EOF
  exit 0
}

# ── Parse arguments ─────────────────────────────────────────
while [ $# -gt 0 ]; do
  case "$1" in
    --max-depth)
      [ -z "${2:-}" ] && fatal "--max-depth requires a number"
      MAX_DEPTH="$2"; shift 2 ;;
    --dry-run)
      DRY_RUN=true; shift ;;
    --skip-docker)
      SKIP_DOCKER=true; shift ;;
    --yes|-y)
      AUTO_YES=true; shift ;;
    --help|-h)
      usage ;;
    -*)
      fatal "Unknown option: $1 (use --help for usage)" ;;
    *)
      [ -n "$TARGET_DIR" ] && fatal "Multiple target directories not supported"
      TARGET_DIR="$1"; shift ;;
  esac
done

[ -z "$TARGET_DIR" ] && fatal "No target directory specified.\n  Usage: $(basename "$0") <target-directory> [--max-depth N] [--dry-run] [--yes]"

# Expand ~ to $HOME
TARGET_DIR="${TARGET_DIR/#\~/$HOME}"

# Resolve to absolute path
if [ -d "$TARGET_DIR" ]; then
  TARGET_DIR="$(cd "$TARGET_DIR" && pwd)"
else
  fatal "Target directory does not exist: $TARGET_DIR"
fi

# ── Banner ──────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║  AI Management Framework — Install                      ║${NC}"
echo -e "${CYAN}${BOLD}║  Phase 4b: Distributable Install Script                  ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  Target:     ${BOLD}$TARGET_DIR${NC}"
echo -e "  Max depth:  $MAX_DEPTH"
echo -e "  Framework:  $REPO_DIR"
[ "$DRY_RUN" = true ] && echo -e "  Mode:       ${YELLOW}DRY RUN${NC}"
echo ""

# ── Prerequisites ───────────────────────────────────────────
info "Checking prerequisites..."

PREREQ_FAIL=0

check_cmd() {
  local cmd="$1" label="$2" install_hint="$3"
  if command -v "$cmd" &>/dev/null; then
    ok "$label found: $(command -v "$cmd")"
  else
    err "$label not found — $install_hint"
    PREREQ_FAIL=1
  fi
}

check_cmd git "git" "install via: https://git-scm.com/downloads"
check_cmd docker "Docker" "install via: https://docs.docker.com/get-docker/"
check_cmd curl "curl" "install via your package manager — needed for gateway/RAG/MCP health checks"
check_cmd python3 "python3" "install Python 3 — needed to parse MCP JSON responses (RAG + tool count)"

# docker compose (v2 plugin) or docker-compose (v1 standalone)
if docker compose version &>/dev/null 2>&1; then
  ok "docker compose (v2 plugin) found"
  COMPOSE_CMD="docker compose"
elif command -v docker-compose &>/dev/null; then
  ok "docker-compose (v1) found"
  COMPOSE_CMD="docker-compose"
else
  err "docker compose not found — install Docker Compose: https://docs.docker.com/compose/install/"
  PREREQ_FAIL=1
  COMPOSE_CMD=""
fi

# Verify framework files exist
if [ ! -f "$INIT_SCRIPT" ]; then
  err "init_ai.sh not found at $INIT_SCRIPT — is this the AI management repo?"
  PREREQ_FAIL=1
fi

if [ ! -f "$REPO_DIR/docker-compose.yml" ]; then
  err "docker-compose.yml not found at $REPO_DIR — framework incomplete"
  PREREQ_FAIL=1
fi

[ $PREREQ_FAIL -ne 0 ] && fatal "Prerequisites not met. Fix the errors above and re-run."

echo ""

# ── Directories to skip during discovery ────────────────────
SKIP_DIRS="node_modules|\.git|vendor|__pycache__|\.venv|venv|dist|build|\.next|\.cache|\.Trash|\.DS_Store"

# ── Discover git repos ──────────────────────────────────────
info "Scanning $TARGET_DIR for git repositories (max depth: $MAX_DEPTH)..."

declare -a REPO_PATHS=()
declare -a REPO_NAMES=()
declare -a REPO_STACKS=()
declare -a REPO_STATUSES=()

# Detect tech stack for a single repo path
detect_stack() {
  local repo_path="$1"
  local stack=""

  # Next.js
  if ls "$repo_path"/next.config.* &>/dev/null; then
    stack="${stack:+$stack+}Next.js"
  fi

  # package.json based detection
  if [ -f "$repo_path/package.json" ]; then
    # Express
    if grep -q '"express"' "$repo_path/package.json" 2>/dev/null; then
      stack="${stack:+$stack+}Express"
    fi
    # React (only if not Next.js already)
    if [[ "$stack" != *"Next.js"* ]] && grep -q '"react"' "$repo_path/package.json" 2>/dev/null; then
      stack="${stack:+$stack+}React"
    fi
    # Vue
    if grep -q '"vue"' "$repo_path/package.json" 2>/dev/null; then
      stack="${stack:+$stack+}Vue"
    fi
    # MongoDB/Mongoose
    if grep -qE '"mongoose"|"mongodb"' "$repo_path/package.json" 2>/dev/null; then
      stack="${stack:+$stack+}MongoDB"
    fi
  fi

  # Docker
  if [ -f "$repo_path/docker-compose.yml" ] || [ -f "$repo_path/docker-compose.yaml" ] || [ -f "$repo_path/Dockerfile" ]; then
    stack="${stack:+$stack+}Docker"
  fi

  # TypeScript
  if [ -f "$repo_path/tsconfig.json" ]; then
    stack="${stack:+$stack+}TypeScript"
  fi

  # Python
  if [ -f "$repo_path/requirements.txt" ] || [ -f "$repo_path/pyproject.toml" ] || [ -f "$repo_path/setup.py" ]; then
    stack="${stack:+$stack+}Python"
  fi

  # Go
  if [ -f "$repo_path/go.mod" ]; then
    stack="${stack:+$stack+}Go"
  fi

  # Rust
  if [ -f "$repo_path/Cargo.toml" ]; then
    stack="${stack:+$stack+}Rust"
  fi

  # Ruby
  if [ -f "$repo_path/Gemfile" ]; then
    stack="${stack:+$stack+}Ruby"
  fi

  # Java
  if [ -f "$repo_path/pom.xml" ] || [ -f "$repo_path/build.gradle" ]; then
    stack="${stack:+$stack+}Java"
  fi

  echo "${stack:-unknown}"
}

# Determine AI framework status for a repo
check_ai_status() {
  local repo_path="$1"
  if [ -d "$repo_path/AI" ] && [ -f "$repo_path/AI/state/STATE.md" ] && [ -f "$repo_path/CLAUDE.md" ]; then
    echo "installed"
  elif [ -d "$repo_path/AI" ]; then
    echo "partial"
  else
    echo "none"
  fi
}

# Recursive directory walker
walk_for_repos() {
  local dir="$1"
  local depth="$2"

  [ "$depth" -gt "$MAX_DEPTH" ] && return

  # Check if this directory is a git repo
  if [ -d "$dir/.git" ]; then
    local name
    name="$(basename "$dir")"
    local rel_path="${dir#$TARGET_DIR/}"
    local stack
    stack="$(detect_stack "$dir")"
    local status
    status="$(check_ai_status "$dir")"

    REPO_PATHS+=("$dir")
    REPO_NAMES+=("$name")
    REPO_STACKS+=("$stack")
    REPO_STATUSES+=("$status")
    return  # Don't recurse into git repos
  fi

  # Recurse into subdirectories
  local entry
  for entry in "$dir"/*/; do
    [ ! -d "$entry" ] && continue
    local entry_name
    entry_name="$(basename "$entry")"

    # Skip known non-project directories
    if echo "$entry_name" | grep -qE "^($SKIP_DIRS)$"; then
      continue
    fi

    walk_for_repos "${entry%/}" $((depth + 1))
  done
}

walk_for_repos "$TARGET_DIR" 0

TOTAL_FOUND=${#REPO_PATHS[@]}

if [ "$TOTAL_FOUND" -eq 0 ]; then
  warn "No git repositories found under $TARGET_DIR (depth $MAX_DEPTH)"
  echo ""
  echo "  Hints:"
  echo "    - Increase depth: --max-depth 6"
  echo "    - Verify target contains git repos: find $TARGET_DIR -maxdepth $MAX_DEPTH -name .git -type d"
  exit 0
fi

ok "Found $TOTAL_FOUND git repositories"
echo ""

# ── Display discovery table ─────────────────────────────────
# Calculate column widths
MAX_NAME_WIDTH=4  # "REPO"
MAX_STACK_WIDTH=5 # "STACK"
for i in "${!REPO_PATHS[@]}"; do
  rel="${REPO_PATHS[$i]#$TARGET_DIR/}"
  # If the repo IS the target dir, show just the basename
  [ "$rel" = "${REPO_PATHS[$i]}" ] && rel="$(basename "${REPO_PATHS[$i]}")"
  len=${#rel}
  [ "$len" -gt "$MAX_NAME_WIDTH" ] && MAX_NAME_WIDTH=$len
  slen=${#REPO_STACKS[$i]}
  [ "$slen" -gt "$MAX_STACK_WIDTH" ] && MAX_STACK_WIDTH=$slen
done

# Cap widths for readability
[ "$MAX_NAME_WIDTH" -gt 50 ] && MAX_NAME_WIDTH=50
[ "$MAX_STACK_WIDTH" -gt 35 ] && MAX_STACK_WIDTH=35

# Header
printf "  ${BOLD}%-${MAX_NAME_WIDTH}s  %-${MAX_STACK_WIDTH}s  %s${NC}\n" "REPO" "STACK" "STATUS"
printf "  %${MAX_NAME_WIDTH}s  %${MAX_STACK_WIDTH}s  %s\n" "" "" "" | tr ' ' '-'

COUNT_INSTALLED=0
COUNT_PARTIAL=0
COUNT_NEW=0

for i in "${!REPO_PATHS[@]}"; do
  rel="${REPO_PATHS[$i]#$TARGET_DIR/}"
  # If the repo IS the target dir, show just the basename
  [ "$rel" = "${REPO_PATHS[$i]}" ] && rel="$(basename "${REPO_PATHS[$i]}")"
  # Truncate if too long
  if [ ${#rel} -gt $MAX_NAME_WIDTH ]; then
    rel="...${rel: -$((MAX_NAME_WIDTH - 3))}"
  fi
  stack="${REPO_STACKS[$i]}"
  if [ ${#stack} -gt $MAX_STACK_WIDTH ]; then
    stack="${stack:0:$((MAX_STACK_WIDTH - 3))}..."
  fi

  case "${REPO_STATUSES[$i]}" in
    installed)
      status_icon="${GREEN}OK${NC} AI framework installed"
      COUNT_INSTALLED=$((COUNT_INSTALLED + 1))
      ;;
    partial)
      status_icon="${YELLOW}!!${NC} Partial (AI/ exists, incomplete)"
      COUNT_PARTIAL=$((COUNT_PARTIAL + 1))
      ;;
    none)
      status_icon="${CYAN}>>${NC} Will initialize"
      COUNT_NEW=$((COUNT_NEW + 1))
      ;;
  esac

  printf "  %-${MAX_NAME_WIDTH}s  %-${MAX_STACK_WIDTH}s  " "$rel" "$stack"
  echo -e "$status_icon"
done

echo ""
echo -e "  ${BOLD}Summary:${NC} $TOTAL_FOUND repos found"
[ "$COUNT_INSTALLED" -gt 0 ] && echo -e "    ${GREEN}$COUNT_INSTALLED${NC} already initialized (will skip)"
[ "$COUNT_PARTIAL" -gt 0 ]   && echo -e "    ${YELLOW}$COUNT_PARTIAL${NC} partially initialized (will re-initialize)"
[ "$COUNT_NEW" -gt 0 ]       && echo -e "    ${CYAN}$COUNT_NEW${NC} new (will initialize)"
echo ""

REPOS_TO_INIT=$((COUNT_NEW + COUNT_PARTIAL))

if [ "$REPOS_TO_INIT" -eq 0 ] && [ "$SKIP_DOCKER" = false ]; then
  info "All repos already initialized. Will check Docker stack and RAG index."
elif [ "$REPOS_TO_INIT" -eq 0 ] && [ "$SKIP_DOCKER" = true ]; then
  ok "All repos already initialized. Nothing to do."
  exit 0
fi

# ── Dry run exit ────────────────────────────────────────────
if [ "$DRY_RUN" = true ]; then
  echo -e "${YELLOW}${BOLD}DRY RUN — no changes made.${NC}"
  echo "  Would initialize: $REPOS_TO_INIT repos"
  [ "$SKIP_DOCKER" = false ] && echo "  Would start Docker stack"
  echo "  Would trigger RAG indexing"
  exit 0
fi

# ── Confirmation ────────────────────────────────────────────
if [ "$AUTO_YES" = false ] && [ "$REPOS_TO_INIT" -gt 0 ]; then
  echo -n -e "  Initialize AI framework in ${BOLD}$REPOS_TO_INIT${NC} repos? [Y/n] "
  read -r confirm
  case "${confirm:-Y}" in
    [Yy]*) ;;
    *)
      info "Aborted by user."
      exit 0 ;;
  esac
  echo ""
elif [ "$AUTO_YES" = false ] && [ "$REPOS_TO_INIT" -eq 0 ] && [ "$SKIP_DOCKER" = false ]; then
  echo -n -e "  Start Docker stack and trigger RAG indexing? [Y/n] "
  read -r confirm
  case "${confirm:-Y}" in
    [Yy]*) ;;
    *)
      info "Aborted by user."
      exit 0 ;;
  esac
  echo ""
fi

# ── Initialize repos ───────────────────────────────────────
INIT_SUCCESS=0
INIT_FAIL=0
INIT_SKIP=0

if [ "$REPOS_TO_INIT" -gt 0 ]; then
  info "Initializing AI framework in $REPOS_TO_INIT repos..."
  echo ""

  for i in "${!REPO_PATHS[@]}"; do
    repo_path="${REPO_PATHS[$i]}"
    repo_name="${REPO_NAMES[$i]}"
    status="${REPO_STATUSES[$i]}"

    if [ "$status" = "installed" ]; then
      INIT_SKIP=$((INIT_SKIP + 1))
      continue
    fi

    echo -e "  ${CYAN}>>>${NC} Initializing: ${BOLD}$repo_name${NC} ($repo_path)"

    if bash "$INIT_SCRIPT" "$repo_path" 2>&1 | sed 's/^/      /'; then
      ok "  Initialized: $repo_name"
      INIT_SUCCESS=$((INIT_SUCCESS + 1))
    else
      err "  Failed to initialize: $repo_name"
      INIT_FAIL=$((INIT_FAIL + 1))
    fi
    echo ""
  done

  echo -e "  Initialization: ${GREEN}$INIT_SUCCESS succeeded${NC}"
  [ "$INIT_FAIL" -gt 0 ] && echo -e "                  ${RED}$INIT_FAIL failed${NC}"
  [ "$INIT_SKIP" -gt 0 ] && echo -e "                  ${DIM}$INIT_SKIP skipped (already installed)${NC}"
  echo ""
fi

# ── Register repos in managed_repos.txt ─────────────────────
info "Registering repos in $TRACKING_FILE..."

# Load existing entries (expand ~ and strip comments)
declare -A EXISTING_REPOS
if [ -f "$TRACKING_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    [[ -z "$line" ]] || [[ "$line" =~ ^[[:space:]]*# ]] && continue
    clean="${line%%#*}"
    clean="${clean%"${clean##*[![:space:]]}"}"
    clean="${clean/#\~/$HOME}"
    [ -n "$clean" ] && EXISTING_REPOS["$clean"]=1
  done < "$TRACKING_FILE"
fi

REGISTERED=0
NEW_ENTRIES=""
for i in "${!REPO_PATHS[@]}"; do
  repo_path="${REPO_PATHS[$i]}"
  if [ -z "${EXISTING_REPOS[$repo_path]+_}" ]; then
    NEW_ENTRIES="${NEW_ENTRIES}${repo_path}\n"
    REGISTERED=$((REGISTERED + 1))
  fi
done

if [ "$REGISTERED" -gt 0 ]; then
  # Append with a dated header
  {
    echo ""
    echo "# Auto-discovered by install.sh on $(date +%Y-%m-%d)"
    echo -e "$NEW_ENTRIES"
  } >> "$TRACKING_FILE"
  ok "Registered $REGISTERED new repos in managed_repos.txt"
else
  ok "All repos already registered"
fi
echo ""

# ── Docker stack ────────────────────────────────────────────
if [ "$SKIP_DOCKER" = true ]; then
  info "Skipping Docker stack (--skip-docker)"
  echo ""
else
  info "Starting Docker stack..."

  cd "$REPO_DIR"

  # Check if already running
  GATEWAY_RUNNING=false
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "myai-gateway"; then
    GATEWAY_RUNNING=true
  fi

  if [ "$GATEWAY_RUNNING" = true ]; then
    ok "Docker stack already running — rebuilding..."
    $COMPOSE_CMD up -d --build 2>&1 | sed 's/^/    /'
  else
    info "Starting Docker stack for the first time..."
    $COMPOSE_CMD up -d --build 2>&1 | sed 's/^/    /'
  fi

  # Wait for gateway health
  info "Waiting for gateway to become healthy..."
  HEALTH_ATTEMPTS=0
  HEALTH_MAX=30
  GATEWAY_HEALTHY=false

  while [ $HEALTH_ATTEMPTS -lt $HEALTH_MAX ]; do
    if curl -sf http://localhost:3200/health &>/dev/null; then
      GATEWAY_HEALTHY=true
      break
    fi
    sleep 2
    HEALTH_ATTEMPTS=$((HEALTH_ATTEMPTS + 1))
  done

  if [ "$GATEWAY_HEALTHY" = true ]; then
    ok "Gateway healthy at http://localhost:3200"
  else
    warn "Gateway not responding after ${HEALTH_MAX}x2s — check docker logs: docker logs myai-gateway"
  fi

  # Check dashboard
  if curl -sf http://localhost:3210/api/health &>/dev/null; then
    ok "Dashboard healthy at http://localhost:3210"
  else
    warn "Dashboard not responding — it may still be starting"
  fi

  echo ""
fi

# ── RAG indexing ────────────────────────────────────────────
if [ "$SKIP_DOCKER" = false ]; then
  info "Triggering initial RAG indexing via MCP endpoint..."

  RAG_RESPONSE=$(curl -sf -X POST http://localhost:3100/mcp \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"memory_reindex","arguments":{"scope":"all"}},"id":1}' \
    2>/dev/null || echo "")

  if [ -n "$RAG_RESPONSE" ]; then
    # Extract a summary from the response if possible
    CHUNKS=$(echo "$RAG_RESPONSE" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)
  content = d.get('result', {}).get('content', [{}])
  if content:
    text = content[0].get('text', '')
    print(text[:200])
  else:
    print('Indexing triggered')
except:
  print('Indexing triggered')
" 2>/dev/null || echo "Indexing triggered")
    ok "RAG indexing: $CHUNKS"
  else
    warn "Could not reach MCP endpoint for RAG indexing — run manually later:"
    echo "    curl -X POST http://localhost:3100/mcp -H 'Content-Type: application/json' \\"
    echo "      -d '{\"jsonrpc\":\"2.0\",\"method\":\"tools/call\",\"params\":{\"name\":\"memory_reindex\",\"arguments\":{\"scope\":\"all\"}},\"id\":1}'"
  fi
  echo ""
fi

# ── Telegram status ─────────────────────────────────────────
info "Checking Telegram bot configuration..."

TELEGRAM_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
if [ -z "$TELEGRAM_TOKEN" ] && [ -f "$REPO_DIR/.env" ]; then
  TELEGRAM_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- | tr -d "'\"" || true)
fi

if [ -n "$TELEGRAM_TOKEN" ]; then
  ok "Telegram bot token found"
else
  warn "No Telegram bot token found"
  echo "    Set TELEGRAM_BOT_TOKEN in $REPO_DIR/.env to enable Telegram notifications"
fi

# The runtime reads TELEGRAM_ALLOWED_CHATS (comma-separated allow-list) and
# TELEGRAM_DEFAULT_CHAT — NOT TELEGRAM_CHAT_ID. Check both (env first, then .env).
TELEGRAM_CHAT="${TELEGRAM_ALLOWED_CHATS:-${TELEGRAM_DEFAULT_CHAT:-}}"
if [ -z "$TELEGRAM_CHAT" ] && [ -f "$REPO_DIR/.env" ]; then
  TELEGRAM_CHAT=$(grep -E '^TELEGRAM_(ALLOWED_CHATS|DEFAULT_CHAT)=' "$REPO_DIR/.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d "'\"" || true)
fi

if [ -n "$TELEGRAM_CHAT" ]; then
  ok "Telegram chat allow-list configured"
else
  [ -n "$TELEGRAM_TOKEN" ] && warn "No TELEGRAM_ALLOWED_CHATS — run: ./scripts/telegram-setup.sh"
fi
echo ""

# ── MCP tools count ─────────────────────────────────────────
MCP_TOOLS_COUNT=""
if [ "$SKIP_DOCKER" = false ]; then
  MCP_TOOLS_COUNT=$(curl -sf -X POST http://localhost:3100/mcp \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","method":"tools/list","id":1}' 2>/dev/null | \
    python3 -c "import sys,json; print(len(json.load(sys.stdin).get('result',{}).get('tools',[])))" 2>/dev/null || echo "")
fi

# ── Final summary ───────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║  Installation Complete                                   ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "  ${BOLD}Repos${NC}"
echo -e "    Discovered:    $TOTAL_FOUND"
echo -e "    Initialized:   ${GREEN}$((INIT_SUCCESS + COUNT_INSTALLED))${NC} ($INIT_SUCCESS new + $COUNT_INSTALLED existing)"
[ "$INIT_FAIL" -gt 0 ] && echo -e "    Failed:        ${RED}$INIT_FAIL${NC}"
echo -e "    Registered:    $REGISTERED new in managed_repos.txt"
echo ""

if [ "$SKIP_DOCKER" = false ]; then
  echo -e "  ${BOLD}Services${NC}"
  echo -e "    Dashboard:     ${GREEN}http://localhost:3210${NC}"
  echo -e "    MCP Server:    ${GREEN}http://localhost:3100${NC}"
  echo -e "    Gateway API:   ${GREEN}http://localhost:3200${NC}"
  echo -e "    MongoDB:       localhost:27200"
  [ -n "$MCP_TOOLS_COUNT" ] && echo -e "    MCP Tools:     $MCP_TOOLS_COUNT available"
  echo ""
fi

echo -e "  ${BOLD}Telegram${NC}"
if [ -n "$TELEGRAM_TOKEN" ] && [ -n "$TELEGRAM_CHAT" ]; then
  echo -e "    Status:        ${GREEN}Configured${NC}"
elif [ -n "$TELEGRAM_TOKEN" ]; then
  echo -e "    Status:        ${YELLOW}Token set, no chat ID${NC}"
else
  echo -e "    Status:        ${DIM}Not configured${NC}"
fi
echo ""

echo -e "  ${BOLD}Next steps${NC}"
echo "    1. Open any managed repo and run: claude"
echo "    2. Type: agent mode"
echo "    3. The framework handles the rest"
echo ""

if [ "$INIT_FAIL" -gt 0 ]; then
  warn "Some repos failed to initialize. Review errors above and re-run."
  echo "  Re-run is safe — already-initialized repos will be skipped."
fi

echo -e "${GREEN}${BOLD}  AI Management Framework is live.${NC}"
echo ""
