#!/bin/bash
set +e
# ============================================================
# Codebase Scanner — Autonomous Project Analysis
# ============================================================
# Scans any project directory and generates a comprehensive
# JSON report: tech stack, framework, dependencies, file
# structure, Docker setup, CI/CD, entry points.
#
# Usage:
#   ./scripts/scan-project.sh /path/to/project
#   ./scripts/scan-project.sh /path/to/project --json   (JSON only, no pretty output)
#   ./scripts/scan-project.sh /path/to/project --output /path/to/report.json
#
# Output: JSON report at <project>/AI/scan-report.json (default)
# ============================================================

PROJECT_DIR=""
JSON_ONLY=false
OUTPUT_PATH=""

# Parse args
while [ $# -gt 0 ]; do
  case "$1" in
    --json) JSON_ONLY=true; shift ;;
    --output) OUTPUT_PATH="$2"; shift 2 ;;
    *) PROJECT_DIR="$1"; shift ;;
  esac
done

if [ -z "$PROJECT_DIR" ]; then
  echo "Usage: ./scripts/scan-project.sh /path/to/project [--json] [--output path]"
  exit 1
fi

# Resolve to absolute path
PROJECT_DIR=$(cd "$PROJECT_DIR" 2>/dev/null && pwd)
if [ ! -d "$PROJECT_DIR" ]; then
  echo "Error: Directory not found: $PROJECT_DIR"
  exit 1
fi

PROJECT_NAME=$(basename "$PROJECT_DIR")

# ── Helper functions ──────────────────────────────────────────

count_files() {
  local pattern="$1"
  find "$PROJECT_DIR" -name "$pattern" -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/.next/*' -not -path '*/__pycache__/*' -not -path '*/venv/*' 2>/dev/null | wc -l | tr -d ' '
}

file_exists() {
  [ -f "$PROJECT_DIR/$1" ] && echo "true" || echo "false"
}

dir_exists() {
  [ -d "$PROJECT_DIR/$1" ] && echo "true" || echo "false"
}

read_json_field() {
  local file="$1" field="$2"
  if [ -f "$PROJECT_DIR/$file" ]; then
    python3 -c "import json; d=json.load(open('$PROJECT_DIR/$file')); print(d.get('$field',''))" 2>/dev/null || echo ""
  fi
}

# ── Detect project type ──────────────────────────────────────

detect_project_type() {
  local types=""

  [ -f "$PROJECT_DIR/package.json" ] && types="$types,nodejs"
  [ -f "$PROJECT_DIR/next.config.js" ] || [ -f "$PROJECT_DIR/next.config.mjs" ] || [ -f "$PROJECT_DIR/next.config.ts" ] && types="$types,nextjs"
  [ -f "$PROJECT_DIR/requirements.txt" ] || [ -f "$PROJECT_DIR/pyproject.toml" ] || [ -f "$PROJECT_DIR/setup.py" ] && types="$types,python"
  [ -f "$PROJECT_DIR/Cargo.toml" ] && types="$types,rust"
  [ -f "$PROJECT_DIR/go.mod" ] && types="$types,go"
  [ -f "$PROJECT_DIR/Gemfile" ] && types="$types,ruby"
  [ -f "$PROJECT_DIR/pom.xml" ] || [ -f "$PROJECT_DIR/build.gradle" ] && types="$types,java"

  echo "${types#,}"
}

# ── Detect framework ─────────────────────────────────────────

detect_framework() {
  local frameworks=""

  if [ -f "$PROJECT_DIR/package.json" ]; then
    local pkg="$PROJECT_DIR/package.json"
    grep -q '"next"' "$pkg" 2>/dev/null && frameworks="$frameworks,Next.js"
    grep -q '"react"' "$pkg" 2>/dev/null && frameworks="$frameworks,React"
    grep -q '"express"' "$pkg" 2>/dev/null && frameworks="$frameworks,Express"
    grep -q '"fastify"' "$pkg" 2>/dev/null && frameworks="$frameworks,Fastify"
    grep -q '"vue"' "$pkg" 2>/dev/null && frameworks="$frameworks,Vue"
    grep -q '"angular"' "$pkg" 2>/dev/null && frameworks="$frameworks,Angular"
    grep -q '"svelte"' "$pkg" 2>/dev/null && frameworks="$frameworks,Svelte"
    grep -q '"tailwindcss"' "$pkg" 2>/dev/null && frameworks="$frameworks,Tailwind CSS"
    grep -q '"mongoose"' "$pkg" 2>/dev/null && frameworks="$frameworks,Mongoose"
    grep -q '"prisma"' "$pkg" 2>/dev/null && frameworks="$frameworks,Prisma"
    grep -q '"@auth0"' "$pkg" 2>/dev/null && frameworks="$frameworks,Auth0"
    grep -q '"next-auth"' "$pkg" 2>/dev/null && frameworks="$frameworks,NextAuth"
    grep -q '"typescript"' "$pkg" 2>/dev/null && frameworks="$frameworks,TypeScript"
  fi

  if [ -f "$PROJECT_DIR/requirements.txt" ]; then
    grep -qi 'fastapi' "$PROJECT_DIR/requirements.txt" 2>/dev/null && frameworks="$frameworks,FastAPI"
    grep -qi 'django' "$PROJECT_DIR/requirements.txt" 2>/dev/null && frameworks="$frameworks,Django"
    grep -qi 'flask' "$PROJECT_DIR/requirements.txt" 2>/dev/null && frameworks="$frameworks,Flask"
    grep -qi 'sqlalchemy' "$PROJECT_DIR/requirements.txt" 2>/dev/null && frameworks="$frameworks,SQLAlchemy"
    grep -qi 'pymongo' "$PROJECT_DIR/requirements.txt" 2>/dev/null && frameworks="$frameworks,PyMongo"
  fi

  if [ -f "$PROJECT_DIR/pyproject.toml" ]; then
    grep -qi 'fastapi' "$PROJECT_DIR/pyproject.toml" 2>/dev/null && frameworks="$frameworks,FastAPI"
    grep -qi 'django' "$PROJECT_DIR/pyproject.toml" 2>/dev/null && frameworks="$frameworks,Django"
  fi

  echo "${frameworks#,}"
}

# ── Detect database ──────────────────────────────────────────

detect_database() {
  local dbs=""

  # From docker-compose
  if [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
    grep -q 'mongo' "$PROJECT_DIR/docker-compose.yml" 2>/dev/null && dbs="$dbs,MongoDB"
    grep -q 'postgres' "$PROJECT_DIR/docker-compose.yml" 2>/dev/null && dbs="$dbs,PostgreSQL"
    grep -q 'mysql' "$PROJECT_DIR/docker-compose.yml" 2>/dev/null && dbs="$dbs,MySQL"
    grep -q 'redis' "$PROJECT_DIR/docker-compose.yml" 2>/dev/null && dbs="$dbs,Redis"
  fi

  # From package.json
  if [ -f "$PROJECT_DIR/package.json" ]; then
    grep -q '"mongoose"' "$PROJECT_DIR/package.json" 2>/dev/null && [[ "$dbs" != *"MongoDB"* ]] && dbs="$dbs,MongoDB"
    grep -q '"pg"' "$PROJECT_DIR/package.json" 2>/dev/null && [[ "$dbs" != *"PostgreSQL"* ]] && dbs="$dbs,PostgreSQL"
    grep -q '"redis"' "$PROJECT_DIR/package.json" 2>/dev/null && [[ "$dbs" != *"Redis"* ]] && dbs="$dbs,Redis"
  fi

  # From env files
  for envfile in "$PROJECT_DIR/.env" "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env.local"; do
    if [ -f "$envfile" ]; then
      grep -qi 'MONGO' "$envfile" 2>/dev/null && [[ "$dbs" != *"MongoDB"* ]] && dbs="$dbs,MongoDB"
      grep -qi 'POSTGRES\|PG_' "$envfile" 2>/dev/null && [[ "$dbs" != *"PostgreSQL"* ]] && dbs="$dbs,PostgreSQL"
      grep -qi 'REDIS' "$envfile" 2>/dev/null && [[ "$dbs" != *"Redis"* ]] && dbs="$dbs,Redis"
    fi
  done

  echo "${dbs#,}"
}

# ── Detect deployment targets ────────────────────────────────

detect_deployment() {
  local deploys=""

  [ -f "$PROJECT_DIR/vercel.json" ] || [ -d "$PROJECT_DIR/.vercel" ] && deploys="$deploys,Vercel"
  [ -f "$PROJECT_DIR/render.yaml" ] && deploys="$deploys,Render"
  [ -f "$PROJECT_DIR/fly.toml" ] && deploys="$deploys,Fly.io"
  [ -f "$PROJECT_DIR/Procfile" ] && deploys="$deploys,Heroku"
  [ -f "$PROJECT_DIR/app.yaml" ] && deploys="$deploys,Google Cloud"
  [ -f "$PROJECT_DIR/Dockerfile" ] && deploys="$deploys,Docker"
  [ -d "$PROJECT_DIR/.github/workflows" ] && deploys="$deploys,GitHub Actions"
  [ -f "$PROJECT_DIR/netlify.toml" ] && deploys="$deploys,Netlify"

  echo "${deploys#,}"
}

# ── Detect auth ──────────────────────────────────────────────

detect_auth() {
  local auth=""

  if [ -f "$PROJECT_DIR/package.json" ]; then
    grep -q '"@auth0' "$PROJECT_DIR/package.json" 2>/dev/null && auth="$auth,Auth0"
    grep -q '"next-auth"' "$PROJECT_DIR/package.json" 2>/dev/null && auth="$auth,NextAuth"
    grep -q '"passport"' "$PROJECT_DIR/package.json" 2>/dev/null && auth="$auth,Passport"
    grep -q '"jsonwebtoken"' "$PROJECT_DIR/package.json" 2>/dev/null && auth="$auth,JWT"
    grep -q '"bcrypt"' "$PROJECT_DIR/package.json" 2>/dev/null && auth="$auth,bcrypt"
    grep -q '"@clerk"' "$PROJECT_DIR/package.json" 2>/dev/null && auth="$auth,Clerk"
    grep -q '"firebase"' "$PROJECT_DIR/package.json" 2>/dev/null && auth="$auth,Firebase Auth"
  fi

  echo "${auth#,}"
}

# ── Count files by type ──────────────────────────────────────

count_all_files() {
  local total
  total=$(find "$PROJECT_DIR" -type f \
    -not -path '*/node_modules/*' \
    -not -path '*/.git/*' \
    -not -path '*/dist/*' \
    -not -path '*/.next/*' \
    -not -path '*/__pycache__/*' \
    -not -path '*/venv/*' \
    -not -path '*/.venv/*' \
    2>/dev/null | wc -l | tr -d ' ')
  echo "$total"
}

# ── Detect entry points ─────────────────────────────────────

detect_entry_points() {
  local entries=""

  # Next.js pages/app
  [ -d "$PROJECT_DIR/src/app" ] && entries="$entries,src/app/ (Next.js App Router)"
  [ -d "$PROJECT_DIR/app" ] && [ ! -d "$PROJECT_DIR/src/app" ] && entries="$entries,app/ (Next.js App Router)"
  [ -d "$PROJECT_DIR/src/pages" ] && entries="$entries,src/pages/ (Next.js Pages Router)"
  [ -d "$PROJECT_DIR/pages" ] && entries="$entries,pages/ (Next.js Pages Router)"

  # Express/Node
  [ -f "$PROJECT_DIR/src/index.ts" ] && entries="$entries,src/index.ts"
  [ -f "$PROJECT_DIR/src/server.ts" ] && entries="$entries,src/server.ts"
  [ -f "$PROJECT_DIR/src/main.ts" ] && entries="$entries,src/main.ts"
  [ -f "$PROJECT_DIR/index.js" ] && entries="$entries,index.js"
  [ -f "$PROJECT_DIR/server.js" ] && entries="$entries,server.js"

  # Python
  [ -f "$PROJECT_DIR/app/main.py" ] && entries="$entries,app/main.py"
  [ -f "$PROJECT_DIR/main.py" ] && entries="$entries,main.py"
  [ -f "$PROJECT_DIR/manage.py" ] && entries="$entries,manage.py (Django)"

  echo "${entries#,}"
}

# ── Detect API routes ────────────────────────────────────────

detect_api_routes() {
  local routes=0

  # Next.js API routes
  routes=$(find "$PROJECT_DIR" -path '*/api/*' -name 'route.ts' -o -path '*/api/*' -name 'route.js' \
    -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')

  # Express routes
  if [ "$routes" -eq 0 ]; then
    routes=$(find "$PROJECT_DIR" -path '*/routes/*' -name '*.ts' -o -path '*/routes/*' -name '*.js' \
      -not -path '*/node_modules/*' 2>/dev/null | wc -l | tr -d ' ')
  fi

  # Python/FastAPI routes
  if [ "$routes" -eq 0 ]; then
    routes=$(find "$PROJECT_DIR" -path '*/routes/*' -name '*.py' -o -path '*/routers/*' -name '*.py' \
      -not -path '*/venv/*' -not -path '*/__pycache__/*' 2>/dev/null | wc -l | tr -d ' ')
  fi

  echo "$routes"
}

# ── Detect models ────────────────────────────────────────────

detect_models() {
  local models=""

  # Mongoose models
  for f in $(find "$PROJECT_DIR" -path '*/models/*' -name '*.ts' -o -path '*/models/*' -name '*.js' \
    -not -path '*/node_modules/*' 2>/dev/null); do
    local name=$(basename "$f" | sed 's/\.\(ts\|js\)$//')
    [ "$name" != "index" ] && models="$models,$name"
  done

  # Python models
  for f in $(find "$PROJECT_DIR" -path '*/models/*' -name '*.py' \
    -not -path '*/venv/*' -not -path '*/__pycache__/*' 2>/dev/null); do
    local name=$(basename "$f" | sed 's/\.py$//')
    [ "$name" != "__init__" ] && models="$models,$name"
  done

  echo "${models#,}"
}

# ── Git info ─────────────────────────────────────────────────

get_git_info() {
  if [ -d "$PROJECT_DIR/.git" ]; then
    local remote branch commits
    remote=$(cd "$PROJECT_DIR" && git remote get-url origin 2>/dev/null || echo "none")
    branch=$(cd "$PROJECT_DIR" && git branch --show-current 2>/dev/null || echo "unknown")
    commits=$(cd "$PROJECT_DIR" && git rev-list --count HEAD 2>/dev/null || echo "0")
    echo "$remote|$branch|$commits"
  else
    echo "none|none|0"
  fi
}

# ── Docker info ──────────────────────────────────────────────

get_docker_services() {
  if [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
    # Only match top-level service names (2-space or 4-space indented, under services:)
    python3 -c "
import yaml, sys
try:
    with open('$PROJECT_DIR/docker-compose.yml') as f:
        d = yaml.safe_load(f)
    svcs = d.get('services', {})
    print(','.join(svcs.keys()) if svcs else '')
except:
    sys.exit(0)
" 2>/dev/null || \
    # Fallback: grep for service-level keys (exactly 2 spaces indent)
    grep -E '^  [a-zA-Z_-]+:$' "$PROJECT_DIR/docker-compose.yml" 2>/dev/null | \
      sed 's/://;s/^[[:space:]]*//' | tr '\n' ',' | sed 's/,$//'
  fi
}

get_docker_compose_name() {
  if [ -f "$PROJECT_DIR/docker-compose.yml" ]; then
    grep -m1 '^name:' "$PROJECT_DIR/docker-compose.yml" 2>/dev/null | \
      sed 's/^name:[[:space:]]*//' | tr -d ' "'"'"'' | tr -d '\r'
  fi
}

# ── Test info ────────────────────────────────────────────────

detect_test_setup() {
  local test_frameworks=""

  if [ -f "$PROJECT_DIR/package.json" ]; then
    grep -q '"jest"' "$PROJECT_DIR/package.json" 2>/dev/null && test_frameworks="$test_frameworks,Jest"
    grep -q '"vitest"' "$PROJECT_DIR/package.json" 2>/dev/null && test_frameworks="$test_frameworks,Vitest"
    grep -q '"mocha"' "$PROJECT_DIR/package.json" 2>/dev/null && test_frameworks="$test_frameworks,Mocha"
    grep -q '"@playwright"' "$PROJECT_DIR/package.json" 2>/dev/null && test_frameworks="$test_frameworks,Playwright"
    grep -q '"cypress"' "$PROJECT_DIR/package.json" 2>/dev/null && test_frameworks="$test_frameworks,Cypress"
  fi

  if [ -f "$PROJECT_DIR/requirements.txt" ] || [ -f "$PROJECT_DIR/pyproject.toml" ]; then
    grep -qi 'pytest' "$PROJECT_DIR/requirements.txt" "$PROJECT_DIR/pyproject.toml" 2>/dev/null && test_frameworks="$test_frameworks,pytest"
  fi

  local test_files
  test_files=$(find "$PROJECT_DIR" \
    \( -name '*.test.ts' -o -name '*.test.js' -o -name '*.spec.ts' -o -name '*.spec.js' \
       -o -name 'test_*.py' -o -name '*_test.py' \) \
    -not -path '*/node_modules/*' -not -path '*/venv/*' 2>/dev/null | wc -l | tr -d ' ')

  echo "${test_frameworks#,}|$test_files"
}

# ── ENV vars ─────────────────────────────────────────────────

detect_env_vars() {
  local vars=""
  for envfile in "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env.local.example" "$PROJECT_DIR/.env.template"; do
    if [ -f "$envfile" ]; then
      vars=$(grep -E '^[A-Z_]+=?' "$envfile" 2>/dev/null | sed 's/=.*//' | tr '\n' ',' | sed 's/,$//')
      break
    fi
  done

  # Fallback: scan .env if no example exists (only var names, not values)
  if [ -z "$vars" ] && [ -f "$PROJECT_DIR/.env" ]; then
    vars=$(grep -E '^[A-Z_]+=?' "$PROJECT_DIR/.env" 2>/dev/null | sed 's/=.*//' | tr '\n' ',' | sed 's/,$//')
  fi

  echo "$vars"
}

# ── AI framework status ─────────────────────────────────────

detect_ai_framework() {
  local has_ai_dir="false" has_state="false" has_handoff="false" has_claude="false"

  [ -d "$PROJECT_DIR/AI" ] && has_ai_dir="true"
  [ -f "$PROJECT_DIR/AI/state/STATE.md" ] && has_state="true"
  [ -f "$PROJECT_DIR/AI/state/AI_AGENT_HANDOFF.md" ] && has_handoff="true"
  [ -f "$PROJECT_DIR/CLAUDE.md" ] && has_claude="true"

  echo "$has_ai_dir|$has_state|$has_handoff|$has_claude"
}

# ── Package info ─────────────────────────────────────────────

get_package_name() {
  read_json_field "package.json" "name"
}

get_package_version() {
  read_json_field "package.json" "version"
}

get_node_scripts() {
  if [ -f "$PROJECT_DIR/package.json" ]; then
    python3 -c "
import json
d=json.load(open('$PROJECT_DIR/package.json'))
scripts=d.get('scripts',{})
print(','.join(scripts.keys()))
" 2>/dev/null || echo ""
  fi
}

get_dependency_count() {
  if [ -f "$PROJECT_DIR/package.json" ]; then
    python3 -c "
import json
d=json.load(open('$PROJECT_DIR/package.json'))
deps=len(d.get('dependencies',{}))
devDeps=len(d.get('devDependencies',{}))
print(f'{deps}|{devDeps}')
" 2>/dev/null || echo "0|0"
  else
    echo "0|0"
  fi
}

# ============================================================
# RUN THE SCAN
# ============================================================

PROJECT_TYPE=$(detect_project_type)
FRAMEWORKS=$(detect_framework)
DATABASES=$(detect_database)
DEPLOYMENT=$(detect_deployment)
AUTH=$(detect_auth)
ENTRY_POINTS=$(detect_entry_points)
API_ROUTES=$(detect_api_routes)
MODELS=$(detect_models)
DOCKER_SERVICES=$(get_docker_services)
DOCKER_NAME=$(get_docker_compose_name)
TEST_INFO=$(detect_test_setup)
TEST_FRAMEWORKS=$(echo "$TEST_INFO" | cut -d'|' -f1)
TEST_FILE_COUNT=$(echo "$TEST_INFO" | cut -d'|' -f2)
ENV_VARS=$(detect_env_vars)
AI_INFO=$(detect_ai_framework)
GIT_INFO=$(get_git_info)
PKG_NAME=$(get_package_name)
PKG_VERSION=$(get_package_version)
NODE_SCRIPTS=$(get_node_scripts)
DEP_COUNTS=$(get_dependency_count)
DEPS=$(echo "$DEP_COUNTS" | cut -d'|' -f1)
DEV_DEPS=$(echo "$DEP_COUNTS" | cut -d'|' -f2)

# File counts
TOTAL_FILES=$(count_all_files)
TS_FILES=$(count_files "*.ts")
TSX_FILES=$(count_files "*.tsx")
JS_FILES=$(count_files "*.js")
JSX_FILES=$(count_files "*.jsx")
PY_FILES=$(count_files "*.py")
CSS_FILES=$(count_files "*.css")
MD_FILES=$(count_files "*.md")
JSON_FILES=$(count_files "*.json")
YAML_FILES=$(count_files "*.yml")
YAML_FILES2=$(count_files "*.yaml")
YAML_FILES=$((YAML_FILES + YAML_FILES2))

# Convert comma-separated to JSON arrays
to_json_array() {
  if [ -z "$1" ]; then
    echo "[]"
  else
    echo "$1" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | \
      awk 'NF{printf "%s\"%s\"", (NR>1?",":""), $0} END{print ""}' | \
      sed 's/^/[/;s/$/]/'
  fi
}

# Build JSON report
REPORT=$(cat <<JSONEOF
{
  "project": {
    "name": "$PROJECT_NAME",
    "package_name": "$PKG_NAME",
    "version": "$PKG_VERSION",
    "path": "$PROJECT_DIR",
    "scanned_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  },
  "stack": {
    "types": $(to_json_array "$PROJECT_TYPE"),
    "frameworks": $(to_json_array "$FRAMEWORKS"),
    "databases": $(to_json_array "$DATABASES"),
    "auth": $(to_json_array "$AUTH"),
    "deployment": $(to_json_array "$DEPLOYMENT"),
    "test_frameworks": $(to_json_array "$TEST_FRAMEWORKS")
  },
  "structure": {
    "total_files": $TOTAL_FILES,
    "file_counts": {
      "typescript": $TS_FILES,
      "tsx": $TSX_FILES,
      "javascript": $JS_FILES,
      "jsx": $JSX_FILES,
      "python": $PY_FILES,
      "css": $CSS_FILES,
      "markdown": $MD_FILES,
      "json": $JSON_FILES,
      "yaml": $YAML_FILES
    },
    "entry_points": $(to_json_array "$ENTRY_POINTS"),
    "api_route_count": $API_ROUTES,
    "test_file_count": $TEST_FILE_COUNT,
    "models": $(to_json_array "$MODELS")
  },
  "dependencies": {
    "production": $DEPS,
    "dev": $DEV_DEPS,
    "npm_scripts": $(to_json_array "$NODE_SCRIPTS")
  },
  "docker": {
    "has_dockerfile": $(file_exists "Dockerfile"),
    "has_compose": $(file_exists "docker-compose.yml"),
    "compose_name": "$DOCKER_NAME",
    "services": $(to_json_array "$DOCKER_SERVICES")
  },
  "git": {
    "is_repo": $(dir_exists ".git"),
    "remote": "$(echo "$GIT_INFO" | cut -d'|' -f1)",
    "branch": "$(echo "$GIT_INFO" | cut -d'|' -f2)",
    "total_commits": $(echo "$GIT_INFO" | cut -d'|' -f3)
  },
  "ai_framework": {
    "has_ai_dir": $(echo "$AI_INFO" | cut -d'|' -f1),
    "has_state": $(echo "$AI_INFO" | cut -d'|' -f2),
    "has_handoff": $(echo "$AI_INFO" | cut -d'|' -f3),
    "has_claude_md": $(echo "$AI_INFO" | cut -d'|' -f4)
  },
  "env_vars": $(to_json_array "$ENV_VARS"),
  "recommendations": {
    "needs_docker": $([ "$(file_exists "Dockerfile")" = "false" ] && echo "true" || echo "false"),
    "needs_ci": $([ "$(dir_exists ".github/workflows")" = "false" ] && echo "true" || echo "false"),
    "needs_tests": $([ "$TEST_FILE_COUNT" -lt 3 ] && echo "true" || echo "false"),
    "needs_ai_framework": $([ "$(echo "$AI_INFO" | cut -d'|' -f1)" = "false" ] && echo "true" || echo "false"),
    "needs_env_example": $([ "$(file_exists ".env.example")" = "false" ] && [ "$(file_exists ".env")" = "true" ] && echo "true" || echo "false")
  }
}
JSONEOF
)

# ── Output ────────────────────────────────────────────────────

# Determine output path
if [ -z "$OUTPUT_PATH" ]; then
  mkdir -p "$PROJECT_DIR/AI" 2>/dev/null || true
  OUTPUT_PATH="$PROJECT_DIR/AI/scan-report.json"
fi

echo "$REPORT" > "$OUTPUT_PATH"

if [ "$JSON_ONLY" = true ]; then
  echo "$REPORT"
  exit 0
fi

# Pretty output
echo "╔══════════════════════════════════════════════════════════╗"
echo "║  CODEBASE SCAN: $PROJECT_NAME"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Stack:       $PROJECT_TYPE"
echo "Frameworks:  $FRAMEWORKS"
echo "Databases:   $DATABASES"
echo "Auth:        ${AUTH:-none detected}"
echo "Deployment:  $DEPLOYMENT"
echo "Testing:     ${TEST_FRAMEWORKS:-none} ($TEST_FILE_COUNT test files)"
echo ""
echo "Files:       $TOTAL_FILES total ($TS_FILES .ts, $TSX_FILES .tsx, $JS_FILES .js, $PY_FILES .py)"
echo "API routes:  $API_ROUTES"
echo "Models:      ${MODELS:-none detected}"
echo "Entry:       $ENTRY_POINTS"
echo ""
echo "Docker:      compose=$(file_exists "docker-compose.yml") dockerfile=$(file_exists "Dockerfile")"
[ -n "$DOCKER_SERVICES" ] && echo "Services:    $DOCKER_SERVICES"
[ -n "$DOCKER_NAME" ] && echo "Compose name: $DOCKER_NAME"
echo ""
echo "Git:         $(echo "$GIT_INFO" | cut -d'|' -f2) branch, $(echo "$GIT_INFO" | cut -d'|' -f3) commits"
echo "Remote:      $(echo "$GIT_INFO" | cut -d'|' -f1)"
echo ""
echo "AI Framework: ai_dir=$(echo "$AI_INFO" | cut -d'|' -f1) state=$(echo "$AI_INFO" | cut -d'|' -f2) claude_md=$(echo "$AI_INFO" | cut -d'|' -f4)"
echo ""
echo "Dependencies: $DEPS prod, $DEV_DEPS dev"
[ -n "$NODE_SCRIPTS" ] && echo "Scripts:     $NODE_SCRIPTS"
echo ""

# Recommendations
NEEDS_SOMETHING=false
echo "Recommendations:"
[ "$(file_exists "Dockerfile")" = "false" ] && echo "  ⚡ Add Dockerfile for containerization" && NEEDS_SOMETHING=true
[ "$(dir_exists ".github/workflows")" = "false" ] && echo "  ⚡ Add GitHub Actions CI/CD" && NEEDS_SOMETHING=true
[ "$TEST_FILE_COUNT" -lt 3 ] && echo "  ⚡ Add more tests ($TEST_FILE_COUNT found)" && NEEDS_SOMETHING=true
[ "$(echo "$AI_INFO" | cut -d'|' -f1)" = "false" ] && echo "  ⚡ Initialize AI framework (run init_ai.sh)" && NEEDS_SOMETHING=true
[ "$NEEDS_SOMETHING" = false ] && echo "  All good!"
echo ""
echo "Report saved: $OUTPUT_PATH"
