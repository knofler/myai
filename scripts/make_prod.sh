#!/usr/bin/env bash
# =============================================================================
# make_prod.sh — Productionise a project
#
# Creates Vercel project, provisions MongoDB Atlas DB, optionally Render API.
# Designed to be called by Claude Code via the 'make prod' keyword, or manually.
#
# Usage:
#   ./scripts/make_prod.sh <project-root> [project-name]
#
# Examples:
#   ./scripts/make_prod.sh /path/to/my-app
#   ./scripts/make_prod.sh /path/to/my-app my-custom-name
#
# Prerequisites:
#   - vercel CLI installed and logged in
#   - Git repo with remote configured
#   - .env.example listing required env vars
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Colors
RED='\033[0;31m'
GREEN='\033[38;5;208m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
fail()  { echo -e "${RED}[FAIL]${NC} $1"; exit 1; }

# ── Args ──────────────────────────────────────────────────────────────────────

PROJECT_ROOT="${1:?Usage: make_prod.sh <project-root> [project-name]}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"

# Derive project name from directory if not provided
PROJECT_NAME="${2:-$(basename "$PROJECT_ROOT" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')}"

echo ""
echo "============================================="
echo "  make_prod — Productionise: $PROJECT_NAME"
echo "============================================="
echo ""
echo "  Project root:  $PROJECT_ROOT"
echo "  Project name:  $PROJECT_NAME"
echo ""

# ── Detect Project Type ───────────────────────────────────────────────────────

HAS_NEXTJS=false
HAS_API=false
HAS_MONGODB=false
HAS_DOCKER=false

if [[ -f "$PROJECT_ROOT/next.config.js" ]] || [[ -f "$PROJECT_ROOT/next.config.ts" ]] || [[ -f "$PROJECT_ROOT/next.config.mjs" ]]; then
  HAS_NEXTJS=true
fi

if [[ -f "$PROJECT_ROOT/package.json" ]]; then
  if grep -qE '"express"|"fastify"|"hono"|"koa"' "$PROJECT_ROOT/package.json" 2>/dev/null; then
    HAS_API=true
  fi
fi

if [[ -f "$PROJECT_ROOT/package.json" ]]; then
  if grep -qE '"mongoose"|"mongodb"' "$PROJECT_ROOT/package.json" 2>/dev/null; then
    HAS_MONGODB=true
  fi
fi

# Also check .env.example for MONGODB_URI
if [[ -f "$PROJECT_ROOT/.env.example" ]]; then
  if grep -q "MONGODB_URI" "$PROJECT_ROOT/.env.example" 2>/dev/null; then
    HAS_MONGODB=true
  fi
fi

if [[ -f "$PROJECT_ROOT/Dockerfile" ]] || [[ -f "$PROJECT_ROOT/docker-compose.yml" ]]; then
  HAS_DOCKER=true
fi

info "Detected project type:"
echo "  Next.js frontend: $HAS_NEXTJS"
echo "  Standalone API:   $HAS_API"
echo "  MongoDB:          $HAS_MONGODB"
echo "  Docker:           $HAS_DOCKER"
echo ""

# ── Determine services needed ─────────────────────────────────────────────────

NEED_VERCEL=false
NEED_ATLAS=false
NEED_RENDER=false

if [[ "$HAS_NEXTJS" == "true" ]]; then
  NEED_VERCEL=true
fi

if [[ "$HAS_MONGODB" == "true" ]]; then
  NEED_ATLAS=true
fi

# Only need Render if standalone API (not Next.js API routes)
if [[ "$HAS_API" == "true" ]] && [[ "$HAS_NEXTJS" != "true" ]]; then
  NEED_RENDER=true
fi

info "Services to provision:"
[[ "$NEED_VERCEL" == "true" ]] && echo "  - Vercel (frontend/fullstack)"
[[ "$NEED_ATLAS" == "true" ]]  && echo "  - MongoDB Atlas (database)"
[[ "$NEED_RENDER" == "true" ]] && echo "  - Render (API)"
echo ""

# ── Check prerequisites ──────────────────────────────────────────────────────

MISSING=()

if [[ "$NEED_VERCEL" == "true" ]]; then
  if ! command -v vercel &>/dev/null; then
    MISSING+=("vercel CLI (npm i -g vercel)")
  fi
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  fail "Missing prerequisites:\n  ${MISSING[*]}"
fi

# ── Generate secrets ──────────────────────────────────────────────────────────

JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(64).toString('hex'))")
DB_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))")

# ── Vercel Setup ──────────────────────────────────────────────────────────────

if [[ "$NEED_VERCEL" == "true" ]]; then
  info "Setting up Vercel project: $PROJECT_NAME"

  cd "$PROJECT_ROOT"

  # Create .vercelignore if it doesn't exist
  if [[ ! -f ".vercelignore" ]]; then
    cat > .vercelignore << 'VERCELIGNORE'
.env
.env.local
tests/
scripts/
artifacts/
docker-compose.yml
Dockerfile
Dockerfile.dev
.dockerignore
VERCELIGNORE
    ok "Created .vercelignore"
  else
    ok ".vercelignore already exists"
  fi

  # Link to Vercel (creates project if needed)
  if [[ ! -d ".vercel" ]]; then
    info "Linking to Vercel..."
    vercel link -p "$PROJECT_NAME" --yes 2>&1 || true
  else
    ok "Already linked to Vercel"
  fi

  # Read Vercel project info
  if [[ -f ".vercel/project.json" ]]; then
    VERCEL_PROJECT_ID=$(node -e "console.log(JSON.parse(require('fs').readFileSync('.vercel/project.json','utf8')).projectId)")
    ok "Vercel project ID: $VERCEL_PROJECT_ID"
  fi

  echo ""
  info "Setting Vercel environment variables..."
  info "(Existing vars will be skipped — remove manually if you need to reset)"
  echo ""

  # Set env vars using printf (no trailing newline)
  set_vercel_env() {
    local key="$1"
    local value="$2"
    local env="${3:-production}"

    # Check if already set
    if vercel env ls 2>/dev/null | grep -q "$key.*$env"; then
      warn "$key already set for $env — skipping"
    else
      printf "%s" "$value" | vercel env add "$key" "$env" 2>&1 || warn "Failed to set $key"
      ok "Set $key for $env"
    fi
  }

  set_vercel_env "NODE_ENV" "production"
  set_vercel_env "JWT_SECRET" "$JWT_SECRET"
  set_vercel_env "JWT_EXPIRES_IN" "7d"

  if [[ "$NEED_ATLAS" == "true" ]]; then
    echo ""
    warn "MongoDB Atlas connection string needed."
    echo "  After provisioning Atlas (step below), set it with:"
    echo "  printf '<connection-string>' | vercel env add MONGODB_URI production"
    echo ""
  fi

  # Deploy
  info "Deploying to Vercel production..."
  VERCEL_URL=$(vercel --prod 2>&1 | grep -oE 'https://[a-zA-Z0-9.-]+\.vercel\.app' | tail -1)

  if [[ -n "$VERCEL_URL" ]]; then
    ok "Deployed: $VERCEL_URL"
  else
    warn "Deploy may have succeeded — check Vercel dashboard"
  fi

  cd "$REPO_DIR"
fi

# ── MongoDB Atlas ─────────────────────────────────────────────────────────────

if [[ "$NEED_ATLAS" == "true" ]]; then
  echo ""
  echo "============================================="
  echo "  MongoDB Atlas Setup"
  echo "============================================="
  echo ""

  # Check for Atlas API keys
  if [[ -n "${MONGODB_ATLAS_PUBLIC_KEY:-}" ]] && [[ -n "${MONGODB_ATLAS_PRIVATE_KEY:-}" ]] && [[ -n "${ATLAS_PROJECT_ID:-}" ]]; then
    info "Atlas API keys found — creating database user via API..."

    ATLAS_USER="${PROJECT_NAME//-/_}_user"

    RESPONSE=$(curl -s -w "\n%{http_code}" -u "$MONGODB_ATLAS_PUBLIC_KEY:$MONGODB_ATLAS_PRIVATE_KEY" \
      --digest \
      -X POST "https://cloud.mongodb.com/api/atlas/v2/groups/$ATLAS_PROJECT_ID/databaseUsers" \
      -H "Content-Type: application/json" \
      -H "Accept: application/vnd.atlas.2023-01-01+json" \
      -d "{
        \"databaseName\": \"admin\",
        \"username\": \"$ATLAS_USER\",
        \"password\": \"$DB_PASSWORD\",
        \"roles\": [{\"databaseName\": \"$PROJECT_NAME\", \"roleName\": \"readWrite\"}]
      }")

    HTTP_CODE=$(echo "$RESPONSE" | tail -1)
    BODY=$(echo "$RESPONSE" | head -n -1)

    if [[ "$HTTP_CODE" == "201" ]]; then
      ok "Created Atlas user: $ATLAS_USER"

      # Get cluster hostname from existing env or default
      ATLAS_CLUSTER="${ATLAS_CLUSTER_HOST:-cluster0.example.mongodb.net}"
      ATLAS_URI="mongodb+srv://${ATLAS_USER}:${DB_PASSWORD}@${ATLAS_CLUSTER}/${PROJECT_NAME}?retryWrites=true&w=majority"

      ok "Connection string generated"

      # Set on Vercel if we have a project
      if [[ "$NEED_VERCEL" == "true" ]]; then
        cd "$PROJECT_ROOT"
        printf "%s" "$ATLAS_URI" | vercel env add MONGODB_URI production 2>&1 || warn "Failed to set MONGODB_URI on Vercel"
        ok "Set MONGODB_URI on Vercel"
        cd "$REPO_DIR"
      fi
    else
      warn "Atlas API returned HTTP $HTTP_CODE"
      echo "$BODY" | head -5
      echo ""
    fi
  else
    warn "No Atlas API keys found. Manual setup required:"
    echo ""
    echo "  1. Go to MongoDB Atlas → Database Access → Add New Database User"
    echo "     Username: ${PROJECT_NAME//-/_}_user"
    echo "     Password: $DB_PASSWORD"
    echo "     Role: readWrite on database '$PROJECT_NAME'"
    echo ""
    echo "  2. Build connection string:"
    echo "     mongodb+srv://${PROJECT_NAME//-/_}_user:${DB_PASSWORD}@<cluster>.mongodb.net/${PROJECT_NAME}?retryWrites=true&w=majority"
    echo ""
    echo "  3. Set on Vercel:"
    echo "     printf '<connection-string>' | vercel env add MONGODB_URI production"
    echo ""
    echo "  To enable API automation, set these env vars:"
    echo "     MONGODB_ATLAS_PUBLIC_KEY=<your-public-key>"
    echo "     MONGODB_ATLAS_PRIVATE_KEY=<your-private-key>"
    echo "     ATLAS_PROJECT_ID=<your-atlas-project-id>"
    echo ""
  fi
fi

# ── Render Setup ──────────────────────────────────────────────────────────────

if [[ "$NEED_RENDER" == "true" ]]; then
  echo ""
  echo "============================================="
  echo "  Render Setup"
  echo "============================================="
  echo ""

  # Create render.yaml if it doesn't exist
  if [[ ! -f "$PROJECT_ROOT/render.yaml" ]]; then
    cat > "$PROJECT_ROOT/render.yaml" << RENDERYAML
services:
  - type: web
    name: ${PROJECT_NAME}-api
    runtime: node
    region: oregon
    plan: starter
    buildCommand: npm ci && npm run build
    startCommand: npm start
    healthCheckPath: /api/health
    autoDeploy: true
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "10000"
      - key: MONGODB_URI
        sync: false
      - key: JWT_SECRET
        sync: false
      - key: ALLOWED_ORIGINS
        sync: false
RENDERYAML
    ok "Created render.yaml"
  else
    ok "render.yaml already exists"
  fi

  # Check for Render API key
  if [[ -n "${RENDER_API_KEY:-}" ]]; then
    info "Render API key found — creating service via API..."

    # Get git remote URL
    GIT_REMOTE=$(cd "$PROJECT_ROOT" && git config --get remote.origin.url 2>/dev/null || echo "")

    if [[ -n "$GIT_REMOTE" ]]; then
      # Convert SSH to HTTPS for Render
      HTTPS_REMOTE=$(echo "$GIT_REMOTE" | sed 's|git@github.com:|https://github.com/|' | sed 's|\.git$||')

      RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "https://api.render.com/v1/services" \
        -H "Authorization: Bearer $RENDER_API_KEY" \
        -H "Content-Type: application/json" \
        -d "{
          \"type\": \"web_service\",
          \"name\": \"${PROJECT_NAME}-api\",
          \"repo\": \"$HTTPS_REMOTE\",
          \"branch\": \"main\",
          \"runtime\": \"node\",
          \"region\": \"oregon\",
          \"plan\": \"starter\",
          \"buildCommand\": \"npm ci && npm run build\",
          \"startCommand\": \"npm start\",
          \"healthCheckPath\": \"/api/health\",
          \"envVars\": [
            {\"key\": \"NODE_ENV\", \"value\": \"production\"},
            {\"key\": \"PORT\", \"value\": \"10000\"},
            {\"key\": \"JWT_SECRET\", \"value\": \"$JWT_SECRET\"},
            {\"key\": \"MONGODB_URI\", \"value\": \"SET_ME\"}
          ]
        }")

      HTTP_CODE=$(echo "$RESPONSE" | tail -1)
      if [[ "$HTTP_CODE" == "201" ]]; then
        SERVICE_ID=$(echo "$RESPONSE" | head -n -1 | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).service.id))" 2>/dev/null || echo "unknown")
        ok "Created Render service: ${PROJECT_NAME}-api (ID: $SERVICE_ID)"
      else
        warn "Render API returned HTTP $HTTP_CODE"
      fi
    else
      warn "No git remote found — cannot create Render service via API"
    fi
  else
    warn "No Render API key found. Manual setup required:"
    echo ""
    echo "  1. Go to render.com → New → Web Service"
    echo "  2. Connect your GitHub repo"
    echo "  3. Name: ${PROJECT_NAME}-api"
    echo "  4. Runtime: Node, Plan: Starter"
    echo "  5. Build: npm ci && npm run build"
    echo "  6. Start: npm start"
    echo "  7. Add env vars: MONGODB_URI, JWT_SECRET, NODE_ENV=production"
    echo "  8. Health check: /api/health"
    echo ""
    echo "  To enable API automation, set: RENDER_API_KEY=<your-api-key>"
    echo ""
  fi
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "============================================="
echo "  Production Setup Summary"
echo "============================================="
echo ""
echo "  Project:      $PROJECT_NAME"
echo "  JWT Secret:   ${JWT_SECRET:0:12}... (${#JWT_SECRET} chars)"
echo "  DB Password:  ${DB_PASSWORD:0:8}... (${#DB_PASSWORD} chars)"
echo ""

[[ "$NEED_VERCEL" == "true" ]] && echo "  Vercel:       ${VERCEL_URL:-check dashboard}"
[[ "$NEED_ATLAS" == "true" ]]  && echo "  Atlas DB:     $PROJECT_NAME"
[[ "$NEED_RENDER" == "true" ]] && echo "  Render:       ${PROJECT_NAME}-api"

echo ""
echo "  Secrets generated — save them securely."
echo "  Run health check: curl <production-url>/api/health"
echo ""
echo "============================================="
